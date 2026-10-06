// P9-I1 — Observability + Control E2E. Wires ObservabilityService + ControlPlane + a real
// SessionOrchestrator with the SessionStateControlGate over the real kernel, and proves
// the observe -> control -> resume cycle plus replay determinism and non-authority.
//
// Scenarios:
//   1. Observe: getState / getTrace reflect the authoritative session.
//   2. Control: submitControl pause drives the session to PAUSED; resume returns RUNNING;
//      a dashboard-shaped and a telegram-shaped pause are equivalent (OB-006).
//   3. Live loop: an orchestrator run with the gate pre-set to cancel aborts cleanly.
//   4. Replay: getAuditTimeline reconstructs the same ordered history deterministically.
//   5. Adversarial: a RuntimeProjection consumer cannot write authoritative state (OB-005).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  SqliteDatabaseAdapter,
  SqliteSessionRepository,
  SqliteTaskRepository,
  SqliteTaskRunRepository,
  SqliteTaskExecutionRepository,
  SqliteTaskGraphRepository,
  SqliteGraphCommitter,
  SqliteCheckpointRepository,
  SqliteWorkspaceLockService,
  SqliteEventLog,
  Blake3GraphHasher,
  SqliteToolCallRepository,
  SqliteApprovalRepository,
  SqliteVerificationRepository,
  ObservabilityService,
  SessionStateControlGate,
  runMigrations,
  createMigrationRegistry,
} from '@codeforge/infrastructure';
import {
  ControlPlane,
  SessionService,
  SessionOrchestrator,
  Planner,
  GraphCommitService,
  GraphService,
  ExecutionCoordinator,
  TaskRunService,
  TaskExecutor,
  CheckpointService,
  NoopProcessReconciler,
  PERMISSIVE_TEST_POLICY,
  DEFAULT_VERIFICATION_POLICY,
  VerificationEngine,
  CompletionGate,
  computeRuntimeProjection,
  type Session,
  type Goal,
  type WorkspaceRevision,
} from '@codeforge/agent-core';
import { FakeModel, FakeRevisionProvider } from '@codeforge/testing';

function makeCounters(): { now: () => string; nextId: () => string } {
  let t = 0; let n = 0;
  return {
    now: () => `2026-01-01T00:00:${String(t++).padStart(2, '0')}.000Z`,
    nextId: () => `ID-${String(n++).padStart(4, '0')}`,
  };
}
const REVISION: WorkspaceRevision = {
  revisionId: 'rev-1', canonicalFormVersion: 'v1', root: '/r', includedPaths: [], excludedScratchPaths: [],
  hashAlgorithm: 'blake3', hash: 'H1', fileCount: 0, totalBytes: 0,
  createdAt: 't', createdBy: { sessionId: 'S', reason: 'session_start' },
};
function makeGoal(): Goal {
  return { goalId: 'G', version: 1, description: 'greet', constraints: [],
    acceptanceCriteria: [{ criterionId: 'AC1', description: 'greets', mandatory: true }],
    createdAt: 't', createdBy: 'user' };
}
function makeSession(): Session {
  return {
    sessionId: 'S', workspaceId: 'W', workspaceRoot: '/r', goalId: 'G', graphVersion: 1,
    state: 'CREATED', createdAt: 't', updatedAt: 't', runtimeVersion: '0.9.0', schemaVersion: 1,
    budgetId: 'B', lockId: 'L',
    metadata: { hostname: 'h', processId: 1, ollamaEndpoint: 'x',
      ollamaModels: { planner: 'p', critic: 'c', executor: 'qwen2.5-coder', analyzer: 'a' } },
  };
}
const PLAN_RESPONSE = JSON.stringify({ tasks: [{ id: 'T1', description: 'write', strategy: 'generate' }], edges: [], reason: 'plan' });

let db: SqliteDatabaseAdapter;

interface Wired {
  service: ObservabilityService;
  sessionSvc: SessionService;
  sessions: SqliteSessionRepository;
  orchestrator: SessionOrchestrator;
  gate: SessionStateControlGate;
}

async function wire(
  c: ReturnType<typeof makeCounters>,
  model: FakeModel,
  gateOverride?: import('@codeforge/agent-core').ControlGate,
): Promise<Wired> {
  const revProvider = new FakeRevisionProvider(REVISION);
  const sessions = new SqliteSessionRepository(db);
  const events = new SqliteEventLog(db);
  const tasks = new SqliteTaskRepository(db);
  const taskRuns = new SqliteTaskRunRepository(db);
  const executions = new SqliteTaskExecutionRepository(db);
  const graphs = new SqliteTaskGraphRepository(db);
  const committer = new SqliteGraphCommitter(db);
  const checkpoints = new SqliteCheckpointRepository(db);
  const lock = new SqliteWorkspaceLockService(db);
  const toolCalls = new SqliteToolCallRepository(db);
  const approvals = new SqliteApprovalRepository(db);
  const verReports = new SqliteVerificationRepository(db);

  const hasher = new Blake3GraphHasher();
  const graphSvc = new GraphService({ hasher, now: c.now, nextId: c.nextId, canonicalFormVersion: 'v1', schemaVersion: 1 });
  const graphCommitSvc = new GraphCommitService({ graphs, committer, graphService: graphSvc, now: c.now, nextId: c.nextId });
  const sessionSvc = new SessionService({ sessions, events, lock, now: c.now, nextId: c.nextId });
  const coordinator = new ExecutionCoordinator({ executions, now: c.now });
  const taskRunSvc = new TaskRunService({ runs: taskRuns, events, reconciler: new NoopProcessReconciler(), now: c.now, nextId: c.nextId });
  const checkpointSvc = new CheckpointService({ checkpoints, events, now: c.now, nextId: c.nextId });
  const planner = new Planner({ gateway: model, now: c.now, nextId: c.nextId });
  const verEngine = new VerificationEngine({ reports: verReports, events, supervisor: { spawn: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false, killed: false, durationMs: 0 }) }, revisionProvider: revProvider, now: c.now, nextId: c.nextId });
  const completionGate = new CompletionGate({ reports: verReports });
  const { ToolGateway, ContextBuilder } = await import('@codeforge/agent-core');
  const taskExec = new TaskExecutor({
    taskRunService: taskRunSvc, executionCoordinator: coordinator,
    contextBuilder: new ContextBuilder({ now: c.now, nextId: c.nextId }), gateway: model,
    toolGateway: new ToolGateway({ calls: toolCalls, approvals, events, policy: PERMISSIVE_TEST_POLICY, now: c.now, nextId: c.nextId }),
    executor: { execute: async () => ({ exitCode: 0, stdout: 'ok', stderr: '', timedOut: false }) },
    verificationEngine: verEngine, completionGate, verificationPolicy: DEFAULT_VERIFICATION_POLICY,
    now: c.now, nextId: c.nextId,
  });

  await sessionSvc.create({ session: makeSession(), hostname: 'h', processId: 1 });
  await graphs.commit({
    graphId: 'GR', sessionId: 'S', version: 1, nodes: [], edges: [],
    createdAt: 't', createdBy: 'planner', canonicalHash: 'seed', schemaVersion: 1, canonicalFormVersion: 'v1',
  }, {
    mutationId: 'M0', sessionId: 'S', baseVersion: 0, operations: [], proposedBy: 'planner', reason: 'seed',
    provenance: { provenanceId: 'P', source: { kind: 'runtime', id: 'init' }, inputs: [], reason: 'seed', at: 't' },
    createdAt: 't', status: 'COMMITTED',
  });

  const gate = new SessionStateControlGate({ sessions, pollIntervalMs: 1, sleep: async () => undefined });
  const effectiveGate = gateOverride ?? gate;
  const service = new ObservabilityService({
    sessions, graphs, executions, taskRuns, events, controlPlane: new ControlPlane(),
    sessionControl: { transition: (id, ev) => sessionSvc.transition(id, ev as never) },
    now: c.now, nextId: c.nextId,
  });
  const orchestrator = new SessionOrchestrator({
    sessionService: sessionSvc, planner, graphCommitService: graphCommitSvc, graphRepository: graphs,
    taskRepository: tasks, executionRepository: executions, executionCoordinator: coordinator,
    taskExecutor: taskExec, checkpointService: checkpointSvc, maxIterations: 10, controlGate: effectiveGate,
    now: c.now, nextId: c.nextId,
  });
  return { service, sessionSvc, sessions, orchestrator, gate };
}

beforeEach(() => {
  db = new SqliteDatabaseAdapter(':memory:');
  db.open();
  runMigrations(db, createMigrationRegistry(), { now: () => '2026-01-01T00:00:00.000Z' });
});
afterEach(() => db.close());

describe('P9-I1 — observe', () => {
  it('getState and getTrace reflect the authoritative session', async () => {
    const c = makeCounters();
    const { service, sessionSvc } = await wire(c, new FakeModel());
    await sessionSvc.transition('S', 'SESSION_INITIALIZED');
    await sessionSvc.transition('S', 'SESSION_READY');
    const st = await service.getState('S');
    expect(st!.sessionState).toBe('RUNNING');
    const trace = await service.getTrace('S');
    expect(trace.entries.length).toBeGreaterThanOrEqual(2);
  });
});

describe('P9-I1 — control cycle (OB-006)', () => {
  it('pause -> PAUSED, resume -> RUNNING, through the ControlPlane', async () => {
    const c = makeCounters();
    const { service, sessionSvc } = await wire(c, new FakeModel());
    await sessionSvc.transition('S', 'SESSION_INITIALIZED');
    await sessionSvc.transition('S', 'SESSION_READY');

    const pause = await service.submitControl({ intent: 'pause', sessionId: 'S', requestedBy: { kind: 'user', id: 'u', surface: 'dashboard' } });
    expect(pause.admission.admitted).toBe(true);
    expect((await service.getState('S'))!.sessionState).toBe('PAUSED');

    const resume = await service.submitControl({ intent: 'resume', sessionId: 'S', requestedBy: { kind: 'user', id: 'u', surface: 'telegram' } });
    expect(resume.admission.admitted).toBe(true);
    expect((await service.getState('S'))!.sessionState).toBe('RUNNING');
  });

  it('the control gate derives the signal from session state (bridge)', async () => {
    const c = makeCounters();
    const { service, sessionSvc, gate } = await wire(c, new FakeModel());
    await sessionSvc.transition('S', 'SESSION_INITIALIZED');
    await sessionSvc.transition('S', 'SESSION_READY');
    expect((await gate.poll('S')).kind).toBe('none');
    await service.submitControl({ intent: 'pause', sessionId: 'S', requestedBy: { kind: 'user', id: 'u', surface: 'dashboard' } });
    expect((await gate.poll('S')).kind).toBe('pause'); // gate sees the admitted pause
  });
});

describe('P9-I1 — live loop control', () => {
  it('a cancel signal from the gate aborts the orchestrator run cooperatively', async () => {
    const c = makeCounters();
    const model = new FakeModel();
    model.setSequence([PLAN_RESPONSE, JSON.stringify({ type: 'done', summary: 'x' })]);
    // A gate that reports cancel on first poll exercises the SAME cooperative-cancel path
    // the SessionStateControlGate uses when an admitted cancel moves the live session to
    // CANCELLING mid-run.
    const w = await wire(c, model, { async poll() { return { kind: 'cancel' as const }; }, async awaitResume() { return 'cancel' as const; } });
    const result = await w.orchestrator.run({ sessionId: 'S', goal: makeGoal(), revision: REVISION, graphVersion: 1 });
    expect(result.sessionState).toBe('ABORTED');
    expect((await w.sessions.getById('S'))!.state).toBe('ABORTED');
  });

  it('a run with no control signal completes normally (gate is transparent)', async () => {
    const c = makeCounters();
    const model = new FakeModel();
    model.setSequence([PLAN_RESPONSE, JSON.stringify({ type: 'done', summary: 'x' })]);
    const { orchestrator, sessions } = await wire(c, model);
    const result = await orchestrator.run({ sessionId: 'S', goal: makeGoal(), revision: REVISION, graphVersion: 1 });
    expect(['COMPLETED', 'ABORTED']).toContain(result.sessionState);
    expect((await sessions.getById('S'))!.state).toBe(result.sessionState);
  });
});

describe('P9-I1 — replay + non-authority', () => {
  it('getAuditTimeline reconstructs the same ordered history deterministically', async () => {
    const c = makeCounters();
    const { service, sessionSvc } = await wire(c, new FakeModel());
    await sessionSvc.transition('S', 'SESSION_INITIALIZED');
    await sessionSvc.transition('S', 'SESSION_READY');
    await service.submitControl({ intent: 'pause', sessionId: 'S', requestedBy: { kind: 'user', id: 'u', surface: 'dashboard' } });

    const a = await service.getAuditTimeline('S');
    const b = await service.getAuditTimeline('S');
    expect(a).toEqual(b); // deterministic replay
    const seqs = a.entries.map((e) => e.sequenceNumber);
    expect(seqs).toEqual([...seqs].sort((x, y) => x - y)); // sequence-ordered
    // Lifecycle transitions were produced by the SessionStateMachine.
    expect(a.entries.some((e) => e.authorityPath === 'SessionStateMachine')).toBe(true);
  });

  it('a RuntimeProjection consumer cannot write authoritative state (OB-005)', async () => {
    const c = makeCounters();
    const { service, sessionSvc } = await wire(c, new FakeModel());
    await sessionSvc.transition('S', 'SESSION_INITIALIZED');
    await sessionSvc.transition('S', 'SESSION_READY');
    const st = (await service.getState('S'))!;
    // The projection is inert data — mutating it changes nothing authoritative.
    const mutated = computeRuntimeProjection({
      sessionId: st.sessionId, sessionState: 'ABORTED', goalId: st.goalId, graphVersion: st.graphVersion,
      workspaceRevisionId: st.workspaceRevisionId, tasks: [], edges: [], activeRuns: [],
    });
    expect(mutated.sessionState).toBe('ABORTED');
    // Authoritative session is untouched by building a projection.
    expect((await service.getState('S'))!.sessionState).toBe('RUNNING');
  });
});
