// P1-T3 TaskRun — TaskRunStateMachine + TaskRunService (EX-001/004/005, SM-TASK-RUN §5).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  SqliteDatabaseAdapter,
  SqliteTaskRunRepository,
  SqliteTaskRepository,
  SqliteEventLog,
  runMigrations,
  createMigrationRegistry,
} from '@codeforge/infrastructure';
import {
  TaskRunService,
  TaskRunError,
  NoopProcessReconciler,
  transitionTaskRun,
  isTaskRunTerminal,
} from '@codeforge/agent-core';
import type {
  Task,
  TaskRun,
  TaskRunState,
  WorkspaceRevision,
  ProcessReconciler,
  ReconcileResult,
} from '@codeforge/agent-core';

const REVISION: WorkspaceRevision = {
  revisionId: 'rev',
  canonicalFormVersion: 'v1',
  root: '/r',
  includedPaths: [],
  excludedScratchPaths: [],
  hashAlgorithm: 'blake3',
  hash: 'deadbeef',
  fileCount: 0,
  totalBytes: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  createdBy: { sessionId: 'S', reason: 'session_start' },
};

// ---- pure state machine ----
describe('transitionTaskRun — SM-TASK-RUN §5', () => {
  it('RUNNING -> each terminal state via its event', () => {
    expect(transitionTaskRun('RUNNING', 'RUN_SUCCEEDED')).toMatchObject({ ok: true, next: 'SUCCEEDED' });
    expect(transitionTaskRun('RUNNING', 'RUN_FAILED')).toMatchObject({ ok: true, next: 'FAILED' });
    expect(transitionTaskRun('RUNNING', 'RUN_TIMEOUT')).toMatchObject({ ok: true, next: 'TIMEOUT' });
    expect(transitionTaskRun('RUNNING', 'RUN_CANCELLED')).toMatchObject({ ok: true, next: 'CANCELLED' });
    expect(transitionTaskRun('RUNNING', 'RUN_INTERRUPTED')).toMatchObject({ ok: true, next: 'INTERRUPTED' });
  });

  it('terminal states are absorbing (EX-L12)', () => {
    for (const s of ['SUCCEEDED', 'FAILED', 'TIMEOUT', 'CANCELLED', 'INTERRUPTED'] as TaskRunState[]) {
      expect(transitionTaskRun(s, 'RUN_SUCCEEDED')).toMatchObject({ ok: false, code: 'TERMINAL_STATE' });
      expect(isTaskRunTerminal(s)).toBe(true);
    }
    expect(isTaskRunTerminal('RUNNING')).toBe(false);
  });
});

// ---- service integration ----
let db: SqliteDatabaseAdapter;
let runs: SqliteTaskRunRepository;
let events: SqliteEventLog;

function seed(): void {
  db.execute(
    `INSERT INTO sessions
      (session_id, workspace_id, workspace_root, goal_id, graph_version, state,
       created_at, updated_at, runtime_version, schema_version, budget_id, lock_id, metadata_json)
     VALUES ('S','W','/r','G',1,'RUNNING','t','t','0.1.0',1,'B','L','{}')`,
  );
}
function task(id: string): Task {
  return {
    taskId: id,
    description: 'd',
    acceptanceCriteria: [],
    constraints: [],
    priority: 0,
    strategy: { kind: 'generate' },
    createdAt: '2026-01-01T00:00:00.000Z',
    createdBy: 'planner',
  };
}
function run(overrides: Partial<TaskRun> = {}): TaskRun {
  return {
    taskRunId: 'R1',
    taskId: 'T1',
    sessionId: 'S',
    attemptNumber: 1,
    state: 'RUNNING',
    graphVersionAtStart: 1,
    workspaceRevisionAtStart: REVISION,
    strategyUsed: { kind: 'generate' },
    startedAt: '2026-01-01T00:00:00.000Z',
    toolCalls: [],
    failures: [],
    budgetConsumed: { wallClockMs: 0, modelTokens: 0, toolCalls: 0, recoveryAttempts: 0 },
    ...overrides,
  };
}
function makeService(reconciler: ProcessReconciler = new NoopProcessReconciler()): TaskRunService {
  let n = 0;
  return new TaskRunService({
    runs,
    events,
    reconciler,
    now: () => '2026-01-01T00:01:00.000Z',
    nextId: () => `ID-${n++}`,
  });
}

beforeEach(async () => {
  db = new SqliteDatabaseAdapter(':memory:');
  db.open();
  runMigrations(db, createMigrationRegistry(), { now: () => '2026-01-01T00:00:00.000Z' });
  seed();
  await new SqliteTaskRepository(db).create(task('T1'));
  runs = new SqliteTaskRunRepository(db);
  events = new SqliteEventLog(db);
});
afterEach(() => db.close());

describe('TaskRunService.start — EX-004 anchors', () => {
  it('creates a RUNNING run and emits TASK_RUN_STARTED', async () => {
    const svc = makeService();
    await svc.start(run());
    expect((await runs.getById('R1'))?.state).toBe('RUNNING');
    expect((await events.query({ sessionId: 'S' })).map((e) => e.type)).toEqual(['TASK_RUN_STARTED']);
  });

  it('rejects a run missing the workspaceRevision anchor (EX-004)', async () => {
    const svc = makeService();
    const bad = run({ workspaceRevisionAtStart: undefined as unknown as WorkspaceRevision });
    await expect(svc.start(bad)).rejects.toBeInstanceOf(TaskRunError);
    await expect(svc.start(bad)).rejects.toMatchObject({ code: 'MISSING_ANCHOR' });
  });
});

describe('TaskRunService.finalize — EX-005 reconcile gate + EX-001', () => {
  it('finalizes SUCCEEDED after reconcile, writes end revision (EX-L14)', async () => {
    const svc = makeService();
    await svc.start(run());
    const state = await svc.finalize('R1', 'RUN_SUCCEEDED', REVISION, { verificationId: 'V1' });
    expect(state).toBe('SUCCEEDED');
    const got = await runs.getById('R1');
    expect(got?.state).toBe('SUCCEEDED');
    expect(got?.workspaceRevisionAtEnd?.revisionId).toBe('rev');
    expect(got?.verificationId).toBe('V1');
  });

  it('blocks finalize when the process tree is not reconciled (EX-005)', async () => {
    const orphaned: ProcessReconciler = {
      async reconcile(): Promise<ReconcileResult> {
        return { reconciled: false, killedPids: [], orphanPids: [4242] };
      },
    };
    const svc = makeService(orphaned);
    await svc.start(run());
    await expect(svc.finalize('R1', 'RUN_TIMEOUT', REVISION)).rejects.toMatchObject({
      code: 'UNRECONCILED_FINALIZE',
    });
    // Run stays RUNNING (not sealed).
    expect((await runs.getById('R1'))?.state).toBe('RUNNING');
  });

  it('rejects a second finalize (EX-001, immutable after finalize)', async () => {
    const svc = makeService();
    await svc.start(run());
    await svc.finalize('R1', 'RUN_FAILED', REVISION);
    await expect(svc.finalize('R1', 'RUN_SUCCEEDED', REVISION)).rejects.toMatchObject({
      code: 'INVALID_TRANSITION',
    });
  });

  it('finalizeInterrupted seals a run as INTERRUPTED (EX-L13 crash path)', async () => {
    const svc = makeService();
    await svc.start(run());
    const state = await svc.finalizeInterrupted('R1', REVISION);
    expect(state).toBe('INTERRUPTED');
    expect((await runs.getById('R1'))?.state).toBe('INTERRUPTED');
  });

  it('finalize on a missing run throws NOT_FOUND', async () => {
    const svc = makeService();
    await expect(svc.finalize('NOPE', 'RUN_SUCCEEDED', REVISION)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});
