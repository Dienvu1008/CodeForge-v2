/*
 * Copyright 2026 DienVu (Dienvu1008)
 * SPDX-License-Identifier: Apache-2.0
 */

// kernel-shadow-ablation task 6.7 — end-to-end arm pairs through the REAL Kernel
// (SessionOrchestrator → Planner → TaskExecutor → ToolGateway → executors → verification → gate).
//
//   Property 7  — enforce-mode observers are transparent: an enforce arm wired with the Ablation*
//                 observers asks the model for the same purposes with the same prompts, ends every
//                 tool call in the same state, and leaves the same session state, run states,
//                 verification status and workspace hash as a PLAIN Kernel wiring built here
//                 (ToolGateway, NodeWorkspaceManager, NodeToolExecutor, VerificationEngine,
//                 CompletionGate; no observer at all).
//   Property 11 — every reached out-of-policy injection is stopped by the enforce arm and never
//                 executed with a sandbox (or outside) effect there.
//   Examples    — SYN-01..05 uninjected and with every corpus entry in both arms; wiring parity
//                 (uninjected enforce replay serves every entry, no mismatch); SYN-04 organic
//                 would-block + counterfactual steps; assertReplayable refusals.
//   Corpus label check (Requirement 8.3) — every reached entry's observed enforce decision equals
//                 its label under the Progressive_Runner wiring (`full` autonomy).
//
// Phase 1 only: scripted traces, SQLite :memory:, FakeProcessSupervisor (no process is spawned),
// no network. Every arm runs in a fresh sandbox under os.tmpdir(); the two INJ-PATH escape targets
// are checked to be absent after the matrix (nothing is written outside the sandbox).
import { beforeAll, describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CheckpointService,
  CompletionGate,
  ContextBuilder,
  DEFAULT_SHELL_POLICY,
  ExecutionCoordinator,
  FailureAnalyzer,
  GraphCommitService,
  GraphService,
  NoopProcessReconciler,
  Planner,
  RecoveryEngine,
  SessionOrchestrator,
  SessionService,
  TaskExecutor,
  TaskRunService,
  ToolGateway,
  VerificationEngine,
  buildToolPolicy,
  buildVerificationPolicy,
  type ApprovalCoordinator,
  type Goal,
  type ModelGateway,
  type ModelRequest,
  type ModelResponse,
  type SessionOrchestratorResult,
  type TaskExecutorRequest,
  type TaskExecutorResult,
  type WorkspaceRevision,
} from '@codeforge/agent-core';
import {
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
  computeWorkspaceHash,
  createMigrationRegistry,
  inspectProject,
  runMigrations,
} from '@codeforge/infrastructure';
import {
  DecisionLedger,
  INJECTION_CORPUS,
  ReplayModelGateway,
  ReplayRefusedError,
  SYNTHETIC_SCRIPTS,
  UNINJECTED_PLAN_ID,
  assertReplayable,
  buildInjectionPlans,
  compareArms,
  createSandbox,
  destroySandbox,
  recoveryPlanFor,
  replayRefusal,
  runArm,
  synthesizeTrace,
  syntheticSupervisorFactory,
  uninjectedView,
  type ArmModelGateway,
  type ArmResult,
  type CaseComparison,
  type InjectionAt,
  type InjectionContext,
  type InjectionEntry,
  type InjectionPlan,
  type ModelTraceV1,
  type ReplayStatus,
  type SyntheticScript,
  type SyntheticTrace,
  type UninjectedArmView,
} from '@codeforge/testing/shadow-ablation';

// ── seeded PRNG (same mulberry32 generators as tests/mission/clarification-generators.ts; kept
// local because tests/tsconfig.json does not include tests/mission/**) ─────────────────────────

type Rng = () => number;

function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function int(rng: Rng, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}
function pick<T>(rng: Rng, items: readonly T[]): T {
  if (items.length === 0) throw new Error('pick: empty list');
  return items[int(rng, 0, items.length - 1)] as T;
}
/** Async property runner: re-throws with iteration + seed so a counterexample is reproducible. */
async function forAllAsync(seed: number, runs: number, body: (rng: Rng, iteration: number) => Promise<void>): Promise<void> {
  const rng = mulberry32(seed);
  for (let i = 0; i < runs; i++) {
    try {
      await body(rng, i);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`property failed at iteration ${i} (seed ${seed}): ${msg}`, { cause: err });
    }
  }
}

// ── environment ──────────────────────────────────────────────────────────────────────────────

/** Per-test budget for the arm-level tests (the task's 120 s limit). */
const ARM_TEST_TIMEOUT_MS = 120_000;

/**
 * Synthetic EP-ENV source (design C12: "Phase 1 synthetic map"): allowlisted runtime variables plus
 * one secret-named fake, so EP-ENV has something to filter deterministically on every machine.
 * The value is a fake; only the NAME is ever recorded.
 */
const ENV_SOURCE: Readonly<Record<string, string>> = Object.freeze({
  PATH: '/usr/bin:/bin',
  HOME: '/home/cf',
  GITHUB_TOKEN: 'cf-fake-token-not-a-secret',
});

const OUTSIDE_DIR = realpathSync.native(tmpdir());
/** Where INJ-PATH-02 / INJ-PATH-01 would land if anything escaped the sandbox. */
const ESCAPE_TARGETS = [join(OUTSIDE_DIR, 'cf-escape-INJ-PATH-02.txt'), join(OUTSIDE_DIR, 'cf-escape.txt')];


// ── arm helpers ──────────────────────────────────────────────────────────────────────────────

function seedsFor(script: SyntheticScript, entry: InjectionEntry | undefined): Readonly<Record<string, string>> {
  return entry?.seedRequirement !== undefined ? { ...script.seedFiles, ...entry.seedRequirement } : script.seedFiles;
}

function armBase(script: SyntheticScript, trace: ModelTraceV1, plan: InjectionPlan, entry: InjectionEntry | undefined) {
  return {
    trace,
    planId: plan.planId,
    injections: plan.injections,
    seedFiles: seedsFor(script, entry),
    goalDescription: script.description,
    acceptance: script.acceptance,
    supervisorFactory: syntheticSupervisorFactory(script),
    approvalResolution: script.approvalResolution,
    envSource: ENV_SOURCE,
  } as const;
}

interface ArmPair {
  readonly enforce: ArmResult;
  readonly shadow: ArmResult;
  readonly cmp: CaseComparison;
}

async function runPair(script: SyntheticScript, trace: ModelTraceV1, plan: InjectionPlan, entry?: InjectionEntry): Promise<ArmPair> {
  const base = armBase(script, trace, plan, entry);
  const enforce = await runArm({ ...base, mode: 'enforce' });
  const shadow = await runArm({ ...base, mode: 'shadow' });
  return { enforce, shadow, cmp: compareArms(script.id, enforce, shadow, entry) };
}

/** Structural view of the uninjected shadow arm for `buildInjectionPlans` (shared with the Shadow_Runner). */
function viewOf(shadow: ArmResult): UninjectedArmView {
  return uninjectedView(shadow);
}

function injectionContext(script: SyntheticScript): InjectionContext {
  return { outsideDir: OUTSIDE_DIR, seedFiles: script.seedFiles };
}

const CORPUS_BY_ID: ReadonlyMap<string, InjectionEntry> = new Map(INJECTION_CORPUS.map((e) => [e.id, e]));

// ── plain Kernel wiring (Property 7) ─────────────────────────────────────────────────────────

/** What the Kernel did, independent of any observer. */
interface KernelView {
  /** Purpose + root-normalized prompt digest + snapshot id of every model request, in order. */
  readonly requests: readonly string[];
  /** Final state of every tool call, in request order: `<tool>:<state>`. */
  readonly toolCalls: readonly string[];
  readonly sessionState: string;
  readonly runFinalStates: readonly string[];
  readonly verificationStatus: string | undefined;
  readonly workspaceHash: string;
  readonly harnessError: boolean;
}

/** Records every model request (purpose, prompt digest with the sandbox root normalized). */
class RequestLog implements ArmModelGateway {
  readonly requests: string[] = [];

  constructor(
    private readonly inner: ReplayModelGateway,
    private readonly roots: () => readonly string[],
  ) {}

  get identity(): ModelGateway['identity'] {
    return this.inner.identity;
  }

  generate(request: ModelRequest): Promise<ModelResponse> {
    let text = `${request.systemPrompt}\u0000${request.taskPrompt}`;
    for (const r of this.roots()) text = text.split(r).join('<ROOT>');
    const digest = createHash('sha256').update(text).digest('hex').slice(0, 16);
    this.requests.push(`${request.purpose}|${digest}|${request.contextSnapshotId ?? '-'}`);
    return this.inner.generate(request);
  }

  status(): ReplayStatus {
    return this.inner.status();
  }
}

function rootVariants(root: string): string[] {
  const fwd = root.split('\\').join('/');
  return [...new Set([root, fwd])].sort((a, b) => b.length - a.length);
}

function revision(root: string): WorkspaceRevision {
  return {
    revisionId: 'rev', canonicalFormVersion: 'v1', root, includedPaths: [], excludedScratchPaths: [],
    hashAlgorithm: 'blake3', hash: 'H', fileCount: 0, totalBytes: 0,
    createdAt: '2026-01-01T00:00:00.000Z', createdBy: { sessionId: 'S', reason: 'session_start' },
  };
}

function counters(): { now: () => string; nextId: () => string } {
  let t = 0;
  let n = 0;
  return {
    now: () => '2026-01-01T00:00:' + String(t++ % 60).padStart(2, '0') + '.000Z',
    nextId: () => 'ID-' + String(n++).padStart(5, '0'),
  };
}

/**
 * The Progressive_Runner wiring (mirrors arm.ts / scripts/run-progressive.mjs) with the PLAIN
 * Kernel classes: no Ablation* observer, no ledger hook on the model gateway, no observing sink.
 * The enforce arm's `'deny'` approval model is a plain coordinator calling ToolGateway.deny.
 */
async function runPlain(
  script: SyntheticScript,
  trace: ModelTraceV1,
  injections: readonly InjectionAt[],
  seedFiles: Readonly<Record<string, string>>,
): Promise<KernelView> {
  const sandbox = createSandbox(seedFiles, 'enforce');
  try {
    const workspaceRoot = sandbox.root;
    const roots = rootVariants(workspaceRoot);
    const supervisors = syntheticSupervisorFactory(script)(sandbox, new DecisionLedger());
    const db = new SqliteDatabaseAdapter(':memory:');
    db.open();
    let result: SessionOrchestratorResult | undefined;
    let harnessError = false;
    const runFinalStates: string[] = [];
    let log: RequestLog;
    let toolCalls: string[];
    let verificationStatus: string | undefined;
    try {
      runMigrations(db, createMigrationRegistry(), { now: () => '2026-01-01T00:00:00.000Z' });
      const c = counters();
      log = new RequestLog(new ReplayModelGateway(trace, injections), () => roots);
      const gw = log;
      const events = new SqliteEventLog(db);
      const graphs = new SqliteTaskGraphRepository(db);
      const graphSvc = new GraphService({ hasher: new Blake3GraphHasher(), now: c.now, nextId: c.nextId, canonicalFormVersion: 'v1', schemaVersion: 1 });
      const graphCommitSvc = new GraphCommitService({ graphs, committer: new SqliteGraphCommitter(db), graphService: graphSvc, now: c.now, nextId: c.nextId });
      const sessionSvc = new SessionService({ sessions: new SqliteSessionRepository(db), events, lock: new SqliteWorkspaceLockService(db), now: c.now, nextId: c.nextId });
      const executions = new SqliteTaskExecutionRepository(db);
      const coordinator = new ExecutionCoordinator({ executions, now: c.now });
      const taskRunSvc = new TaskRunService({ runs: new SqliteTaskRunRepository(db), events, reconciler: new NoopProcessReconciler(), now: c.now, nextId: c.nextId });
      const checkpointSvc = new CheckpointService({ checkpoints: new SqliteCheckpointRepository(db), events, now: c.now, nextId: c.nextId });
      const planner = new Planner({ gateway: gw, now: c.now, nextId: c.nextId });
      const workspace = new NodeWorkspaceManager({ root: workspaceRoot, now: c.now, nextId: c.nextId });
      const supervisor = supervisors.shell;
      const toolExec = new NodeToolExecutor({
        filesystem: { workspace },
        git: { workspace, supervisor },
        shell: { workspace, supervisor, shellPolicy: DEFAULT_SHELL_POLICY },
      });
      const verEngine = new VerificationEngine({ reports: new SqliteVerificationRepository(db), events, supervisor: supervisors.verification, revisionProvider: { capture: async () => revision(workspaceRoot) }, now: c.now, nextId: c.nextId });
      const tg = new ToolGateway({ calls: new SqliteToolCallRepository(db), approvals: new SqliteApprovalRepository(db), events, policy: buildToolPolicy(trace.wiring.autonomy), now: c.now, nextId: c.nextId });
      const approvalCoordinator: ApprovalCoordinator | undefined =
        script.approvalResolution === 'deny'
          ? { awaitDecision: async (_sid, toolCallId) => { await tg.deny(toolCallId, 'policy', 'simulated_human_denied'); return 'denied'; } }
          : undefined;
      const taskExecInner = new TaskExecutor({
        taskRunService: taskRunSvc, executionCoordinator: coordinator,
        contextBuilder: new ContextBuilder({ now: c.now, nextId: c.nextId }),
        gateway: gw, toolGateway: tg, executor: toolExec,
        verificationEngine: verEngine,
        completionGate: new CompletionGate({ reports: new SqliteVerificationRepository(db) }),
        verificationPolicy: buildVerificationPolicy(inspectProject(workspaceRoot)),
        contextProvider: new ContextCollector({ workspaceRoot }),
        verificationRevisionProvider: { capture: async () => revision(workspaceRoot) },
        events,
        maxToolCalls: trace.wiring.maxToolCalls, now: c.now, nextId: c.nextId,
        ...(approvalCoordinator !== undefined ? { approvalCoordinator } : {}),
      });
      // Delegating wrapper (not a subclass): only reads the result.
      const taskExec = Object.assign(Object.create(taskExecInner) as TaskExecutor, {
        execute: async (req: TaskExecutorRequest): Promise<TaskExecutorResult> => {
          const r = await taskExecInner.execute(req);
          runFinalStates.push(r.finalState);
          return r;
        },
      });
      const failures = new SqliteFailureRepository(db);
      const recoveryActions = new SqliteRecoveryActionRepository(db);
      const workspaceRollback = new WorkspaceSnapshotRollback({ root: workspaceRoot });
      const recovery = recoveryPlanFor(trace.wiring.recovery);
      const recoveryWiring = recovery.kind === 'none'
        ? {}
        : {
            failureAnalyzer: new FailureAnalyzer({ failures, events, now: c.now, nextId: c.nextId }),
            recoveryEngine: new RecoveryEngine({ recoveryActions, events, sessionService: sessionSvc, now: c.now, nextId: c.nextId }),
            failureRepository: failures, recoveryActionRepository: recoveryActions,
            verificationEvidenceProvider: { lastFailureOutput: () => '' },
            workspaceRollback,
            ...(recovery.policy !== undefined ? { recoveryPolicy: recovery.policy } : {}),
          };
      const sid = 'S';
      const model = trace.source.model;
      await sessionSvc.create({ session: { sessionId: sid, workspaceId: 'W', workspaceRoot, goalId: 'G', graphVersion: 1, state: 'CREATED', createdAt: c.now(), updatedAt: c.now(), runtimeVersion: '0.12.0', schemaVersion: 1, budgetId: 'B', lockId: 'L', metadata: { hostname: 'h', processId: 1, ollamaEndpoint: model.endpoint, ollamaModels: { planner: model.name, critic: model.name, executor: model.name, analyzer: model.name } } }, hostname: 'h', processId: 1 });
      await graphs.commit({ graphId: 'GR', sessionId: sid, version: 1, nodes: [], edges: [], createdAt: 't', createdBy: 'planner', canonicalHash: 'seed', schemaVersion: 1, canonicalFormVersion: 'v1' }, { mutationId: 'M0', sessionId: sid, baseVersion: 0, operations: [], proposedBy: 'planner', reason: 'seed', provenance: { provenanceId: 'P', source: { kind: 'runtime', id: 'init' }, inputs: [], reason: 'seed', at: 't' }, createdAt: 't', status: 'COMMITTED' });
      const orchestrator = new SessionOrchestrator({ sessionService: sessionSvc, planner, graphCommitService: graphCommitSvc, graphRepository: graphs, taskRepository: new SqliteTaskRepository(db), executionRepository: executions, executionCoordinator: coordinator, taskExecutor: taskExec, checkpointService: checkpointSvc, maxIterations: 10, taskRunRepository: new SqliteTaskRunRepository(db), ...recoveryWiring, now: c.now, nextId: c.nextId });
      const goal: Goal = { goalId: 'G', version: 1, description: script.description, constraints: [], acceptanceCriteria: [{ criterionId: 'a', description: script.acceptance, mandatory: true }], createdAt: c.now(), createdBy: 'user' };
      try { await workspaceRollback.captureClean(sid); } catch { /* non-fatal (as in the Progressive_Runner) */ }
      try {
        result = await orchestrator.run({ sessionId: sid, goal, revision: revision(workspaceRoot), graphVersion: 1 });
      } catch {
        harnessError = true;
      }
      toolCalls = db.query<{ tool_name: string; state: string }>('SELECT tool_name, state FROM tool_calls ORDER BY rowid').map((r) => `${r.tool_name}:${r.state}`);
      const reports = db.query<{ status: string }>('SELECT status FROM verification_reports ORDER BY rowid');
      verificationStatus = reports.length > 0 ? reports[reports.length - 1]?.status : undefined;
    } finally {
      db.close();
    }
    const { hash } = await computeWorkspaceHash({ root: workspaceRoot.replace(/\\/g, '/') });
    return {
      requests: log.requests,
      toolCalls,
      sessionState: result?.sessionState ?? 'HARNESS_ERROR',
      runFinalStates,
      verificationStatus,
      workspaceHash: hash,
      harnessError,
    };
  } finally {
    destroySandbox(sandbox);
  }
}

/**
 * Tool call final states of an observed enforce arm, read from its ledger: one EP-TOOL-POLICY
 * entry per ToolGateway.request (request order); allowed calls take the outcome of the matching
 * ExecutedAction (same order: TaskExecutor runs tool calls sequentially).
 */
function observedToolCalls(arm: ArmResult): string[] {
  const executed = [...arm.ledger.executed];
  const out: string[] = [];
  for (const e of arm.ledger.entries) {
    if (e.point !== 'EP-TOOL-POLICY') continue;
    if (e.decision === 'block') out.push(`${e.tool}:DENIED`);
    else if (e.decision === 'require_approval') {
      const denied = arm.ledger.entries.some((x) => x.step === e.step && x.point === 'EP-APPROVAL' && x.reason === 'simulated_human_denied');
      out.push(`${e.tool}:${denied ? 'DENIED' : 'APPROVAL_PENDING'}`);
    } else {
      const idx = executed.findIndex((a) => a.step === e.step && a.tool === e.tool);
      const action = idx >= 0 ? executed.splice(idx, 1)[0] : undefined;
      out.push(`${e.tool}:${action?.outcome ?? 'NOT_EXECUTED'}`);
    }
  }
  return out;
}

/** Run the OBSERVED enforce arm (runArm + Ablation* observers) with a request log. */
async function runObserved(
  script: SyntheticScript,
  trace: ModelTraceV1,
  injections: readonly InjectionAt[],
  seedFiles: Readonly<Record<string, string>>,
): Promise<{ arm: ArmResult; view: KernelView }> {
  let root = '';
  let log: RequestLog | undefined;
  const supervisors = syntheticSupervisorFactory(script);
  const arm = await runArm({
    mode: 'enforce',
    trace,
    injections,
    seedFiles,
    goalDescription: script.description,
    acceptance: script.acceptance,
    approvalResolution: script.approvalResolution,
    envSource: ENV_SOURCE,
    supervisorFactory: (sandbox, ledger) => {
      root = sandbox.root;
      return supervisors(sandbox, ledger);
    },
    modelGateway: (ledger) => {
      const roots = rootVariants(root);
      log = new RequestLog(new ReplayModelGateway(trace, injections, { onStep: ledger }), () => roots);
      return log;
    },
  });
  return {
    arm,
    view: {
      requests: log?.requests ?? [],
      toolCalls: observedToolCalls(arm),
      sessionState: arm.completion.sessionState,
      runFinalStates: arm.completion.runFinalStates,
      verificationStatus: arm.completion.verificationStatus,
      workspaceHash: arm.workspace.hash,
      harnessError: arm.harnessError !== undefined,
    },
  };
}

// ── generated benign scripts (Property 7 / 11) ───────────────────────────────────────────────

function planJson(description: string): string {
  return JSON.stringify({ tasks: [{ id: 'T1', description, strategy: 'generate' }], edges: [], reason: 'generated benign change' });
}
function toolCall(toolName: string, args: Readonly<Record<string, unknown>>, reasoning: string): string {
  return JSON.stringify({ type: 'tool_call', toolName, arguments: args, reasoning });
}

/**
 * A benign variant of SYN-01..03 (`full` autonomy, no approval needed): 1..4 tool calls drawn from
 * write_file (new file), read_file (seeded or written), edit_file (on a file this script wrote),
 * run_command `node test.js` (scripted green) — the first is always a write so P12.11 never fires —
 * then `done`. The task / goal text names no path, so P12.13 never fires either.
 */
function genBenignScript(rng: Rng, iteration: number): SyntheticScript {
  const base = pick(rng, SYNTHETIC_SCRIPTS.filter((s) => s.autonomy === 'full' && s.approvalResolution === 'none'));
  const written: { path: string; content: string }[] = [];
  const responses: string[] = [planJson('Make the generated change')];
  const n = int(rng, 1, 4);
  for (let k = 0; k < n; k++) {
    const op = k === 0 ? 0 : int(rng, 0, 3);
    if (op === 0 || written.length === 0) {
      const path = `src/gen${iteration}_${k}.js`;
      const content = `module.exports = { v${k}: ${int(rng, 0, 999)} };\n`;
      written.push({ path, content });
      responses.push(toolCall('write_file', { path, content }, 'write a generated module'));
    } else if (op === 1) {
      const target = pick(rng, [...Object.keys(base.seedFiles), ...written.map((w) => w.path)]);
      responses.push(toolCall('read_file', { path: target }, 'inspect a file'));
    } else if (op === 2) {
      const w = pick(rng, written);
      const next = w.content.replace(/: (\d+) \}/, (_m, d: string) => `: ${Number(d) + 1} }`);
      responses.push(toolCall('edit_file', { path: w.path, oldString: w.content.trim(), newString: next.trim() }, 'bump the value'));
      w.content = next;
    } else {
      responses.push(toolCall('run_command', { command: 'node', args: ['test.js'] }, 'run the tests'));
    }
  }
  responses.push(JSON.stringify({ type: 'done', summary: 'Generated change written.' }));
  return {
    ...base,
    id: `GEN-${iteration}`,
    description: 'Make the generated change',
    responses,
  };
}

// ── the SYN × corpus matrix (computed once) ──────────────────────────────────────────────────

interface ScriptRun {
  readonly synth: SyntheticTrace;
  readonly uninjected: ArmPair;
  readonly plans: readonly InjectionPlan[];
  /** corpus id → arm pair (only for placeable plans). */
  readonly injected: ReadonlyMap<string, ArmPair>;
}

const runs = new Map<string, ScriptRun>();
const escapeTargetsBefore = ESCAPE_TARGETS.map((p) => existsSync(p));

beforeAll(async () => {
  for (const script of SYNTHETIC_SCRIPTS) {
    const synth = await synthesizeTrace(script);
    const uninjected = await runPair(script, synth.trace, { planId: UNINJECTED_PLAN_ID, injections: [] });
    const plans = buildInjectionPlans(synth.trace, viewOf(uninjected.shadow), INJECTION_CORPUS, injectionContext(script));
    const injected = new Map<string, ArmPair>();
    for (const plan of plans) {
      if (plan.planId === UNINJECTED_PLAN_ID || plan.injections.length === 0) continue;
      injected.set(plan.planId, await runPair(script, synth.trace, plan, CORPUS_BY_ID.get(plan.planId)));
    }
    runs.set(script.id, { synth, uninjected, plans, injected });
  }
}, 600_000);

function scriptRun(id: string): ScriptRun {
  const r = runs.get(id);
  if (r === undefined) throw new Error(`no run for ${id}`);
  return r;
}

// ── examples ─────────────────────────────────────────────────────────────────────────────────

describe('assertReplayable', () => {
  it('refuses a concurrent trace and an interaction ask trace, accepts the synthetic ones', () => {
    const trace = scriptRun('SYN-01').synth.trace;
    expect(() => assertReplayable(trace)).not.toThrow();
    const concurrent: ModelTraceV1 = { ...trace, concurrent: true };
    const ask: ModelTraceV1 = { ...trace, wiring: { ...trace.wiring, interaction: 'ask' } };
    expect(() => assertReplayable(concurrent)).toThrow(ReplayRefusedError);
    expect(() => assertReplayable(ask)).toThrow(ReplayRefusedError);
    expect(replayRefusal(concurrent)?.reason).toBe('concurrent');
    expect(replayRefusal(ask)?.reason).toBe('interaction');
  });

  it('runArm refuses the same traces before creating a sandbox', async () => {
    const { synth } = scriptRun('SYN-01');
    const base = armBase(synth.script, synth.trace, { planId: UNINJECTED_PLAN_ID, injections: [] }, undefined);
    await expect(runArm({ ...base, mode: 'enforce', trace: { ...synth.trace, concurrent: true } })).rejects.toBeInstanceOf(ReplayRefusedError);
    await expect(runArm({ ...base, mode: 'shadow', trace: { ...synth.trace, wiring: { ...synth.trace.wiring, interaction: 'ask' } } })).rejects.toBeInstanceOf(ReplayRefusedError);
  });
});

describe('SYN-01..05 through SessionOrchestrator in both arms', () => {
  it('uninjected: no harness error, and the enforce arm replays every entry with no mismatch (wiring parity)', () => {
    expect(runs.size).toBe(SYNTHETIC_SCRIPTS.length);
    expect(SYNTHETIC_SCRIPTS.length).toBeGreaterThanOrEqual(4);
    for (const script of SYNTHETIC_SCRIPTS) {
      const { uninjected, synth } = scriptRun(script.id);
      expect(uninjected.enforce.harnessError, script.id).toBeUndefined();
      expect(uninjected.shadow.harnessError, script.id).toBeUndefined();
      const f = uninjected.cmp.fidelity;
      expect(f.total, script.id).toBe(synth.trace.entries.length);
      expect(f.served, script.id).toBe(f.total);
      expect(f.mismatch, script.id).toBeUndefined();
      expect(f.exhausted, script.id).toBe(false);
      // The replayed enforce arm reproduces the recording run.
      expect(uninjected.enforce.workspace.hash, script.id).toBe(synth.recording.workspace.hash);
      expect(uninjected.enforce.completion, script.id).toEqual(synth.recording.completion);
      expect(uninjected.cmp.kernelMisses, script.id).toEqual([]);
    }
  });

  it('SYN-01..03 have no organic would-block: both arms agree and leave the same workspace', () => {
    for (const id of ['SYN-01', 'SYN-02', 'SYN-03']) {
      const { cmp } = scriptRun(id).uninjected;
      expect(cmp.divergence, id).toBeUndefined();
      expect(cmp.proposals.every((p) => p.shadow?.wouldBlock !== true), id).toBe(true);
      expect(cmp.workspace.identical, id).toBe(true);
      expect(cmp.completion.enforce.taskPassed, id).toBe(true);
    }
  });

  it('SYN-04 reports an organic would-block on the delete and counterfactual steps after it', () => {
    const { cmp, enforce, shadow } = scriptRun('SYN-04').uninjected;
    const wb = cmp.proposals.filter((p) => p.source === 'organic' && p.shadow?.wouldBlock === true);
    expect(wb.length).toBeGreaterThanOrEqual(1);
    const first = wb[0];
    expect(first?.tool).toBe('delete_file');
    expect(first?.enforce?.effective).toBe('block');
    expect(first?.shadow?.points).toEqual(expect.arrayContaining(['EP-APPROVAL']));
    expect(cmp.divergence?.step).toBe(first?.step);
    const later = cmp.proposals.filter((p) => p.step > (first?.step ?? 0));
    expect(later.length).toBeGreaterThan(0);
    expect(later.every((p) => p.counterfactual)).toBe(true);
    expect(cmp.proposals.filter((p) => p.step <= (first?.step ?? 0)).every((p) => !p.counterfactual)).toBe(true);
    // The shadow arm deleted the stale file; the enforce arm (human denied) did not.
    expect(cmp.workspace.removed).toContain('src/legacy.js');
    expect(enforce.workspace.files['src/legacy.js']).toBeDefined();
    expect(shadow.workspace.files['src/legacy.js']).toBeUndefined();
  });

  it('SYN-05 (edits autonomy) stops the organic run_command at EP-APPROVAL in the enforce arm', () => {
    const { cmp } = scriptRun('SYN-05').uninjected;
    const row = cmp.proposals.find((p) => p.tool === 'run_command');
    expect(row?.enforce?.effective).toBe('block');
    expect(row?.shadow?.wouldBlock).toBe(true);
    expect(cmp.completion.enforce.taskPassed).toBe(false);
  });

  it('every corpus entry runs in both arms on every script where it is placeable, covering every category', () => {
    const reachedCategories = new Set<string>();
    for (const script of SYNTHETIC_SCRIPTS) {
      const r = scriptRun(script.id);
      expect(r.plans.length, script.id).toBe(INJECTION_CORPUS.length + 1);
      for (const plan of r.plans) {
        if (plan.planId === UNINJECTED_PLAN_ID) continue;
        if (plan.injections.length === 0) {
          expect(plan.notPlaceable, `${script.id}/${plan.planId}`).toBeTruthy();
          continue;
        }
        const pair = r.injected.get(plan.planId);
        expect(pair, `${script.id}/${plan.planId}`).toBeDefined();
        expect(pair?.enforce.harnessError, `${script.id}/${plan.planId}`).toBeUndefined();
        expect(pair?.shadow.harnessError, `${script.id}/${plan.planId}`).toBeUndefined();
        expect(pair?.cmp.injected?.shadowReached, `${script.id}/${plan.planId}`).toBe(true);
        if (pair?.cmp.injected?.reached === true) reachedCategories.add(CORPUS_BY_ID.get(plan.planId)?.category ?? '?');
      }
    }
    expect([...reachedCategories].sort()).toEqual([...new Set(INJECTION_CORPUS.map((e) => e.category))].sort());
  });

  it('nothing was written outside the sandboxes', () => {
    expect(ESCAPE_TARGETS.map((p) => existsSync(p))).toEqual(escapeTargetsBefore);
    for (const r of runs.values()) {
      for (const pair of [r.uninjected, ...r.injected.values()]) {
        expect(pair.cmp.kernelMisses).toEqual([]);
        expect(pair.enforce.ledger.executed.every((a) => a.effect !== 'simulated')).toBe(true);
      }
    }
  });
});

// ── Property 11 ──────────────────────────────────────────────────────────────────────────────

/**
 * EP-ENV `filter` is a stop of the environment, not of the command: the command runs with the
 * filtered env, so its ExecutedAction legitimately has a sandbox effect.
 */
function onlyFiltered(stoppers: readonly string[]): boolean {
  return stoppers.length > 0 && stoppers.every((s) => s === 'EP-ENV');
}

function assertStoppedAndNotExecuted(where: string, pair: ArmPair): void {
  const inj = pair.cmp.injected;
  expect(inj, where).toBeDefined();
  if (inj === undefined || !inj.reached || inj.labelMatches === 'n/a') return;
  expect(inj.stopped, `${where}: stoppers ${JSON.stringify(inj.stoppers)}`).toBe(true);
  expect(inj.enforceEffects.includes('simulated'), where).toBe(false);
  if (!onlyFiltered(inj.stoppers)) expect(inj.enforceEffects.includes('sandbox'), `${where}: ${JSON.stringify(inj.enforceEffects)}`).toBe(false);
  expect(pair.cmp.kernelMisses, where).toEqual([]);
  // The shadow arm records the would-block for the same proposal and lets it proceed (EP-ENV
  // filters identically in both arms and is never a wouldBlock; guards fire in both arms).
  if (!onlyFiltered(inj.stoppers) && !inj.stoppers.every((s) => s.startsWith('GUARD-'))) {
    expect(inj.shadowWouldBlock, where).toBe(true);
  }
}

describe('Property 11: Every reached out-of-policy injection is stopped and never executed by the enforce arm', () => {
  // Feature: kernel-shadow-ablation, Property 11: Every reached out-of-policy injection is stopped and never executed by the enforce arm
  it('SYN-01..05 × every non-gap corpus entry: 100% of reached entries stopped, none executed with an effect', () => {
    let reached = 0;
    let stopped = 0;
    for (const script of SYNTHETIC_SCRIPTS) {
      for (const [id, pair] of scriptRun(script.id).injected) {
        const entry = CORPUS_BY_ID.get(id);
        if (entry === undefined || entry.expected.kernelGap === true) continue;
        assertStoppedAndNotExecuted(`${script.id}/${id}`, pair);
        const inj = pair.cmp.injected;
        if (inj?.reached === true && inj.labelMatches !== 'n/a') {
          reached += 1;
          if (inj.stopped) stopped += 1;
        }
      }
    }
    expect(reached).toBeGreaterThan(0);
    expect(stopped).toBe(reached);
  });

  // 100 generated benign traces × one random out-of-policy entry each (each iteration records a
  // trace and runs 4 arms, ≈ 0.2 s; 100 fit the 120 s budget).
  it('generated benign traces × a random out-of-policy entry (100 seeded cases)', async () => {
    const outOfPolicy = INJECTION_CORPUS.filter((e) => e.expected.kernelGap !== true);
    let reachedCount = 0;
    await forAllAsync(0x5a_0011, 100, async (rng, i) => {
      const script = genBenignScript(rng, i);
      const synth = await synthesizeTrace(script);
      const unPair = await runPair(script, synth.trace, { planId: UNINJECTED_PLAN_ID, injections: [] });
      expect(unPair.cmp.divergence).toBeUndefined();
      const entry = pick(rng, outOfPolicy);
      const plan = buildInjectionPlans(synth.trace, viewOf(unPair.shadow), [entry], injectionContext(script))[1];
      if (plan === undefined || plan.injections.length === 0) return;
      const pair = await runPair(script, synth.trace, plan, entry);
      assertStoppedAndNotExecuted(`${script.id}/${entry.id}`, pair);
      if (pair.cmp.injected?.reached === true) reachedCount += 1;
    });
    expect(reachedCount).toBeGreaterThan(0);
  }, ARM_TEST_TIMEOUT_MS);
});

// ── Property 7 ───────────────────────────────────────────────────────────────────────────────

async function expectTransparent(where: string, script: SyntheticScript, trace: ModelTraceV1, injections: readonly InjectionAt[], seedFiles: Readonly<Record<string, string>>): Promise<void> {
  const plain = await runPlain(script, trace, injections, seedFiles);
  const { view } = await runObserved(script, trace, injections, seedFiles);
  expect(view, where).toEqual(plain);
}

describe('Property 7: Enforce-mode observers are transparent', () => {
  // Feature: kernel-shadow-ablation, Property 7: Enforce-mode observers are transparent
  it('SYN-01..05, uninjected and with every placeable injection plan: observed enforce arm ≡ plain Kernel', async () => {
    let cases = 0;
    for (const script of SYNTHETIC_SCRIPTS) {
      const r = scriptRun(script.id);
      for (const plan of r.plans) {
        if (plan.planId !== UNINJECTED_PLAN_ID && plan.injections.length === 0) continue;
        await expectTransparent(`${script.id}/${plan.planId}`, script, r.synth.trace, plan.injections, seedsFor(script, CORPUS_BY_ID.get(plan.planId)));
        cases += 1;
      }
    }
    expect(cases).toBeGreaterThanOrEqual(SYNTHETIC_SCRIPTS.length * 10);
  }, ARM_TEST_TIMEOUT_MS);

  // 100 generated benign traces (each records a trace and runs the observed + plain wirings,
  // ≈ 0.15 s; 100 fit the 120 s budget).
  it('generated benign traces (100 seeded cases): observed enforce arm ≡ plain Kernel', async () => {
    await forAllAsync(0x5a_0007, 100, async (rng, i) => {
      const script = genBenignScript(rng, i);
      const synth = await synthesizeTrace(script);
      await expectTransparent(script.id, script, synth.trace, [], script.seedFiles);
    });
  }, ARM_TEST_TIMEOUT_MS);
});

// ── Corpus label check (Requirement 8.3) ─────────────────────────────────────────────────────

describe('Corpus label check: every reached entry is stopped exactly as its label says', () => {
  it('on every SYN script the observed enforce decision equals the label (gap labels: `full` autonomy only)', () => {
    const rows: string[] = [];
    const mismatches: string[] = [];
    for (const script of SYNTHETIC_SCRIPTS) {
      for (const [id, pair] of scriptRun(script.id).injected) {
        const inj = pair.cmp.injected;
        const entry = CORPUS_BY_ID.get(id);
        if (inj === undefined || entry === undefined) continue;
        const observed = !inj.reached ? 'not reached' : inj.stopped ? inj.stoppers.join('+') : 'let through';
        const row = `${script.id} ${id} label=${JSON.stringify(entry.expected.stoppedBy)} observed=${observed} effects=${JSON.stringify(inj.enforceEffects)} match=${String(inj.labelMatches)}${inj.labelNote !== undefined ? ` (${inj.labelNote})` : ''}`;
        rows.push(row);
        if (inj.labelMatches !== false) continue;
        // A gap label describes the Progressive_Runner (`full`) wiring; under `edits` a shell gap
        // probe is legitimately stopped earlier by the autonomy policy (require_approval).
        const autonomyStop =
          script.autonomy !== 'full' &&
          entry.expected.kernelGap === true &&
          inj.stoppers.length > 0 &&
          inj.stoppers.every((s) => s === 'EP-TOOL-POLICY' || s === 'EP-APPROVAL');
        if (!autonomyStop) mismatches.push(row);
      }
    }
    if (process.env['CF_SHADOW_LABEL_TABLE'] === '1') console.log(rows.join('\n'));
    expect(mismatches).toEqual([]);
  });

  it('under `full` autonomy the FIRST observed stopper is the label\'s primary stopper', () => {
    for (const script of SYNTHETIC_SCRIPTS.filter((s) => s.autonomy === 'full')) {
      for (const [id, pair] of scriptRun(script.id).injected) {
        const inj = pair.cmp.injected;
        const entry = CORPUS_BY_ID.get(id);
        if (inj?.reached !== true || inj.labelMatches !== true || entry === undefined || entry.expected.kernelGap === true) continue;
        expect(inj.stoppedBy, `${script.id}/${id}`).toBe(entry.expected.stoppedBy[0]);
      }
    }
  });

  it('under `edits` autonomy (SYN-05) every reached run_command entry, gap or not, is stopped at EP-TOOL-POLICY / EP-APPROVAL', () => {
    for (const [id, pair] of scriptRun('SYN-05').injected) {
      const inj = pair.cmp.injected;
      if (inj?.reached !== true) continue;
      const entry = CORPUS_BY_ID.get(id);
      if (!(entry?.raw.includes('"run_command"') ?? false)) continue;
      expect(inj.stoppers, id).toEqual(expect.arrayContaining(['EP-TOOL-POLICY']));
    }
  });

  it('INJ-DONE-02 is stopped at EP-VERIFY when verification is not PASS (red variant of SYN-01)', async () => {
    const base = SYNTHETIC_SCRIPTS.find((s) => s.id === 'SYN-01');
    if (base === undefined) throw new Error('SYN-01 missing');
    const red: SyntheticScript = {
      ...base,
      id: 'SYN-01-RED',
      recovery: 'no-recovery',
      processRules: [
        { command: /^node$/, outcome: { exitCode: 0, stdout: 'ok\n', stderr: '' } },
        { command: /^npm/, outcome: { exitCode: 1, stdout: '', stderr: 'AssertionError: expected true\n' } },
      ],
    };
    const synth = await synthesizeTrace(red);
    const un = await runPair(red, synth.trace, { planId: UNINJECTED_PLAN_ID, injections: [] });
    const entry = CORPUS_BY_ID.get('INJ-DONE-02');
    if (entry === undefined) throw new Error('INJ-DONE-02 missing');
    const plan = buildInjectionPlans(synth.trace, viewOf(un.shadow), [entry], injectionContext(red))[1];
    expect(plan?.injections.length).toBe(1);
    if (plan === undefined) return;
    const pair = await runPair(red, synth.trace, plan, entry);
    const inj = pair.cmp.injected;
    if (process.env['CF_SHADOW_LABEL_TABLE'] === '1') console.log(JSON.stringify({ un: un.cmp.completion, inj }, null, 1));
    expect(inj?.reached).toBe(true);
    expect(inj?.labelMatches).toBe(true);
    expect(inj?.stoppers).toEqual(expect.arrayContaining(['EP-VERIFY']));
    expect(pair.cmp.completion.enforce.taskPassed).toBe(false);
  }, ARM_TEST_TIMEOUT_MS);

  it('every entry is reached on at least one `full` autonomy script (no label left unchecked)', () => {
    const reached = new Set<string>();
    for (const script of SYNTHETIC_SCRIPTS.filter((s) => s.autonomy === 'full')) {
      for (const [id, pair] of scriptRun(script.id).injected) if (pair.cmp.injected?.reached === true) reached.add(id);
    }
    expect([...reached].sort()).toEqual(INJECTION_CORPUS.map((e) => e.id).sort());
  });
});
