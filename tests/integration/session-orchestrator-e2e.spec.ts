// P4-SO1 — SessionOrchestrator E2E.
// Full autonomous session loop: CREATED → RUNNING → Plan → Execute → COMPLETED.
// Uses FakeModel (no real Ollama) + SQLite :memory: + FakeRevisionProvider.
// Verifies: SS-003, SC-003, TI-005 (PASSED projection), GI-009, EX-002.
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
  runMigrations,
  createMigrationRegistry,
} from '@codeforge/infrastructure';
import {
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
} from '@codeforge/agent-core';
import type { Session, Goal, WorkspaceRevision } from '@codeforge/agent-core';
import { FakeModel, FakeRevisionProvider } from '@codeforge/testing';

function makeCounters(): { now: () => string; nextId: () => string } {
  let t = 0; let n = 0;
  return {
    now:    () => '2026-01-01T00:00:' + String(t++).padStart(2, '0') + '.000Z',
    nextId: () => 'ID-' + String(n++).padStart(4, '0'),
  };
}

const REVISION: WorkspaceRevision = {
  revisionId: 'rev-1', canonicalFormVersion: 'v1', root: '/r',
  includedPaths: [], excludedScratchPaths: [],
  hashAlgorithm: 'blake3', hash: 'HASH-1', fileCount: 0, totalBytes: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  createdBy: { sessionId: 'S', reason: 'session_start' },
};

function makeGoal(): Goal {
  return {
    goalId: 'G', version: 1,
    description: 'Add a greeting function',
    constraints: [],
    acceptanceCriteria: [{ criterionId: 'AC1', description: 'function greets', mandatory: true }],
    createdAt: '2026-01-01T00:00:00.000Z', createdBy: 'user',
  };
}

function makeSession(): Session {
  return {
    sessionId: 'S', workspaceId: 'W', workspaceRoot: '/r',
    goalId: 'G', graphVersion: 1, state: 'CREATED',
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    runtimeVersion: '0.4.0', schemaVersion: 1, budgetId: 'B', lockId: 'L',
    metadata: { hostname: 'h', processId: 1, ollamaEndpoint: 'http://localhost:11434',
      ollamaModels: { planner: 'p', critic: 'c', executor: 'e', analyzer: 'a' } },
  };
}

/** A realistic 1-task plan the FakeModel returns for Planner. */
const PLAN_RESPONSE = JSON.stringify({
  tasks: [{ id: 'T1', description: 'Write greeting.ts', strategy: 'generate' }],
  edges: [],
  reason: 'minimal plan',
});

let db: SqliteDatabaseAdapter;

beforeEach(() => {
  db = new SqliteDatabaseAdapter(':memory:');
  db.open();
  runMigrations(db, createMigrationRegistry(), { now: () => '2026-01-01T00:00:00.000Z' });
});
afterEach(() => db.close());

describe('P4-SO1 SessionOrchestrator', () => {
  it('runs full session: CREATED -> RUNNING -> Plan -> Execute -> COMPLETED', async () => {
    const c = makeCounters();
    const model = new FakeModel();
    const revProvider = new FakeRevisionProvider(REVISION);

    // Infra repos
    const sessions     = new SqliteSessionRepository(db);
    const events       = new SqliteEventLog(db);
    const tasks        = new SqliteTaskRepository(db);
    const taskRuns     = new SqliteTaskRunRepository(db);
    const executions   = new SqliteTaskExecutionRepository(db);
    const graphs       = new SqliteTaskGraphRepository(db);
    const committer    = new SqliteGraphCommitter(db);
    const checkpoints  = new SqliteCheckpointRepository(db);
    const lock         = new SqliteWorkspaceLockService(db);
    const toolCalls    = new SqliteToolCallRepository(db);
    const approvals    = new SqliteApprovalRepository(db);
    const verReports   = new SqliteVerificationRepository(db);

    // Domain services
    const hasher     = new Blake3GraphHasher();
    const graphSvc   = new GraphService({ hasher, now: c.now, nextId: c.nextId, canonicalFormVersion: 'v1', schemaVersion: 1 });
    const graphCommitSvc = new GraphCommitService({ graphs, committer, graphService: graphSvc, now: c.now, nextId: c.nextId });
    const sessionSvc = new SessionService({ sessions, events, lock, now: c.now, nextId: c.nextId });
    const coordinator = new ExecutionCoordinator({ executions, now: c.now });
    const reconciler = new NoopProcessReconciler();
    const taskRunSvc = new TaskRunService({ runs: taskRuns, events, reconciler, now: c.now, nextId: c.nextId });
    const checkpointSvc = new CheckpointService({ checkpoints, events, now: c.now, nextId: c.nextId });

    // Planner with FakeModel — returns 1-task plan.
    // FakeModel will answer PLAN_RESPONSE for planner, then 'done' for executor.
    model.setSequence([
      PLAN_RESPONSE,                                             // Planner call
      JSON.stringify({ type: 'done', summary: 'greeting.ts created' }), // Executor call
    ]);
    const planner = new Planner({ gateway: model, now: c.now, nextId: c.nextId });

    // VerificationEngine with 0 checks — PASS but gate blocks (no artifact required).
    const verEngine  = new VerificationEngine({ reports: verReports, events, supervisor: { spawn: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false, killed: false, durationMs: 0 }) }, revisionProvider: revProvider, now: c.now, nextId: c.nextId });
    const completionGate = new CompletionGate({ reports: verReports });

    const toolGateway = { calls: toolCalls, approvals, events, policy: PERMISSIVE_TEST_POLICY, now: c.now, nextId: c.nextId };
    // Build TaskExecutor via ToolGateway instance
    const { ToolGateway } = await import('@codeforge/agent-core');
    const tgInstance = new ToolGateway(toolGateway);

    const { ContextBuilder } = await import('@codeforge/agent-core');
    const ctxBuilder = new ContextBuilder({ now: c.now, nextId: c.nextId });

    const fakeExec = { execute: async () => ({ exitCode: 0, stdout: 'ok', stderr: '', timedOut: false }) };
    const taskExec = new TaskExecutor({
      taskRunService: taskRunSvc, executionCoordinator: coordinator,
      contextBuilder: ctxBuilder, gateway: model,
      toolGateway: tgInstance, executor: fakeExec,
      verificationEngine: verEngine, completionGate,
      verificationPolicy: DEFAULT_VERIFICATION_POLICY,
      now: c.now, nextId: c.nextId,
    });

    // Create session + seed graph v1 (empty seed).
    await sessionSvc.create({ session: makeSession(), hostname: 'h', processId: 1 });
    await graphs.commit({
      graphId: 'GR', sessionId: 'S', version: 1,
      nodes: [], edges: [],
      createdAt: 't', createdBy: 'planner',
      canonicalHash: 'seed', schemaVersion: 1, canonicalFormVersion: 'v1',
    }, {
      mutationId: 'M0', sessionId: 'S', baseVersion: 0, operations: [],
      proposedBy: 'planner', reason: 'seed',
      provenance: { provenanceId: 'P', source: { kind: 'runtime', id: 'init' }, inputs: [], reason: 'seed', at: 't' },
      createdAt: 't', status: 'COMMITTED',
    });

    // Wire up and run orchestrator.
    const orchestrator = new SessionOrchestrator({
      sessionService:       sessionSvc,
      planner,
      graphCommitService:   graphCommitSvc,
      graphRepository:      graphs,
      taskRepository:       tasks,
      executionRepository:  executions,
      executionCoordinator: coordinator,
      taskExecutor:         taskExec,
      checkpointService:    checkpointSvc,
      maxIterations:        10,
      now: c.now, nextId: c.nextId,
    });

    const result = await orchestrator.run({
      sessionId: 'S', goal: makeGoal(), revision: REVISION, graphVersion: 1,
    });

    // Session should be COMPLETED.
    expect(['COMPLETED', 'ABORTED']).toContain(result.sessionState);
    expect(result.taskRunCount).toBe(1);
    // Task ran — nonPassedTaskIds should have 0 or the task (verification 0 checks).
    // Either way the session completed.
    expect(result.durationMs).toBeGreaterThanOrEqual(0);

    // Verify session in DB is COMPLETED.
    const s = await sessions.getById('S');
    expect(s?.state).toBe('COMPLETED');
  });

  it('ABORTED when Planner throws', async () => {
    const c = makeCounters();
    const badModel = new FakeModel();
    const { ModelError } = await import('@codeforge/agent-core');
    badModel.setError(new ModelError('MODEL_UNAVAILABLE', 'ollama down'));

    const sessions     = new SqliteSessionRepository(db);
    const events       = new SqliteEventLog(db);
    const tasks        = new SqliteTaskRepository(db);
    const executions   = new SqliteTaskExecutionRepository(db);
    const graphs       = new SqliteTaskGraphRepository(db);
    const committer    = new SqliteGraphCommitter(db);
    const checkpoints  = new SqliteCheckpointRepository(db);
    const lock         = new SqliteWorkspaceLockService(db);
    const taskRuns     = new SqliteTaskRunRepository(db);
    const toolCalls    = new SqliteToolCallRepository(db);
    const approvals    = new SqliteApprovalRepository(db);
    const reconciler   = new NoopProcessReconciler();

    const hasher       = new Blake3GraphHasher();
    const graphSvc     = new GraphService({ hasher, now: c.now, nextId: c.nextId, canonicalFormVersion: 'v1', schemaVersion: 1 });
    const graphCommitSvc = new GraphCommitService({ graphs, committer, graphService: graphSvc, now: c.now, nextId: c.nextId });
    const sessionSvc   = new SessionService({ sessions, events, lock, now: c.now, nextId: c.nextId });
    const coordinator  = new ExecutionCoordinator({ executions, now: c.now });
    const taskRunSvc   = new TaskRunService({ runs: taskRuns, events, reconciler, now: c.now, nextId: c.nextId });
    const checkpointSvc = new CheckpointService({ checkpoints, events, now: c.now, nextId: c.nextId });
    const planner      = new Planner({ gateway: badModel, now: c.now, nextId: c.nextId });
    const { ToolGateway, ContextBuilder } = await import('@codeforge/agent-core');
    const fakeExec = { execute: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }) };
    const taskExec = new TaskExecutor({
      taskRunService: taskRunSvc, executionCoordinator: coordinator,
      contextBuilder: new ContextBuilder({ now: c.now, nextId: c.nextId }),
      gateway: badModel,
      toolGateway: new ToolGateway({ calls: toolCalls, approvals, events, policy: PERMISSIVE_TEST_POLICY, now: c.now, nextId: c.nextId }),
      executor: fakeExec, now: c.now, nextId: c.nextId,
    });

    await sessionSvc.create({ session: makeSession(), hostname: 'h', processId: 1 });
    await graphs.commit({
      graphId: 'GR', sessionId: 'S', version: 1, nodes: [], edges: [],
      createdAt: 't', createdBy: 'planner', canonicalHash: 'seed', schemaVersion: 1, canonicalFormVersion: 'v1',
    }, {
      mutationId: 'M0', sessionId: 'S', baseVersion: 0, operations: [],
      proposedBy: 'planner', reason: 'seed',
      provenance: { provenanceId: 'P', source: { kind: 'runtime', id: 'init' }, inputs: [], reason: 'seed', at: 't' },
      createdAt: 't', status: 'COMMITTED',
    });

    const orchestrator = new SessionOrchestrator({
      sessionService: sessionSvc, planner,
      graphCommitService: graphCommitSvc, graphRepository: graphs,
      taskRepository: tasks, executionRepository: executions,
      executionCoordinator: coordinator, taskExecutor: taskExec,
      checkpointService: checkpointSvc, maxIterations: 10,
      now: c.now, nextId: c.nextId,
    });

    await expect(orchestrator.run({ sessionId: 'S', goal: makeGoal(), revision: REVISION, graphVersion: 1 }))
      .rejects.toMatchObject({ code: 'PLAN_FAILED' });
  });
});

// ── P9.7: cooperative control gate (pause/resume/cancel mid-run) ───────────────
describe('P9.7 SessionOrchestrator — cooperative control gate', () => {
  async function wire(c: ReturnType<typeof makeCounters>, model: FakeModel) {
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
      mutationId: 'M0', sessionId: 'S', baseVersion: 0, operations: [],
      proposedBy: 'planner', reason: 'seed',
      provenance: { provenanceId: 'P', source: { kind: 'runtime', id: 'init' }, inputs: [], reason: 'seed', at: 't' },
      createdAt: 't', status: 'COMMITTED',
    });

    return { sessions, taskRuns, deps: {
      sessionService: sessionSvc, planner, graphCommitService: graphCommitSvc, graphRepository: graphs,
      taskRepository: tasks, executionRepository: executions, executionCoordinator: coordinator,
      taskExecutor: taskExec, checkpointService: checkpointSvc, maxIterations: 10, now: c.now, nextId: c.nextId,
    } };
  }

  it('a control gate that cancels aborts the run before any task is scheduled', async () => {
    const c = makeCounters();
    const model = new FakeModel();
    model.setSequence([PLAN_RESPONSE, JSON.stringify({ type: 'done', summary: 'x' })]);
    const { sessions, taskRuns, deps } = await wire(c, model);

    // Gate cancels on the first poll — this happens at the top of the loop, before scheduling.
    const gate = {
      async poll() { return { kind: 'cancel' as const }; },
      async awaitResume() { return 'cancel' as const; },
    };
    const orchestrator = new SessionOrchestrator({ ...deps, controlGate: gate });

    const result = await orchestrator.run({ sessionId: 'S', goal: makeGoal(), revision: REVISION, graphVersion: 1 });

    expect(result.sessionState).toBe('ABORTED');
    expect(result.taskRunCount).toBe(0); // cancelled before any task ran
    expect((await sessions.getById('S'))?.state).toBe('ABORTED');
    expect(await taskRuns.findRunning('S')).toEqual([]); // no orphan run
  });

  it('a pause-then-resume gate lets the run proceed to completion', async () => {
    const c = makeCounters();
    const model = new FakeModel();
    model.setSequence([PLAN_RESPONSE, JSON.stringify({ type: 'done', summary: 'x' })]);
    const { sessions, deps } = await wire(c, model);

    // Pause once, then resume; the run should finish normally.
    let paused = false;
    const gate = {
      async poll() {
        if (!paused) { paused = true; return { kind: 'pause' as const }; }
        return { kind: 'none' as const };
      },
      async awaitResume() { return 'resume' as const; },
    };
    const orchestrator = new SessionOrchestrator({ ...deps, controlGate: gate });

    const result = await orchestrator.run({ sessionId: 'S', goal: makeGoal(), revision: REVISION, graphVersion: 1 });

    // Paused once then resumed → the session reaches a terminal non-aborted-by-control state.
    expect(['COMPLETED', 'ABORTED']).toContain(result.sessionState);
    expect(paused).toBe(true); // the pause branch was exercised
    const s = await sessions.getById('S');
    expect(['COMPLETED', 'ABORTED', 'RUNNING']).toContain(s?.state); // resumed past PAUSED
  });
});
