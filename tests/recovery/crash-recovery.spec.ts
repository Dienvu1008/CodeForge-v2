// P1-CR1 Crash recovery — CrashRecoveryService (CP-004/005/006).
//
// On restart the runtime reconciles unfinished TaskRuns instead of assuming they failed:
//   - CP-004: unfinished (RUNNING) runs are marked INTERRUPTED, never FAILED.
//   - CP-005: the process tree is reconciled first; if an orphan remains, recovery aborts.
//   - CP-006: after recovery no run is left in a live/orphan state.
//   - CP-012: the loaded checkpoint reports drift when the workspace hash changed.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  SqliteDatabaseAdapter,
  SqliteTaskRunRepository,
  SqliteTaskRepository,
  SqliteCheckpointRepository,
  SqliteEventLog,
  runMigrations,
  createMigrationRegistry,
} from '@codeforge/infrastructure';
import {
  CrashRecoveryService,
  CheckpointService,
  TaskRunService,
  NoopProcessReconciler,
} from '@codeforge/agent-core';
import type {
  Task,
  TaskRun,
  WorkspaceRevision,
  ChangeRecord,
  CaptureInput,
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
  hash: 'HASH-1',
  fileCount: 0,
  totalBytes: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  createdBy: { sessionId: 'S', reason: 'session_start' },
};

const CHANGE: ChangeRecord = {
  changeId: 'chg1',
  sessionId: 'S',
  kind: 'modify',
  relpath: 'src/a.ts',
  ownedBy: 'agent',
  inScratchZone: false,
  at: '2026-01-01T00:00:00.000Z',
};

let db: SqliteDatabaseAdapter;
let runs: SqliteTaskRunRepository;
let checkpoints: SqliteCheckpointRepository;
let events: SqliteEventLog;

function seedSession(): void {
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
function capture(over: Partial<CaptureInput> = {}): CaptureInput {
  return {
    sessionId: 'S',
    graphVersion: 1,
    workspaceRevision: REVISION,
    agentChangeSet: [CHANGE],
    sessionState: 'RUNNING',
    taskStates: { T1: 'RUNNING' },
    budgetState: 'ACTIVE',
    lastEventId: 'E-1',
    capturedAt: '2026-01-01T00:00:05.000Z',
    schemaVersion: 1,
    ...over,
  };
}

function makeTaskRuns(reconciler: ProcessReconciler = new NoopProcessReconciler()): TaskRunService {
  let n = 0;
  return new TaskRunService({
    runs,
    events,
    reconciler,
    now: () => '2026-01-01T00:01:00.000Z',
    nextId: () => `RID-${n++}`,
  });
}
function makeCheckpoints(): CheckpointService {
  let n = 0;
  return new CheckpointService({
    checkpoints,
    events,
    now: () => '2026-01-01T00:00:10.000Z',
    nextId: () => `CID-${n++}`,
  });
}
function makeRecovery(taskRuns: TaskRunService, cps: CheckpointService): CrashRecoveryService {
  return new CrashRecoveryService({ runs, checkpoints: cps, taskRuns });
}

beforeEach(async () => {
  db = new SqliteDatabaseAdapter(':memory:');
  db.open();
  runMigrations(db, createMigrationRegistry(), { now: () => '2026-01-01T00:00:00.000Z' });
  seedSession();
  await new SqliteTaskRepository(db).create(task('T1'));
  runs = new SqliteTaskRunRepository(db);
  checkpoints = new SqliteCheckpointRepository(db);
  events = new SqliteEventLog(db);
});
afterEach(() => db.close());

describe('CrashRecoveryService.recover — CP-004 reconcile, do not assume failed', () => {
  it('marks an unfinished RUNNING run INTERRUPTED (never FAILED)', async () => {
    const taskRuns = makeTaskRuns();
    await taskRuns.start(run());

    const report = await makeRecovery(taskRuns, makeCheckpoints()).recover({
      sessionId: 'S',
      currentHash: 'HASH-1',
      reconciledRevision: REVISION,
    });

    expect(report.interruptedRuns).toEqual(['R1']);
    const sealed = await runs.getById('R1');
    expect(sealed?.state).toBe('INTERRUPTED');
    expect(sealed?.state).not.toBe('FAILED');
  });

  it('leaves no RUNNING run behind after recovery (CP-006)', async () => {
    const taskRuns = makeTaskRuns();
    await taskRuns.start(run());
    await taskRuns.start(run({ taskRunId: 'R2' }));

    await makeRecovery(taskRuns, makeCheckpoints()).recover({
      sessionId: 'S',
      currentHash: 'HASH-1',
      reconciledRevision: REVISION,
    });

    expect(await runs.findRunning('S')).toHaveLength(0);
  });

  it('recovers finished runs as a no-op (nothing to interrupt)', async () => {
    const taskRuns = makeTaskRuns();
    await taskRuns.start(run());
    await taskRuns.finalize('R1', 'RUN_SUCCEEDED', REVISION);

    const report = await makeRecovery(taskRuns, makeCheckpoints()).recover({
      sessionId: 'S',
      currentHash: 'HASH-1',
      reconciledRevision: REVISION,
    });

    expect(report.interruptedRuns).toEqual([]);
    expect((await runs.getById('R1'))?.state).toBe('SUCCEEDED');
  });
});

describe('CrashRecoveryService.recover — CP-005 orphan process gate', () => {
  it('aborts when the process tree still has an orphan (does not seal the run)', async () => {
    const orphaned: ProcessReconciler = {
      async reconcile(): Promise<ReconcileResult> {
        return { reconciled: false, killedPids: [], orphanPids: [4242] };
      },
    };
    const taskRuns = makeTaskRuns(orphaned);
    await taskRuns.start(run());

    await expect(
      makeRecovery(taskRuns, makeCheckpoints()).recover({
        sessionId: 'S',
        currentHash: 'HASH-1',
        reconciledRevision: REVISION,
      }),
    ).rejects.toMatchObject({ code: 'UNRECONCILED_FINALIZE' });

    // The run must stay RUNNING — recovery is not allowed to lose the orphan (CP-005/006).
    expect((await runs.getById('R1'))?.state).toBe('RUNNING');
  });
});

describe('CrashRecoveryService.recover — checkpoint load + CP-012 drift', () => {
  it('reports the loaded checkpoint with drift=false when the hash matches', async () => {
    const cps = makeCheckpoints();
    await cps.capture(capture(), 'HASH-1');
    const taskRuns = makeTaskRuns();

    const report = await makeRecovery(taskRuns, cps).recover({
      sessionId: 'S',
      currentHash: 'HASH-1',
      reconciledRevision: REVISION,
    });

    expect(report.checkpoint?.checkpoint.graphVersion).toBe(1);
    expect(report.drift).toBe(false);
  });

  it('reports drift=true when the workspace hash changed since the checkpoint (CP-012)', async () => {
    const cps = makeCheckpoints();
    await cps.capture(capture(), 'HASH-1');
    const taskRuns = makeTaskRuns();

    const report = await makeRecovery(taskRuns, cps).recover({
      sessionId: 'S',
      currentHash: 'HASH-CHANGED',
      reconciledRevision: REVISION,
    });

    expect(report.drift).toBe(true);
  });

  it('returns a null checkpoint when the session never checkpointed', async () => {
    const report = await makeRecovery(makeTaskRuns(), makeCheckpoints()).recover({
      sessionId: 'S',
      currentHash: 'HASH-1',
      reconciledRevision: REVISION,
    });
    expect(report.checkpoint).toBeNull();
    expect(report.drift).toBe(false);
  });
});

describe('CrashRecoveryService — CP-003 deterministic', () => {
  it('produces the same interrupted-run set across identical recoveries', async () => {
    const taskRuns = makeTaskRuns();
    await taskRuns.start(run());
    await taskRuns.start(run({ taskRunId: 'R2' }));

    const first = await makeRecovery(taskRuns, makeCheckpoints()).recover({
      sessionId: 'S',
      currentHash: 'HASH-1',
      reconciledRevision: REVISION,
    });
    // A second recovery finds nothing running (idempotent).
    const second = await makeRecovery(taskRuns, makeCheckpoints()).recover({
      sessionId: 'S',
      currentHash: 'HASH-1',
      reconciledRevision: REVISION,
    });

    expect(first.interruptedRuns).toEqual(['R1', 'R2']);
    expect(second.interruptedRuns).toEqual([]);
  });
});
