// P1-I1 — Session lifecycle E2E with FakeModel (PHASE_1_ROADMAP §4.7).
//
// Drives the WHOLE runtime kernel end-to-end over REAL services + real SQLite (:memory:),
// no mocks except FakeModel (the LLM boundary) and NoopProcessReconciler (no real
// processes exist in Phase 1). Happy path:
//
//   create session (lock) → Goal v1 → TaskGraph v2 with 2 tasks (B depends_on A) →
//   Scheduler picks the ready root → FakeModel emits a no-op tool call → TaskRun
//   RUNNING → finalize SUCCEEDED → projection VERIFYING → verification stub PASS →
//   Task PASSED. Repeat for the dependent task once its dep PASSED. Checkpoint captured.
//   All tasks terminal → Session COMPLETED → workspace lock released.
//
// Verifies: every state transition holds its invariant (SS/GL/TI/GI/SC/SM/EX/CP), the
// EventLog accumulates the full lifecycle with a monotonic sequence (CP-008), and the
// checkpoint round-trips consistently (CP-002/012).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  SqliteDatabaseAdapter,
  SqliteSessionRepository,
  SqliteGoalRepository,
  SqliteTaskRepository,
  SqliteTaskRunRepository,
  SqliteTaskExecutionRepository,
  SqliteTaskGraphRepository,
  SqliteGraphCommitter,
  SqliteBudgetRepository,
  SqliteCheckpointRepository,
  SqliteWorkspaceLockService,
  SqliteEventLog,
  Blake3GraphHasher,
  runMigrations,
  createMigrationRegistry,
} from '@codeforge/infrastructure';
import {
  SessionService,
  GoalService,
  TaskService,
  GraphService,
  GraphCommitService,
  ExecutionCoordinator,
  TaskRunService,
  CheckpointService,
  NoopProcessReconciler,
  computeSchedule,
  transitionTask,
} from '@codeforge/agent-core';
import type {
  Session,
  Goal,
  Task,
  TaskRun,
  TaskGraph,
  TaskState,
  GraphMutation,
  GraphOperation,
  Budget,
  WorkspaceRevision,
  Provenance,
  ModelRequest,
} from '@codeforge/agent-core';
import { FakeModel } from '@codeforge/testing';

// ── deterministic sources (no wall-clock / no random) ────────────────────────
function makeCounters(): { now: () => string; nextId: () => string } {
  let t = 0;
  let n = 0;
  return {
    now: () => `2026-01-01T00:00:${String(t++).padStart(2, '0')}.000Z`,
    nextId: () => `ID-${String(n++).padStart(4, '0')}`,
  };
}

const REVISION: WorkspaceRevision = {
  revisionId: 'rev-1',
  canonicalFormVersion: 'v1',
  root: '/r',
  includedPaths: [],
  excludedScratchPaths: [],
  hashAlgorithm: 'blake3',
  hash: 'HASH-1',
  fileCount: 0,
  totalBytes: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  createdBy: { sessionId: 'S', reason: 'session_start' },
};

const PROVENANCE: Provenance = {
  provenanceId: 'P',
  source: { kind: 'model', id: 'planner' },
  inputs: [],
  reason: 'plan',
  at: '2026-01-01T00:00:00.000Z',
};

function goal(): Goal {
  return {
    goalId: 'G',
    version: 1,
    description: 'ship the feature',
    constraints: [],
    acceptanceCriteria: [
      { criterionId: 'AC1', description: 'builds', mandatory: true },
    ],
    createdAt: '2026-01-01T00:00:00.000Z',
    createdBy: 'user',
  };
}

function session(): Session {
  return {
    sessionId: 'S',
    workspaceId: 'W',
    workspaceRoot: '/r',
    goalId: 'G',
    graphVersion: 1,
    state: 'CREATED',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    runtimeVersion: '0.1.0',
    schemaVersion: 1,
    budgetId: 'B',
    lockId: 'L',
    metadata: {
      hostname: 'h',
      processId: 1,
      ollamaEndpoint: 'http://localhost:11434',
      ollamaModels: { planner: 'p', critic: 'c', executor: 'e', analyzer: 'a' },
    },
  };
}

function sessionBudget(): Budget {
  return {
    budgetId: 'B',
    scope: 'session',
    scopeId: 'S',
    limits: { wallClockMs: 1_000_000, modelTokens: 1_000_000, toolCalls: 1000, recoveryAttempts: 10 },
    consumed: { wallClockMs: 0, modelTokens: 0, toolCalls: 0, recoveryAttempts: 0 },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function task(id: string): Task {
  return {
    taskId: id,
    description: `task ${id}`,
    acceptanceCriteria: [],
    constraints: [],
    priority: 0,
    strategy: { kind: 'generate' },
    createdAt: '2026-01-01T00:00:00.000Z',
    createdBy: 'planner',
  };
}

function mutation(ops: GraphOperation[], baseVersion: number, id: string): GraphMutation {
  return {
    mutationId: id,
    sessionId: 'S',
    baseVersion,
    operations: ops,
    proposedBy: 'planner',
    reason: 'plan v1',
    provenance: PROVENANCE,
    createdAt: '2026-01-01T00:00:00.000Z',
    status: 'PROPOSED',
  };
}

function run(taskId: string, runId: string): TaskRun {
  return {
    taskRunId: runId,
    taskId,
    sessionId: 'S',
    attemptNumber: 1,
    state: 'RUNNING',
    graphVersionAtStart: 2,
    workspaceRevisionAtStart: REVISION,
    strategyUsed: { kind: 'generate' },
    startedAt: '2026-01-01T00:00:00.000Z',
    toolCalls: [],
    failures: [],
    budgetConsumed: { wallClockMs: 0, modelTokens: 0, toolCalls: 0, recoveryAttempts: 0 },
  };
}

// ── kernel wiring ────────────────────────────────────────────────────────────
let db: SqliteDatabaseAdapter;
let events: SqliteEventLog;
let sessions: SqliteSessionRepository;
let graphs: SqliteTaskGraphRepository;
let runs: SqliteTaskRunRepository;
let budgets: SqliteBudgetRepository;
let checkpointsRepo: SqliteCheckpointRepository;

let sessionSvc: SessionService;
let goalSvc: GoalService;
let taskSvc: TaskService;
let graphSvc: GraphService;
let graphCommit: GraphCommitService;
let exec: ExecutionCoordinator;
let taskRunSvc: TaskRunService;
let checkpointSvc: CheckpointService;
let model: FakeModel;
let runId = 0;

beforeEach(() => {
  db = new SqliteDatabaseAdapter(':memory:');
  db.open();
  runMigrations(db, createMigrationRegistry(), { now: () => '2026-01-01T00:00:00.000Z' });

  events = new SqliteEventLog(db);
  sessions = new SqliteSessionRepository(db);
  graphs = new SqliteTaskGraphRepository(db);
  runs = new SqliteTaskRunRepository(db);
  budgets = new SqliteBudgetRepository(db);
  checkpointsRepo = new SqliteCheckpointRepository(db);

  const c = makeCounters();
  sessionSvc = new SessionService({
    sessions,
    events,
    lock: new SqliteWorkspaceLockService(db),
    now: c.now,
    nextId: c.nextId,
  });
  goalSvc = new GoalService({ goals: new SqliteGoalRepository(db), events, sessionId: 'S', now: c.now, nextId: c.nextId });
  taskSvc = new TaskService({ tasks: new SqliteTaskRepository(db), events, sessionId: 'S', now: c.now, nextId: c.nextId });
  graphSvc = new GraphService({
    hasher: new Blake3GraphHasher(),
    now: c.now,
    nextId: c.nextId,
    canonicalFormVersion: 'v1',
    schemaVersion: 1,
  });
  graphCommit = new GraphCommitService({
    graphs,
    committer: new SqliteGraphCommitter(db),
    graphService: graphSvc,
    now: c.now,
    nextId: c.nextId,
  });
  exec = new ExecutionCoordinator({ executions: new SqliteTaskExecutionRepository(db), now: c.now });
  taskRunSvc = new TaskRunService({ runs, events, reconciler: new NoopProcessReconciler(), now: c.now, nextId: c.nextId });
  checkpointSvc = new CheckpointService({ checkpoints: checkpointsRepo, events, now: c.now, nextId: c.nextId });
  model = new FakeModel();
  runId = 0;
});
afterEach(() => db.close());

/**
 * Drive one task through the full happy-path lifecycle:
 * READY → RUNNING (FakeModel no-op tool call + TaskRun) → SUCCEEDED → VERIFYING →
 * verification stub PASS → PASSED. Persists state via the ExecutionCoordinator projection
 * and asserts each pure state-machine gate holds.
 */
async function runTaskToPassed(taskId: string): Promise<void> {
  // PENDING → READY (SC-003 satisfied): the scheduler must have chosen this task.
  const toReady = transitionTask('PENDING', 'DEPS_SATISFIED');
  expect(toReady).toMatchObject({ ok: true, next: 'READY' });
  await exec.setState(taskId, 'READY');

  // READY → RUNNING (SM: SCHEDULED). Record the run in the projection (EX-002).
  const toRunning = transitionTask('READY', 'SCHEDULED');
  expect(toRunning).toMatchObject({ ok: true, next: 'RUNNING' });

  // FakeModel produces a deterministic no-op tool call (UNTRUSTED raw output — the runtime
  // does not act on it beyond driving the run lifecycle; there is no ToolGateway in Phase 1).
  const req: ModelRequest = {
    purpose: 'execute',
    systemPrompt: 'system',
    taskPrompt: `execute ${taskId}`,
    maxOutputTokens: 100,
    temperature: 0,
  };
  model.setResponse(/execute/, JSON.stringify({ tool: 'noop', args: {} }));
  const resp = await model.generate(req);
  expect(JSON.parse(resp.raw)).toMatchObject({ tool: 'noop' });

  const rid = `R-${runId++}`;
  await taskRunSvc.start(run(taskId, rid));
  await exec.onRunStarted(taskId, rid);
  expect((await exec.get(taskId))?.currentState).toBe('RUNNING');

  // RUN_SUCCEEDED → SUCCEEDED (reconcile gate passes via NoopProcessReconciler, EX-005).
  const finalState = await taskRunSvc.finalize(rid, 'RUN_SUCCEEDED', REVISION);
  expect(finalState).toBe('SUCCEEDED');

  // Run ended normally → projection VERIFYING (SM-L1: never RUNNING→PASSED directly).
  const afterRun = await exec.onRunEnded(taskId, rid, 'SUCCEEDED');
  expect(afterRun.currentState).toBe('VERIFYING');

  // Verification stub PASS: a valid + fresh report gates VERIFYING → PASSED (SM-002).
  const toPassed = transitionTask('VERIFYING', 'VERIFICATION_PASSED', { reportValid: true, fresh: true });
  expect(toPassed).toMatchObject({ ok: true, next: 'PASSED' });
  await exec.setState(taskId, 'PASSED');
  expect((await exec.get(taskId))?.currentState).toBe('PASSED');
}

describe('P1-I1 — session lifecycle E2E (FakeModel)', () => {
  it('drives create → plan → schedule → run → verify → complete with all invariants holding', async () => {
    // 1) Session-scoped budget (no event) + create session FIRST so the session row exists
    //    before any session-scoped event is appended (events FK-reference sessions).
    await budgets.create(sessionBudget());
    // 2) Create session: acquires the workspace lock (SS-001) and persists (state CREATED).
    await sessionSvc.create({ session: session(), hostname: 'h', processId: 1 });
    // 3) Goal v1 (GL-001/002/003) — emits GOAL_CREATED scoped to the now-existing session.
    await goalSvc.create(goal());
    // 4) CREATED → INITIALIZING → RUNNING (SS-002).
    await sessionSvc.transition('S', 'SESSION_INITIALIZED');
    await sessionSvc.transition('S', 'SESSION_READY');
    expect((await sessions.getById('S'))?.state).toBe('RUNNING');

    // 4) Two tasks (TI-001). Dependencies live ONLY as graph edges (TI-003), never on Task.
    await taskSvc.create(task('A'));
    await taskSvc.create(task('B'));

    // Seed an empty v1 graph so getCurrent works, then commit v2 with the real plan (GI-002/008).
    const seed: TaskGraph = {
      graphId: 'G',
      sessionId: 'S',
      version: 1,
      nodes: [],
      edges: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      createdBy: 'planner',
      canonicalHash: 'seed',
      schemaVersion: 1,
      canonicalFormVersion: 'v1',
    };
    await graphs.commit(seed, mutation([], 0, 'M-seed'));

    // B depends_on A → A must PASS before B is READY (SC-003).
    const commit = await graphCommit.commit(
      mutation(
        [
          { kind: 'ADD_TASK', task: task('A') },
          { kind: 'ADD_TASK', task: task('B') },
          { kind: 'ADD_EDGE', fromTaskId: 'B', toTaskId: 'A', edgeKind: 'depends_on' },
        ],
        1,
        'M-plan',
      ),
    );
    expect(commit.status).toBe('COMMITTED');
    expect(commit.version).toBe(2);

    const graph = await graphs.getCurrent('S');
    expect(graph.version).toBe(2);
    expect(graph.canonicalHash).toBe(graphSvc.canonicalHashOf(graph)); // GI-001 consistent

    // 5) Init projections (PENDING) for both tasks.
    await exec.init('A');
    await exec.init('B');

    // 6) Scheduler: only A is ready (B blocked on A). Deterministic next = 'A' (SC-001/006).
    const states = new Map<string, TaskState>([
      ['A', 'PENDING'],
      ['B', 'PENDING'],
    ]);
    const decision1 = computeSchedule({ nodes: graph.nodes, edges: graph.edges, states });
    expect(decision1.newlyReady).toEqual(['A']); // B not ready — dep A not PASSED
    // Move A to READY, then it is the only schedulable task.
    states.set('A', 'READY');
    expect(computeSchedule({ nodes: graph.nodes, edges: graph.edges, states }).next).toBe('A');

    // 7) Run A → PASSED.
    await runTaskToPassed('A');
    states.set('A', 'PASSED');

    // 8) Checkpoint after A PASSED (CP-002). Round-trips with no drift (CP-012).
    const cp = await checkpointSvc.capture(
      {
        sessionId: 'S',
        graphVersion: 2,
        workspaceRevision: REVISION,
        agentChangeSet: [],
        sessionState: 'RUNNING',
        taskStates: { A: 'PASSED', B: 'PENDING' },
        budgetState: 'ACTIVE',
        lastEventId: 'E-last',
        capturedAt: '2026-01-01T00:00:30.000Z',
        schemaVersion: 1,
      },
      'HASH-1',
    );
    const loaded = await checkpointSvc.load('S', 'HASH-1');
    expect(loaded?.checkpoint.checkpointId).toBe(cp.checkpointId);
    expect(loaded?.drift).toBe(false);
    expect(loaded?.checkpoint.taskStates).toEqual({ A: 'PASSED', B: 'PENDING' });

    // 9) Now B becomes ready (dep A PASSED, SC-003).
    const decision2 = computeSchedule({ nodes: graph.nodes, edges: graph.edges, states });
    expect(decision2.newlyReady).toEqual(['B']);
    await runTaskToPassed('B');
    states.set('B', 'PASSED');

    // 10) All tasks terminal → Session COMPLETED (SS-003). Non-terminal would be rejected.
    const allTerminal = [...states.values()].every((s) => s === 'PASSED');
    expect(allTerminal).toBe(true);
    const completed = await sessionSvc.complete('S', allTerminal);
    expect(completed.state).toBe('COMPLETED');
    expect((await sessions.getById('S'))?.state).toBe('COMPLETED');
  });

  it('rejects completing the session while a task is still non-terminal (SS-003)', async () => {
    await budgets.create(sessionBudget());
    await sessionSvc.create({ session: session(), hostname: 'h', processId: 1 });
    await goalSvc.create(goal());
    await sessionSvc.transition('S', 'SESSION_INITIALIZED');
    await sessionSvc.transition('S', 'SESSION_READY');

    await expect(sessionSvc.complete('S', false)).rejects.toMatchObject({
      code: 'PREMATURE_COMPLETION',
    });
    expect((await sessions.getById('S'))?.state).toBe('RUNNING');
  });

  it('accumulates the full lifecycle in the EventLog with a monotonic sequence (CP-008)', async () => {
    await budgets.create(sessionBudget());
    await sessionSvc.create({ session: session(), hostname: 'h', processId: 1 });
    await goalSvc.create(goal());
    await sessionSvc.transition('S', 'SESSION_INITIALIZED');
    await sessionSvc.transition('S', 'SESSION_READY');
    await taskSvc.create(task('A'));

    const seed: TaskGraph = {
      graphId: 'G',
      sessionId: 'S',
      version: 1,
      nodes: [],
      edges: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      createdBy: 'planner',
      canonicalHash: 'seed',
      schemaVersion: 1,
      canonicalFormVersion: 'v1',
    };
    await graphs.commit(seed, mutation([], 0, 'M-seed'));
    await graphCommit.commit(mutation([{ kind: 'ADD_TASK', task: task('A') }], 1, 'M-plan'));

    await exec.init('A');
    await runTaskToPassed('A');
    await sessionSvc.complete('S', true);

    const evs = await events.query({ sessionId: 'S' });
    const types = evs.map((e) => e.type);
    // The lifecycle backbone must all be present.
    expect(types).toContain('SESSION_CREATED');
    expect(types).toContain('GOAL_CREATED');
    expect(types).toContain('TASK_CREATED');
    expect(types).toContain('GRAPH_VERSION_CREATED');
    expect(types).toContain('GRAPH_MUTATION_COMMITTED');
    expect(types).toContain('TASK_RUN_STARTED');
    expect(types).toContain('TASK_RUN_ENDED');
    expect(types).toContain('SESSION_COMPLETED');

    // CP-008: the EventLog is the sequence authority — strictly increasing, gap-free.
    const seqs = evs.map((e) => e.sequenceNumber);
    expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, i) => i + 1));
  });

  it('releases the workspace lock on session completion (SS-006)', async () => {
    await budgets.create(sessionBudget());
    const lock = new SqliteWorkspaceLockService(db);
    await sessionSvc.create({ session: session(), hostname: 'h', processId: 1 });
    await goalSvc.create(goal());
    expect((await lock.getActive('W'))?.sessionId).toBe('S');

    await sessionSvc.transition('S', 'SESSION_INITIALIZED');
    await sessionSvc.transition('S', 'SESSION_READY');
    await sessionSvc.complete('S', true);

    // A completed session frees the workspace for a new session (SS-001/006).
    expect(await lock.getActive('W')).toBeNull();
  });
});
