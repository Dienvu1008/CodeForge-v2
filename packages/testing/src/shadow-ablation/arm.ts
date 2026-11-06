/*
 * Copyright 2026 DienVu (Dienvu1008)
 * SPDX-License-Identifier: Apache-2.0
 */

// Arm runner (kernel-shadow-ablation, design C12). Measurement-only (SA-001).
//
// `runArm` replays ONE Model_Trace through the REAL Kernel in one mode (enforce | shadow). The
// wiring mirrors `makeRealAgentRunner` of `scripts/run-progressive.mjs` line for line — SQLite
// `:memory:` + migrations, the same `counters()` clock/id scheme, SessionService, Planner,
// GraphCommitService, ExecutionCoordinator, TaskRunService, CheckpointService, ContextBuilder,
// ContextCollector on the sandbox, TaskExecutor with `maxToolCalls` from the trace, the recovery
// stack per `wiring.recovery`, SessionOrchestrator `maxIterations: 10`, the same seeded session,
// graph and goal — with ONLY these substitutions:
//
//   model gateway     → ReplayModelGateway(trace, injections, { onStep: ledger })
//                       (`ArmConfig.modelGateway` replaces it ONLY to record synthetic traces)
//   ToolGateway       → AblationToolGateway (enforced policy = buildToolPolicy(trace.wiring.autonomy))
//   WorkspaceManager  → AblationWorkspaceManager(NodeWorkspaceManager on sandbox.root; the shadow arm
//                       passes OPEN_PATH_ACCESS_POLICY to the inner manager, the oracle decides)
//   ToolExecutor      → AblationToolExecutor(NodeToolExecutor with innerShellPolicyFor(mode))
//   ProcessSupervisor → caller-provided (`supervisorFactory`): FakeProcessSupervisor in Phase 1,
//                       ContainedProcessSupervisor in Phase 2. The arm never spawns a process itself.
//   VerificationEngine / CompletionGate → AblationVerificationEngine / AblationCompletionGate
//   approval          → shadow: ShadowApprovalCoordinator; enforce: none ('none', the
//                       Progressive_Runner wiring) or DenyAllApprovalCoordinator ('deny')
//
// Two PASSIVE observers complete the instrument; neither changes a decision or a value:
//   - the TaskExecutor's progress sink is the arm's event log behind a forwarding wrapper that
//     records Observed_Guards from `DECISION_COMPLETED` (P12.11 `done_rejected_no_change`, P12.13
//     `done_rejected_missing_paths`) at the current ledger step (Requirement 4.4);
//   - the TaskExecutor is a subclass whose `execute` returns `super.execute` unchanged and only
//     reads its result: the run final state, and `pendingApprovalToolCallId`, which is the enforce
//     arm's EP-APPROVAL block under `approvalResolution: 'none'` (design C7).
// The idempotency duplicate skip is an Observed_Guard only when an IdempotencyEngine is wired; the
// Progressive_Runner wires none, so it is reported inactive (as is EP-SCHEMA: no schemas wired).
//
// Not replayed: the LSP pool (`wiring.lsp`) would spawn language servers, so it is never wired;
// the arm reports `lsp-not-wired` and any context difference surfaces as Prompt_Drift only.
// Traces with `concurrent: true` or `interaction !== 'off'` are refused (`assertReplayable`,
// Requirement 3.7), so the mission stage is never wired.
//
// Deterministic: no wall clock reaches the result (counters for every clock/id the Kernel sees;
// `durationMs` values are not copied), map keys are sorted, the sandbox is destroyed in `finally`.
import {
  CheckpointService,
  ContextBuilder,
  DEFAULT_RECOVERY_POLICY,
  DEFAULT_SHELL_POLICY,
  ExecutionCoordinator,
  FailureAnalyzer,
  GraphCommitService,
  GraphService,
  NoopProcessReconciler,
  OPEN_PATH_ACCESS_POLICY,
  Planner,
  RecoveryEngine,
  SessionOrchestrator,
  SessionService,
  TaskExecutor,
  TaskRunService,
  applyAblations,
  buildToolPolicy,
  buildVerificationPolicy,
  type AblationName,
  type ApprovalCoordinator,
  type BenchmarkCheck,
  type Goal,
  type ModelGateway,
  type ProcessSupervisor,
  type ProgressEventSink,
  type RecoveryPolicyConfig,
  type SessionOrchestratorResult,
  type TaskExecutorDeps,
  type TaskExecutorRequest,
  type TaskExecutorResult,
  type ToolGateway,
  type WorkspaceRevision,
} from '@codeforge/agent-core';
import {
  BenchmarkCheckRunner,
  Blake3GraphHasher,
  ContextCollector,
  NodeToolExecutor,
  NodeWorkspaceManager,
  SqliteApprovalRepository,
  SqliteCheckpointRepository,
  SqliteDatabaseAdapter,
  SqliteEventLog,
  SqliteFailureRepository,
  SqliteGraphCommitter,
  SqliteRecoveryActionRepository,
  SqliteSessionRepository,
  SqliteTaskExecutionRepository,
  SqliteTaskGraphRepository,
  SqliteTaskRepository,
  SqliteTaskRunRepository,
  SqliteToolCallRepository,
  SqliteVerificationRepository,
  SqliteWorkspaceLockService,
  WorkspaceSnapshotRollback,
  WorkspaceTestBaseline,
  computeWorkspaceHash,
  createMigrationRegistry,
  hashFileContent,
  inspectProject,
  redact,
  runMigrations,
  walkWorkspace,
} from '@codeforge/infrastructure';
import { DenyAllApprovalCoordinator, ShadowApprovalCoordinator } from './ablation-approval.js';
import { AblationToolExecutor, innerShellPolicyFor } from './ablation-tool-executor.js';
import {
  AblationToolGateway,
  approvalBlockReason,
  type ApprovalResolution,
  type ArmMode,
} from './ablation-tool-gateway.js';
import { AblationCompletionGate, AblationVerificationEngine } from './ablation-verification.js';
import { AblationWorkspaceManager } from './ablation-workspace.js';
import {
  ARGS_PREVIEW_MAX,
  DecisionLedger,
  type EnforcementPointId,
  type GuardEvent,
  type LedgerSnapshot,
} from './decision-ledger.js';
import { ReplayModelGateway, type InjectionAt, type ReplayStatus } from './replay-model-gateway.js';
import { createSandbox, destroySandbox, type Sandbox } from './sandbox.js';
import type { ModelTraceV1 } from './trace-format.js';

// ── Replayability (Requirement 3.7) ─────────────────────────────────────────────────────────

export type ReplayRefusalReason = 'concurrent' | 'interaction';

export interface ReplayRefusal {
  readonly traceId: string;
  readonly reason: ReplayRefusalReason;
  readonly message: string;
}

/** Thrown by {@link assertReplayable} / {@link runArm} for a trace the harness must not replay. */
export class ReplayRefusedError extends Error {
  constructor(readonly refusal: ReplayRefusal) {
    super(refusal.message);
    this.name = 'ReplayRefusedError';
  }
}

/** The refusal for `trace`, or `undefined` when it can be replayed. Pure. */
export function replayRefusal(trace: ModelTraceV1): ReplayRefusal | undefined {
  if (trace.concurrent) {
    return {
      traceId: trace.traceId,
      reason: 'concurrent',
      message: `trace ${trace.traceId} was recorded with overlapping model calls (concurrent: true); its serving order is not reproducible`,
    };
  }
  if (trace.wiring.interaction !== 'off') {
    return {
      traceId: trace.traceId,
      reason: 'interaction',
      message: `trace ${trace.traceId} was recorded with interaction '${trace.wiring.interaction}'; only interaction 'off' traces are replayed`,
    };
  }
  return undefined;
}

/** Throw {@link ReplayRefusedError} unless `trace` is replayable (not concurrent, interaction 'off'). */
export function assertReplayable(trace: ModelTraceV1): void {
  const refusal = replayRefusal(trace);
  if (refusal !== undefined) throw new ReplayRefusedError(refusal);
}

// ── Config / result ─────────────────────────────────────────────────────────────────────────

/** The arm's subprocess containment (design C9). Built by the caller per sandbox. */
export interface ArmSupervisors {
  /** NodeToolExecutor shell + git supervisor. */
  readonly shell: ProcessSupervisor;
  /** VerificationEngine supervisor. */
  readonly verification: ProcessSupervisor;
  /** BenchmarkCheckRunner supervisor (post-run verdict). Default: `verification`. */
  readonly checks?: ProcessSupervisor;
  /**
   * Source of the red check output fed to recovery (`verificationEvidenceProvider`). Default: the
   * verification supervisor's own `lastFailureOutput()` when it has one (WorkspaceProcessSupervisor
   * does), else `''`.
   */
  readonly evidence?: { lastFailureOutput(): string };
}

/** Phase 1: returns FakeProcessSupervisors; Phase 2: ContainedProcessSupervisors on `sandbox`. */
export type ArmSupervisorFactory = (sandbox: Sandbox, ledger: DecisionLedger) => ArmSupervisors;

/**
 * The arm's model gateway: a ModelGateway that also reports a {@link ReplayStatus} and advances
 * the ledger step before each execute-purpose response (ReplayModelGateway is one).
 */
export type ArmModelGateway = ModelGateway & { status(): ReplayStatus };

/** Builds the arm's model gateway for the arm's ledger. */
export type ArmModelGatewayFactory = (ledger: DecisionLedger) => ArmModelGateway;

export interface ArmConfig {
  readonly mode: ArmMode;
  readonly trace: ModelTraceV1;
  /** `'uninjected'` or the corpus id of the plan (InjectionPlan.planId). Default `'uninjected'`. */
  readonly planId?: string;
  /** InjectionPlan.injections. Default none. */
  readonly injections?: readonly InjectionAt[];
  readonly seedFiles: Readonly<Record<string, string>>;
  /** Benchmark case description (or synthetic script goal) — the goal and the seeded task text. */
  readonly goalDescription: string;
  /**
   * Mandatory acceptance criterion text. The Progressive_Runner uses the description for
   * interaction cases (`simulatedUser` present) and `'done'` otherwise. Default `'done'`.
   */
  readonly acceptance?: string;
  readonly supervisorFactory: ArmSupervisorFactory;
  /** Enforce-arm model of the absent human. Default `'none'` (matches the Progressive_Runner). */
  readonly approvalResolution?: ApprovalResolution;
  /**
   * Environment whose EnvGuard-filtered variable NAMES are recorded for EP-ENV. Must be what the
   * inner ShellExecutor filters (`process.env`, the default) for the names to describe the spawn.
   */
  readonly envSource?: Readonly<Record<string, string | undefined>>;
  /** Optional post-run benchmark verdict (the case's `verification` checks). */
  readonly benchmarkChecks?: readonly BenchmarkCheck[];
  /** Default per-check timeout for the benchmark checks (the case's `timeoutMs`). */
  readonly checkTimeoutMs?: number;
  /**
   * SYNTHETIC TRACE RECORDING ONLY (`synthetic-traces.ts`): replaces the ReplayModelGateway with a
   * caller-built gateway (a RecordingModelGateway around a scripted FakeModel), so a synthetic
   * trace is recorded through exactly the wiring that later replays it. `trace` then only supplies
   * the header (wiring, model identity, traceId); its entries are not served and `injections` is
   * ignored. Never set for a replay arm.
   */
  readonly modelGateway?: ArmModelGatewayFactory;
}

export type InactivePoint = EnforcementPointId | 'IDEMPOTENCY';

export interface ArmCheckOutcome {
  readonly description: string;
  readonly passed: boolean;
}

export interface ArmCompletion {
  /** SessionOrchestrator result state, or `'HARNESS_ERROR'` when the orchestrator threw. */
  readonly sessionState: SessionOrchestratorResult['sessionState'] | 'HARNESS_ERROR';
  /** TaskExecutor final state of every task run, in execution order. */
  readonly runFinalStates: readonly TaskExecutorResult['finalState'][];
  /** `done` proposals the model made (DECISION_COMPLETED `decision: 'done'`). */
  readonly doneProposed: number;
  /** A `done` ended a run as SUCCEEDED (not challenged by an Observed_Guard). */
  readonly doneAccepted: boolean;
  /**
   * What stopped a `done` IN THIS ARM, sorted, unique: `P12.11`, `P12.13`, `EP-VERIFY:<status>`,
   * `EP-COMPLETION:<reason>` (shadow `wouldBlock` entries are not included: they did not stop it).
   */
  readonly doneRejectedBy: readonly string[];
  /** Status of the last PERSISTED VerificationReport (the real one, in both modes). */
  readonly verificationStatus?: string;
  /** Every task of the session passed (orchestrator `passedTaskIds` non-empty, none non-passed). */
  readonly taskPassed: boolean;
  /** `'SUCCESS'` iff every benchmark check passed (only when `benchmarkChecks` was given). */
  readonly benchmarkVerdict?: 'SUCCESS' | 'FAILURE';
  readonly benchmarkChecks?: readonly ArmCheckOutcome[];
}

export interface ArmHarnessError {
  readonly code: 'HARNESS_ERROR';
  /** Redacted, truncated to ARGS_PREVIEW_MAX characters. */
  readonly message: string;
}

export interface ArmResult {
  readonly mode: ArmMode;
  readonly planId: string;
  readonly traceId: string;
  readonly ledger: LedgerSnapshot;
  readonly replay: ReplayStatus;
  readonly completion: ArmCompletion;
  readonly workspace: {
    /** Canonical workspace hash (computeWorkspaceHash, blake3) of the sandbox at the end. */
    readonly hash: string;
    /** Sandbox-relative path → SHA-256 of the content (symlinks: `symlink:<target>`), sorted keys. */
    readonly files: Readonly<Record<string, string>>;
  };
  /** Observed_Guard firings (same array as `ledger.guards`). */
  readonly guards: readonly GuardEvent[];
  /** Enforcement points / guards not active under this wiring, sorted. */
  readonly inactive: readonly InactivePoint[];
  /** Wiring notes, sorted (e.g. `lsp-not-wired`). */
  readonly notes: readonly string[];
  readonly harnessError?: ArmHarnessError;
}

export class ArmConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArmConfigError';
  }
}

// ── Wiring helpers (mirrors of scripts/run-progressive.mjs) ─────────────────────────────────

/** Same scheme as `counters()` in the Progressive_Runner. */
function counters(): { now: () => string; nextId: () => string } {
  let t = 0;
  let n = 0;
  return {
    now: () => '2026-01-01T00:00:' + String(t++ % 60).padStart(2, '0') + '.000Z',
    nextId: () => 'ID-' + String(n++).padStart(5, '0'),
  };
}

/** Same as `revision(root)` in the Progressive_Runner. */
function revision(root: string): WorkspaceRevision {
  return {
    revisionId: 'rev', canonicalFormVersion: 'v1', root, includedPaths: [], excludedScratchPaths: [],
    hashAlgorithm: 'blake3', hash: 'H', fileCount: 0, totalBytes: 0,
    createdAt: '2026-01-01T00:00:00.000Z', createdBy: { sessionId: 'S', reason: 'session_start' },
  };
}

const POLICY_ABLATIONS: ReadonlySet<string> = new Set<AblationName>(['no-replan', 'no-rollback', 'no-fix', 'no-retry']);

type RecoveryPlan = { readonly kind: 'none' } | { readonly kind: 'full'; readonly policy?: RecoveryPolicyConfig };

/**
 * `wiring.recovery` → the Progressive_Runner's recovery wiring: `'full'` → whole stack, default
 * policy; `'no-recovery'` (or `'none'`) → no stack (`--no-recovery`); `'no-x+no-y'` → whole stack
 * with `applyAblations(DEFAULT_RECOVERY_POLICY, [...])`. Anything else is refused.
 */
export function recoveryPlanFor(label: string): RecoveryPlan {
  if (label === 'full') return { kind: 'full' };
  if (label === 'no-recovery' || label === 'none') return { kind: 'none' };
  const parts = label.split('+');
  if (parts.length > 0 && parts.every((p) => POLICY_ABLATIONS.has(p))) {
    return { kind: 'full', policy: applyAblations(DEFAULT_RECOVERY_POLICY, parts as AblationName[]) };
  }
  throw new ArmConfigError(`unknown recovery wiring label '${label}'`);
}

function redactMessage(err: unknown): string {
  const raw = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  const red = redact(raw);
  return red.length <= ARGS_PREVIEW_MAX ? red : `${red.slice(0, ARGS_PREVIEW_MAX)}…`;
}

function hasLastFailureOutput(s: unknown): s is { lastFailureOutput(): string } {
  return (
    s !== null &&
    typeof s === 'object' &&
    'lastFailureOutput' in s &&
    typeof (s as { lastFailureOutput: unknown }).lastFailureOutput === 'function'
  );
}

/**
 * Passive progress-sink wrapper: records Observed_Guards from `DECISION_COMPLETED` at the current
 * ledger step (the `done` just served) and counts `done` decisions, then forwards unchanged.
 */
function guardObservingSink(
  inner: ProgressEventSink,
  ledger: DecisionLedger,
  onDone: () => void,
): ProgressEventSink {
  return {
    async append(event) {
      if (event.type === 'DECISION_COMPLETED') {
        const payload = event.payload as { readonly decision?: unknown } | null | undefined;
        const decision = payload?.decision;
        if (decision === 'done') onDone();
        else if (decision === 'done_rejected_no_change') ledger.guard({ guard: 'P12.11' });
        else if (decision === 'done_rejected_missing_paths') ledger.guard({ guard: 'P12.13' });
      }
      await inner.append(event);
    },
  };
}

/** TaskExecutor whose `execute` is `super.execute`; the result is only read, never altered. */
class ObservedTaskExecutor extends TaskExecutor {
  private readonly armObserve: (result: TaskExecutorResult) => void;

  constructor(deps: TaskExecutorDeps, observe: (result: TaskExecutorResult) => void) {
    super(deps);
    this.armObserve = observe;
  }

  override async execute(req: TaskExecutorRequest): Promise<TaskExecutorResult> {
    const result = await super.execute(req);
    this.armObserve(result);
    return result;
  }
}

async function snapshotWorkspace(root: string): Promise<ArmResult['workspace']> {
  const canonicalRoot = root.replace(/\\/g, '/');
  const { hash } = await computeWorkspaceHash({ root: canonicalRoot });
  const entries = await walkWorkspace({ root: canonicalRoot });
  const pairs: Array<[string, string]> = [];
  for (const e of entries) {
    if (e.type === 'FILE') pairs.push([e.relpath, await hashFileContent(e.absPath)]);
    else if (e.type === 'SYMLINK') pairs.push([e.relpath, `symlink:${e.linkTarget ?? ''}`]);
  }
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const files: Record<string, string> = {};
  for (const [k, v] of pairs) files[k] = v;
  return { hash, files: Object.freeze(files) };
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

// ── runArm ──────────────────────────────────────────────────────────────────────────────────

export async function runArm(config: ArmConfig): Promise<ArmResult> {
  const { mode, trace } = config;
  if (mode !== 'enforce' && mode !== 'shadow') throw new ArmConfigError(`unknown arm mode ${String(mode)}`);
  assertReplayable(trace);
  const recovery = recoveryPlanFor(trace.wiring.recovery);
  const approvalResolution: ApprovalResolution = config.approvalResolution ?? 'none';
  const planId = config.planId ?? 'uninjected';
  const envSource = config.envSource ?? process.env;
  const notes: string[] = [];
  if (trace.wiring.lsp) notes.push('lsp-not-wired');

  const ledger = new DecisionLedger();
  const sandbox = createSandbox(config.seedFiles, mode);
  try {
    const workspaceRoot = sandbox.root;
    const supervisors = config.supervisorFactory(sandbox, ledger);
    const db = new SqliteDatabaseAdapter(':memory:');
    db.open();

    let replay: ReplayStatus;
    let orchestratorResult: SessionOrchestratorResult | undefined;
    let harnessError: ArmHarnessError | undefined;
    let verificationStatus: string | undefined;
    let schemaInactive = true;
    let doneProposed = 0;
    const runFinalStates: TaskExecutorResult['finalState'][] = [];

    try {
      runMigrations(db, createMigrationRegistry(), { now: () => '2026-01-01T00:00:00.000Z' });
      const c = counters();
      // Substitution: the replay gateway (advances the ledger step on every execute response).
      // `modelGateway` is set only when recording a synthetic trace (see ArmConfig).
      const gw: ArmModelGateway =
        config.modelGateway?.(ledger) ?? new ReplayModelGateway(trace, config.injections ?? [], { onStep: ledger });
      const events = new SqliteEventLog(db);
      const graphs = new SqliteTaskGraphRepository(db);
      const hasher = new Blake3GraphHasher();
      const graphSvc = new GraphService({ hasher, now: c.now, nextId: c.nextId, canonicalFormVersion: 'v1', schemaVersion: 1 });
      const graphCommitSvc = new GraphCommitService({ graphs, committer: new SqliteGraphCommitter(db), graphService: graphSvc, now: c.now, nextId: c.nextId });
      const sessionSvc = new SessionService({ sessions: new SqliteSessionRepository(db), events, lock: new SqliteWorkspaceLockService(db), now: c.now, nextId: c.nextId });
      const executions = new SqliteTaskExecutionRepository(db);
      const coordinator = new ExecutionCoordinator({ executions, now: c.now });
      const taskRunSvc = new TaskRunService({ runs: new SqliteTaskRunRepository(db), events, reconciler: new NoopProcessReconciler(), now: c.now, nextId: c.nextId });
      const checkpointSvc = new CheckpointService({ checkpoints: new SqliteCheckpointRepository(db), events, now: c.now, nextId: c.nextId });
      const planner = new Planner({ gateway: gw, now: c.now, nextId: c.nextId });
      // Substitution: EP-PATH observer + containment around the Kernel's workspace manager.
      const workspace = new AblationWorkspaceManager(
        // Enforce: the Kernel's default Path_Access_Policy. Shadow: an OPEN inner manager, so the
        // decision is made only by the AblationWorkspaceManager oracle and the operation runs in the sandbox.
        new NodeWorkspaceManager({
          root: workspaceRoot, now: c.now, nextId: c.nextId,
          ...(mode === 'shadow' ? { pathAccess: OPEN_PATH_ACCESS_POLICY } : {}),
        }),
        sandbox, mode, ledger, { nextId: c.nextId, now: c.now },
      );
      // G5 / TG-013: test files present at goal start (captured below, beside captureClean).
      const testBaseline = new WorkspaceTestBaseline({ root: workspaceRoot });
      // Substitution: caller-provided containment supervisor (never a real spawn from here).
      const supervisor = supervisors.shell;
      const innerExec = new NodeToolExecutor({
        filesystem: { workspace },
        git: { workspace, supervisor },
        shell: { workspace, supervisor, shellPolicy: innerShellPolicyFor(mode) },
      });
      // Substitution: EP-SHELL / EP-ENV observer.
      const toolExec = new AblationToolExecutor(innerExec, { mode, shellPolicy: DEFAULT_SHELL_POLICY, envSource, ledger });
      const checkSupervisor = supervisors.verification;
      // Substitution: EP-VERIFY observer.
      const verEngine = new AblationVerificationEngine(
        { reports: new SqliteVerificationRepository(db), events, supervisor: checkSupervisor, revisionProvider: { capture: async () => revision(workspaceRoot) }, now: c.now, nextId: c.nextId },
        { mode, ledger },
      );
      // Substitution: EP-TOOL-POLICY / EP-SCHEMA / pass-policy EP-APPROVAL observer.
      const enforcedPolicy = buildToolPolicy(trace.wiring.autonomy);
      const tg = new AblationToolGateway(
        { calls: new SqliteToolCallRepository(db), approvals: new SqliteApprovalRepository(db), events, policy: enforcedPolicy, now: c.now, nextId: c.nextId },
        { mode, enforcedPolicy, approvalResolution, ledger },
      );
      schemaInactive = tg.schemaCheck === 'inactive';
      const taskRuns = new SqliteTaskRunRepository(db);
      const contextCollector = new ContextCollector({ workspaceRoot });
      // Substitution: EP-APPROVAL resolution (shadow: approve + record; enforce: none | deny-all).
      const gatewayRef = (): ToolGateway => tg;
      const approvalCoordinator: ApprovalCoordinator | undefined =
        mode === 'shadow'
          ? new ShadowApprovalCoordinator(gatewayRef, ledger, approvalResolution)
          : approvalResolution === 'deny'
            ? new DenyAllApprovalCoordinator(gatewayRef, ledger)
            : undefined;
      const observeRun = (result: TaskExecutorResult): void => {
        runFinalStates.push(result.finalState);
        if (mode === 'enforce' && approvalCoordinator === undefined && result.pendingApprovalToolCallId !== undefined) {
          // The run ended on APPROVAL_PENDING with no coordinator: EP-APPROVAL blocked the call
          // whose EP-TOOL-POLICY `require_approval` entry is the last one at this step.
          const step = ledger.currentStep();
          const policyEntry = ledger
            .snapshot()
            .entries.filter((e) => e.step === step && e.point === 'EP-TOOL-POLICY')
            .pop();
          ledger.record({
            tool: policyEntry?.tool ?? 'unknown',
            argsPreview: policyEntry?.argsPreview ?? '',
            point: 'EP-APPROVAL',
            decision: 'block',
            reason: approvalBlockReason('none'),
            effective: 'block',
            wouldBlock: false,
          });
        }
      };
      const taskExec = new ObservedTaskExecutor({
        taskRunService: taskRunSvc, executionCoordinator: coordinator,
        contextBuilder: new ContextBuilder({ now: c.now, nextId: c.nextId }),
        gateway: gw, toolGateway: tg, executor: toolExec, testBaseline,
        // Substitution: EP-COMPLETION observer.
        verificationEngine: verEngine,
        completionGate: new AblationCompletionGate({ reports: new SqliteVerificationRepository(db) }, { mode, ledger }),
        verificationPolicy: buildVerificationPolicy(inspectProject(workspaceRoot)),
        contextProvider: contextCollector,
        verificationRevisionProvider: { capture: async () => revision(workspaceRoot) },
        // Passive observer: Observed_Guards from DECISION_COMPLETED.
        events: guardObservingSink(events, ledger, () => { doneProposed += 1; }),
        maxToolCalls: trace.wiring.maxToolCalls, now: c.now, nextId: c.nextId,
        ...(approvalCoordinator !== undefined ? { approvalCoordinator } : {}),
      }, observeRun);
      const failures = new SqliteFailureRepository(db);
      const recoveryActions = new SqliteRecoveryActionRepository(db);
      const failureAnalyzer = new FailureAnalyzer({ failures, events, now: c.now, nextId: c.nextId });
      const recoveryEngine = new RecoveryEngine({ recoveryActions, events, sessionService: sessionSvc, now: c.now, nextId: c.nextId });
      const evidence = supervisors.evidence ?? (hasLastFailureOutput(checkSupervisor) ? checkSupervisor : undefined);
      const verificationEvidenceProvider = { lastFailureOutput: () => evidence?.lastFailureOutput() ?? '' };
      const workspaceRollback = new WorkspaceSnapshotRollback({ root: workspaceRoot });
      const sid = 'S';
      const model = trace.source.model;
      await sessionSvc.create({ session: { sessionId: sid, workspaceId: 'W', workspaceRoot, goalId: 'G', graphVersion: 1, state: 'CREATED', createdAt: c.now(), updatedAt: c.now(), runtimeVersion: '0.12.0', schemaVersion: 1, budgetId: 'B', lockId: 'L', metadata: { hostname: 'h', processId: 1, ollamaEndpoint: model.endpoint, ollamaModels: { planner: model.name, critic: model.name, executor: model.name, analyzer: model.name } } }, hostname: 'h', processId: 1 });
      await graphs.commit({ graphId: 'GR', sessionId: sid, version: 1, nodes: [], edges: [], createdAt: 't', createdBy: 'planner', canonicalHash: 'seed', schemaVersion: 1, canonicalFormVersion: 'v1' }, { mutationId: 'M0', sessionId: sid, baseVersion: 0, operations: [], proposedBy: 'planner', reason: 'seed', provenance: { provenanceId: 'P', source: { kind: 'runtime', id: 'init' }, inputs: [], reason: 'seed', at: 't' }, createdAt: 't', status: 'COMMITTED' });
      const recoveryWiring = recovery.kind === 'none'
        ? {}
        : {
            failureAnalyzer, recoveryEngine, failureRepository: failures,
            recoveryActionRepository: recoveryActions, verificationEvidenceProvider,
            workspaceRollback,
            ...(recovery.policy !== undefined ? { recoveryPolicy: recovery.policy } : {}),
          };
      const orchestrator = new SessionOrchestrator({ sessionService: sessionSvc, planner, graphCommitService: graphCommitSvc, graphRepository: graphs, taskRepository: new SqliteTaskRepository(db), executionRepository: executions, executionCoordinator: coordinator, taskExecutor: taskExec, checkpointService: checkpointSvc, maxIterations: 10, taskRunRepository: taskRuns, ...recoveryWiring, now: c.now, nextId: c.nextId });
      const goal: Goal = { goalId: 'G', version: 1, description: config.goalDescription, constraints: [], acceptanceCriteria: [{ criterionId: 'a', description: config.acceptance ?? 'done', mandatory: true }], createdAt: c.now(), createdBy: 'user' };
      try { await workspaceRollback.captureClean(sid); } catch { /* non-fatal (as in the Progressive_Runner) */ }
      try { await testBaseline.capture(); } catch { /* non-fatal: empty baseline = rule inactive */ }
      try {
        orchestratorResult = await orchestrator.run({ sessionId: sid, goal, revision: revision(workspaceRoot), graphVersion: 1 });
      } catch (err) {
        harnessError = { code: 'HARNESS_ERROR', message: redactMessage(err) };
      }
      replay = gw.status();
      // The PERSISTED report keeps the real status in both modes (design C10).
      const reports = db.query<{ status: string }>('SELECT status FROM verification_reports ORDER BY rowid');
      verificationStatus = reports.length > 0 ? reports[reports.length - 1]?.status : undefined;
    } finally {
      db.close();
    }

    // Optional post-run benchmark verdict, through the caller's containment supervisor.
    let benchmarkVerdict: ArmCompletion['benchmarkVerdict'];
    let benchmarkChecks: ArmCheckOutcome[] | undefined;
    if (config.benchmarkChecks !== undefined) {
      const runner = new BenchmarkCheckRunner({
        supervisor: supervisors.checks ?? supervisors.verification,
        workspaceRoot,
        ...(config.checkTimeoutMs !== undefined ? { defaultTimeoutMs: config.checkTimeoutMs } : {}),
      });
      const outcomes = await runner.runAll(config.benchmarkChecks);
      benchmarkChecks = outcomes.map((o) => ({ description: o.description, passed: o.passed }));
      benchmarkVerdict = outcomes.length > 0 && outcomes.every((o) => o.passed) ? 'SUCCESS' : 'FAILURE';
    }

    const workspaceState = await snapshotWorkspace(workspaceRoot);
    const snapshot = ledger.snapshot();

    const doneRejectedBy = sortedUnique([
      ...snapshot.guards.filter((g) => g.guard !== 'IDEMPOTENCY').map((g) => g.guard),
      ...snapshot.entries
        .filter((e) => (e.point === 'EP-VERIFY' || e.point === 'EP-COMPLETION') && e.effective === 'block')
        .map((e) => `${e.point}:${e.reason}`),
    ]);
    const taskPassed =
      orchestratorResult !== undefined &&
      orchestratorResult.passedTaskIds.length > 0 &&
      orchestratorResult.nonPassedTaskIds.length === 0;

    const inactive: InactivePoint[] = ['IDEMPOTENCY'];
    if (schemaInactive) inactive.push('EP-SCHEMA');

    const completion: ArmCompletion = {
      sessionState: orchestratorResult?.sessionState ?? 'HARNESS_ERROR',
      runFinalStates: [...runFinalStates],
      doneProposed,
      doneAccepted: runFinalStates.includes('SUCCEEDED'),
      doneRejectedBy,
      ...(verificationStatus !== undefined ? { verificationStatus } : {}),
      taskPassed,
      ...(benchmarkVerdict !== undefined ? { benchmarkVerdict } : {}),
      ...(benchmarkChecks !== undefined ? { benchmarkChecks } : {}),
    };

    return {
      mode,
      planId,
      traceId: trace.traceId,
      ledger: snapshot,
      replay,
      completion,
      workspace: workspaceState,
      guards: snapshot.guards,
      inactive: sortedUnique(inactive) as InactivePoint[],
      notes: sortedUnique(notes),
      ...(harnessError !== undefined ? { harnessError } : {}),
    };
  } finally {
    destroySandbox(sandbox);
  }
}
