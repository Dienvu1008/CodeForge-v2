// CompletionGate — VERIFICATION_PROTOCOL §10, P1.5-VR2.
//
// THE northstar enforcement point for TI-005:
//   VERIFYING → PASSED only when there is a valid + fresh PASS report
//   with scope ≥ requiredScope. No shortcut.
//
// Enforces:
//   TI-005: task PASSED only with valid verification evidence.
//   VR-002: stale evidence cannot complete task.
//   VR-004: scope ≥ required (per task / final-graph policy).
//
// Adversarial guard: a report with 0 checks is never usable for completion
// even if status=PASS (MaliciousVerifier scenario — VERIFICATION_PROTOCOL §19).
import { SCOPE_LATTICE, type VerificationScope } from '../domain/verification.js';
import type { VerificationReport } from '../domain/verification.js';
import type { WorkspaceRevision } from '../domain/workspace-revision.js';
import type { VerificationRepository } from '../repositories/index.js';
import { isFresh } from '../domain/workspace-revision.js';
import { scopeIncludes } from './scope-computer.js';
import type { CompletionCheck } from './verification-engine.js';

export { SCOPE_LATTICE };

// ── CompletionGateError ───────────────────────────────────────────────────────

export class CompletionGateError extends Error {
  public readonly code:
    | 'NO_VERIFICATION_REPORT'  // TI-005: no report exists at all
    | 'STALE_EVIDENCE'          // VR-002: revision drifted since report was made
    | 'VERIFICATION_NOT_PASSED' // status is not PASS (FAIL / INVALID / ERROR)
    | 'NO_CHECKS_EXECUTED'      // adversarial guard: 0 checks → never PASS
    | 'SCOPE_INSUFFICIENT';     // VR-004: report.scope < requiredScope

  constructor(code: CompletionGateError['code'], message?: string) {
    super(message ?? code);
    this.name = 'CompletionGateError';
    this.code = code;
  }
}

// ── CompletionGateDeps ────────────────────────────────────────────────────────

export interface CompletionGateDeps {
  readonly reports: VerificationRepository;
}

// ── CompletionGate ────────────────────────────────────────────────────────────

export class CompletionGate {
  constructor(private readonly deps: CompletionGateDeps) {}

  /**
   * Check whether a task can transition VERIFYING → PASSED.
   *
   * TI-005: this is the ONLY path to PASSED (besides HUMAN_OVERRIDE_PASSED).
   * Returns a CompletionCheck — callers use { canComplete: true } to populate
   * TaskTransitionContext.reportValid = true and ctx.fresh = true, then call
   * transitionTask(state, 'VERIFICATION_PASSED', ctx).
   */
  async canComplete(
    taskId: string,
    currentRevision: WorkspaceRevision,
    requiredScope: VerificationScope = 'AFFECTED_DIRECT',
  ): Promise<CompletionCheck> {
    // Fetch the most recent report for this task.
    const allReports = await this.deps.reports.getByTask(taskId);
    // Pick the latest PASS report that is fresh — ordered by latest endedAt.
    const freshPass = this.findBestReport(allReports, currentRevision);

    if (freshPass === null) {
      // Check why — distinguish between "no report at all" and "exists but stale/failed".
      if (allReports.length === 0) {
        return {
          canComplete: false,
          reason: 'NO_VERIFICATION_REPORT',
          requiredScope,
        };
      }
      // Reports exist but none qualify — stale or wrong status.
      const latest = allReports[allReports.length - 1]!;
      if (!isFresh(latest.targetWorkspaceRevision, currentRevision)) {
        return { canComplete: false, reason: 'STALE_EVIDENCE', requiredScope };
      }
      if (latest.status !== 'PASS') {
        return { canComplete: false, reason: 'VERIFICATION_NOT_PASSED', requiredScope };
      }
      if (latest.checks.length === 0) {
        return { canComplete: false, reason: 'NO_CHECKS_EXECUTED', requiredScope };
      }
      return { canComplete: false, reason: 'STALE_EVIDENCE', requiredScope };
    }

    // Adversarial guard: 0 checks → never PASS (VERIFICATION_PROTOCOL §19).
    if (freshPass.checks.length === 0) {
      return {
        canComplete: false,
        reason: 'NO_CHECKS_EXECUTED',
        requiredScope,
        report: freshPass,
      };
    }

    // VR-004: scope must be ≥ required.
    if (!scopeIncludes(freshPass.scope, requiredScope)) {
      return {
        canComplete: false,
        reason: 'SCOPE_INSUFFICIENT',
        requiredScope,
        report: freshPass,
      };
    }

    return { canComplete: true, requiredScope, report: freshPass };
  }

  /**
   * Strict variant: throws CompletionGateError instead of returning {canComplete:false}.
   * Useful when callers want to fail fast.
   */
  async assertCanComplete(
    taskId: string,
    currentRevision: WorkspaceRevision,
    requiredScope: VerificationScope = 'AFFECTED_DIRECT',
  ): Promise<VerificationReport> {
    const check = await this.canComplete(taskId, currentRevision, requiredScope);
    if (!check.canComplete) {
      throw new CompletionGateError(
        check.reason as CompletionGateError['code'],
        `task ${taskId} cannot complete: ${check.reason ?? 'unknown'}`,
      );
    }
    return check.report!;
  }

  // ── internals ──────────────────────────────────────────────────────────────

  /**
   * Find the best (most recent) report that is fresh AND has status PASS.
   * Reports are already sorted by `started_at ASC` by the repository; we scan
   * in reverse to find the latest qualifying one.
   */
  private findBestReport(
    reports: readonly VerificationReport[],
    currentRevision: WorkspaceRevision,
  ): VerificationReport | null {
    for (let i = reports.length - 1; i >= 0; i--) {
      const r = reports[i]!;
      if (r.status === 'PASS' && isFresh(r.targetWorkspaceRevision, currentRevision)) {
        return r;
      }
    }
    return null;
  }
}
