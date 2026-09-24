// VerificationEngine — VERIFICATION_PROTOCOL §6, P1.5-VR1.
//
// Orchestrates the full verification pipeline:
//   R_before → policy → scope → affected → checks → R_after → validate → report → commit
//
// Enforces:
//   VR-001: every report bound to a WorkspaceRevision.
//   VR-006: reports are append-only (delegated to VerificationRepository).
//   VR-007: R_before captured BEFORE checks run.
//   VR-008: R_after compared; non-scratch mutation → INVALID.
//   VR-009: toolVersions + invariantsChecked recorded.
//   VR-010: scope is deterministic (via ScopeComputer).
//   VR-011: PASS(A) ≠ PASS(B) when revision A ≠ B — report binds to exactly one revision.
//
// Phase 1.5: checks run via ProcessSupervisor (no shell:true, SE-007 timeout enforced).
// ArtifactStore: in-memory stub (Phase 3 will add disk store).
import type {
  VerificationReport,
  VerificationCheck,
  VerificationScope,
  VerificationStatus,
  InvariantCheck,
} from '../domain/verification.js';
import type { WorkspaceRevision } from '../domain/workspace-revision.js';
import { isFresh } from '../domain/workspace-revision.js';
import type { VerificationRepository } from '../repositories/index.js';
import type { ProcessSupervisor } from '../process/process-supervisor.js';
import type { DomainEvent, EventType } from '../domain/event.js';
import type { EventLog } from '../repositories/index.js';
import type { VerificationPolicy, CheckDefinition } from './verification-policy.js';
import { computeScope, scopeIncludes } from './scope-computer.js';
import { computeAffectedDirect } from './affected-set.js';

// ── VerificationError ─────────────────────────────────────────────────────────

export class VerificationError extends Error {
  public readonly code:
    | 'NOT_FOUND'
    | 'REVISION_MISMATCH'   // VR-001: report not bound to requested revision
    | 'SCRATCH_VIOLATION'   // VR-003/VR-008: mutation outside scratch zone
    | 'CHECK_TIMEOUT'       // individual check timed out (TG-010 / SE-007)
    | 'CHECK_ERROR'         // infrastructure error during check
    | 'STALE_EVIDENCE'      // VR-002: report stale at completion gate
    | 'SCOPE_INSUFFICIENT'  // VR-004: report scope < required scope
    | 'POLICY_VIOLATION';

  constructor(code: VerificationError['code'], message?: string) {
    super(message ?? code);
    this.name = 'VerificationError';
    this.code = code;
  }
}

// ── VerifyRequest ─────────────────────────────────────────────────────────────

export interface VerifyRequest {
  readonly sessionId: string;
  readonly taskId: string;
  readonly taskRunId: string;
  /**
   * The workspace revision at the time verification runs (R_before).
   * Must be captured BEFORE calling verify() (VR-007).
   * Callers (e.g. the execution loop) compute this via infrastructure's
   * computeWorkspaceRevision before invoking the engine.
   */
  readonly targetRevision: WorkspaceRevision;
  readonly policy: VerificationPolicy;
  readonly reason: 'task_completion' | 'graph_final' | 'reverify' | 'user_request';
}

// ── CompletionCheck ───────────────────────────────────────────────────────────

export interface CompletionCheck {
  readonly canComplete: boolean;
  readonly reason?: string;
  readonly requiredScope: VerificationScope;
  readonly report?: VerificationReport;
}

// ── RevisionProvider ──────────────────────────────────────────────────────────

/**
 * Contract for capturing a WorkspaceRevision at runtime.
 * Infrastructure implements this via computeWorkspaceRevision.
 * FakeRevisionProvider is in testing/.
 */
export interface RevisionProvider {
  capture(reason: WorkspaceRevision['createdBy']['reason']): Promise<WorkspaceRevision>;
}

// ── VerificationEngineDeps ────────────────────────────────────────────────────

export interface VerificationEngineDeps {
  readonly reports: VerificationRepository;
  readonly events: EventLog;
  readonly supervisor: ProcessSupervisor;
  readonly revisionProvider: RevisionProvider;
  readonly now: () => string;
  readonly nextId: () => string;
  readonly schemaVersion?: number;
  readonly canonicalFormVersion?: string;
}

// ── VerificationEngine ────────────────────────────────────────────────────────

export class VerificationEngine {
  private readonly schemaVersion: number;
  private readonly canonicalFormVersion: string;

  constructor(private readonly deps: VerificationEngineDeps) {
    this.schemaVersion = deps.schemaVersion ?? 1;
    this.canonicalFormVersion = deps.canonicalFormVersion ?? 'v1';
  }

  /**
   * Run the verification pipeline (§6.1):
   *   1. Compute scope + affected set.
   *   2. Capture R_before (already supplied by caller as targetRevision — VR-007).
   *   3. Execute checks via ProcessSupervisor.
   *   4. Capture R_after.
   *   5. Validate non-scratch mutation (VR-008 → INVALID if drifted).
   *   6. Build + commit VerificationReport (VR-006 append-only).
   */
  async verify(request: VerifyRequest): Promise<VerificationReport> {
    const startedAt = this.deps.now();
    await this.emit(request.sessionId, 'VERIFICATION_STARTED', {
      taskId: request.taskId,
      taskRunId: request.taskRunId,
      startedAt,
    });

    // Compute scope from policy (deterministic, VR-010).
    const isFinalGraph = request.reason === 'graph_final';
    const scope = computeScope({
      policy: request.policy,
      affectedClosureSize: 0, // Phase 1.5: no closure data → conservative
      totalTestablePaths: 1,  // avoid divide-by-zero
      isFinalGraph,
    });

    // R_before is the caller-supplied targetRevision (VR-007: captured before checks).
    const rBefore = request.targetRevision;

    // Execute checks filtered by scope.
    const checks = await this.runChecks(
      request.policy.checks,
      scope,
      request.policy.failFast,
    );

    // Capture R_after to detect non-scratch mutations (VR-008).
    const rAfter = await this.deps.revisionProvider.capture('post_verify');

    // Determine status: INVALID if non-scratch drift, FAIL if any check failed, else PASS.
    let status: VerificationStatus;
    if (!isFresh(rBefore, rAfter)) {
      // Workspace changed during verification outside scratch zones → INVALID (VR-008).
      status = 'INVALID';
    } else if (checks.some((c) => c.status === 'FAIL' || c.status === 'ERROR')) {
      status = 'FAIL';
    } else {
      status = 'PASS';
    }

    const endedAt = this.deps.now();
    const invariants = this.buildInvariantChecks(status, rBefore, scope, request.policy);

    const report: VerificationReport = {
      verificationId: this.deps.nextId(),
      sessionId: request.sessionId,
      taskId: request.taskId,
      taskRunId: request.taskRunId,
      targetWorkspaceRevision: rBefore, // VR-001: bound to R_before
      canonicalFormVersion: this.canonicalFormVersion,
      scope,
      checks,
      status,
      startedAt,
      endedAt,
      toolVersions: { ...request.policy.toolVersions },
      artifacts: [],
      invariantsChecked: invariants,
      schemaVersion: this.schemaVersion,
    };

    // VR-006: append-only commit.
    await this.deps.reports.create(report);

    await this.emit(request.sessionId, 'VERIFICATION_ENDED', {
      verificationId: report.verificationId,
      taskId: request.taskId,
      status,
      scope,
    });

    return report;
  }

  async getReport(verificationId: string): Promise<VerificationReport | null> {
    return this.deps.reports.getById(verificationId);
  }

  async listReports(taskId: string): Promise<readonly VerificationReport[]> {
    return this.deps.reports.getByTask(taskId);
  }

  /** isFresh wrapper for callers that hold the engine reference. */
  isFresh(
    report: VerificationReport,
    current: WorkspaceRevision,
  ): boolean {
    return isFresh(report.targetWorkspaceRevision, current);
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private async runChecks(
    checkDefs: readonly CheckDefinition[],
    scope: VerificationScope,
    failFast: boolean,
  ): Promise<readonly VerificationCheck[]> {
    const results: VerificationCheck[] = [];

    for (const def of checkDefs) {
      // Skip checks whose minimum scope exceeds the current scope.
      if (!scopeIncludes(scope, def.minScope)) {
        results.push(this.skipCheck(def, scope));
        continue;
      }

      const checkId = this.deps.nextId();
      const t0 = Date.now();

      try {
        const spawn = await this.deps.supervisor.spawn({
          command: def.command,
          args: [...def.args],
          cwd: '/', // caller-scoped; ProcessSupervisor validates cwd
          env: {},  // EnvGuard filtering is caller's responsibility
          timeoutMs: def.timeoutMs,
        });

        const durationMs = Date.now() - t0;
        let checkStatus: VerificationCheck['status'];
        if (spawn.timedOut) {
          checkStatus = 'ERROR'; // TG-010: timeout is an error at check level
        } else {
          checkStatus = spawn.exitCode === 0 ? 'PASS' : 'FAIL';
        }

        results.push({
          checkId,
          kind: def.kind,
          name: def.name,
          command: def.command,
          args: def.args,
          scope,
          exitCode: spawn.exitCode ?? -1,
          durationMs,
          status: checkStatus,
          executedBy: 'deterministic',
        });

        if (failFast && checkStatus !== 'PASS') break;
      } catch {
        const durationMs = Date.now() - t0;
        results.push({
          checkId,
          kind: def.kind,
          name: def.name,
          command: def.command,
          args: def.args,
          scope,
          exitCode: -1,
          durationMs,
          status: 'ERROR',
          executedBy: 'deterministic',
        });
        if (failFast) break;
      }
    }

    return results;
  }

  private skipCheck(def: CheckDefinition, _scope: VerificationScope): VerificationCheck {
    return {
      checkId: this.deps.nextId(),
      kind: def.kind,
      name: def.name,
      command: def.command,
      args: def.args,
      scope: def.minScope,
      exitCode: 0,
      durationMs: 0,
      status: 'SKIP',
      executedBy: 'deterministic',
    };
  }

  private buildInvariantChecks(
    status: VerificationStatus,
    revision: WorkspaceRevision,
    scope: VerificationScope,
    _policy: VerificationPolicy,
  ): readonly InvariantCheck[] {
    return [
      {
        invariantId: 'VR-001',
        satisfied: revision.revisionId.length > 0,
        evidence: `targetRevisionId=${revision.revisionId}`,
      },
      {
        invariantId: 'VR-006',
        satisfied: true,
        evidence: 'append-only — enforced by VerificationRepository',
      },
      {
        invariantId: 'VR-010',
        satisfied: true,
        evidence: `scope=${scope} computed deterministically`,
      },
      {
        invariantId: 'VR-011',
        satisfied: status !== 'PASS' || revision.revisionId.length > 0,
        evidence: `PASS binds to revisionId=${revision.revisionId}`,
      },
    ];
  }

  private async emit(sessionId: string, type: EventType, payload: unknown): Promise<void> {
    const event: DomainEvent = {
      eventId: this.deps.nextId(),
      sessionId,
      type,
      aggregate: { kind: 'verification', id: sessionId },
      payload,
      at: this.deps.now(),
      sequenceNumber: 0,
    };
    await this.deps.events.append(event);
  }
}

// ── computeAffectedDirect re-export for convenience ───────────────────────────
export { computeAffectedDirect };
