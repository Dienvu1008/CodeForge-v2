// P1-I2 — Crash recovery E2E (PHASE_1_ROADMAP §4.7, CP-004/005/006/012).
//
// Models a REAL process crash + restart over a FILE-BACKED SQLite database (not :memory:,
// which would die with the connection). The flow:
//
//   process 1: create session (RUNNING) → plan a graph → start a TaskRun (left RUNNING =
//              mid-execution) → capture a checkpoint → "crash" (close the adapter and drop
//              every service reference WITHOUT finalizing the run).
//   process 2: open a NEW adapter over the SAME db file (restart), wire fresh services,
//              run CrashRecoveryService.recover().
//
// Verifies: the checkpoint survives and loads (CP-002/012), the unfinished run is
// reconciled to INTERRUPTED — never FAILED (CP-004) — via the process-reconcile gate
// (CP-005), no run is left RUNNING afterwards (CP-006), and the database has NO corruption
// (PRAGMA integrity_check) across the crash boundary. Runs identically on Windows + WSL.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  CrashRecoveryService,
  NoopProcessReconciler,
} from '@codeforge/agent-core';
import type {
  Session,
  Goal,
  Task,
  TaskRun,
  TaskGraph,
  GraphMutation,
  GraphOperation,
  Budget,
  WorkspaceRevision,
  Provenance,
  ProcessReconciler,
  ReconcileResult,
} from '@codeforge/agent-core';

function makeCounters(prefix: string): { now: () => string; nextId: () => string } {
  let t = 0;
  let n = 0;
  return {
    now: () => `2026-01-01T00:0${Math.floor(t / 60)}:${String((t++) % 60).padStart(2, '0')}.000Z`,
    nextId: () => `${prefix}-${String(n++).padStart(4, '0')}`,
  };
}

function revision(hash = 'HASH-1'): WorkspaceRevision {
  return {
    revisionId: `rev-${hash}`,
    canonicalFormVersion: 'v1',
    root: '/r',
    includedPaths: [],
    excludedScratchPaths: [],
    hashAlgorithm: 'blake3',
    hash,
    fileCount: 0,
    totalBytes: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    createdBy: { sessionId: 'S', reason: 'session_start' },
  };
}

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
    description: 'ship it',
    constraints: [],
    acceptanceCriteria: [{ criterionId: 'AC1', description: 'builds', mandatory: true }],
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
    limits: { wallClockMs: 1e6, modelTokens: 1e6, toolCalls: 1000, recoveryAttempts: 10 },
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
    reason: 'plan',
    provenance: PROVENANCE,
    createdAt: '2026-01-01T00:00:00.000Z',
    status: 'PROPOSED',
  };
}
function runningRun(taskId: string, runId: string): TaskRun {
  return {
    taskRunId: runId,
    taskId,
    sessionId: 'S',
    attemptNumber: 1,
    state: 'RUNNING',
    graphVersionAtStart: 2,
    workspaceRevisionAtStart: revision(),
    strategyUsed: { kind: 'generate' },
    startedAt: '2026-01-01T00:00:00.000Z',
    toolCalls: [],
    failures: [],
    budgetConsumed: { wallClockMs: 0, modelTokens: 0, toolCalls: 0, recoveryAttempts: 0 },
  };
}

/** All services wired over one adapter — a single "process" view of the kernel. */
interface Kernel {
  db: SqliteDatabaseAdapter;
  runs: SqliteTaskRunRepository;
  checkpointsRepo: SqliteCheckpointRepository;
  sessions: SqliteSessionRepository;
  graphs: SqliteTaskGraphRepository;
  sessionSvc: SessionService;
  goalSvc: GoalService;
  taskSvc: TaskService;
  graphCommit: GraphCommitService;
  exec: ExecutionCoordinator;
  taskRunSvc: TaskRunService;
  checkpointSvc: CheckpointService;
  recovery: (reconciler?: ProcessReconciler) => CrashRecoveryService;
}

/** Open a fresh adapter over `dbPath` and wire all services — a process "boot". */
function boot(dbPath: string, idPrefix: string, reconciler: ProcessReconciler = new NoopProcessReconciler()): Kernel {
  const db = new SqliteDatabaseAdapter(dbPath);
  db.open();
  runMigrations(db, createMigrationRegistry(), { now: () => '2026-01-01T00:00:00.000Z' }); // idempotent on restart

  const events = new SqliteEventLog(db);
  const sessions = new SqliteSessionRepository(db);
  const graphs = new SqliteTaskGraphRepository(db);
  const runs = new SqliteTaskRunRepository(db);
  const checkpointsRepo = new SqliteCheckpointRepository(db);
  const c = makeCounters(idPrefix);

  const graphSvc = new GraphService({
    hasher: new Blake3GraphHasher(),
    now: c.now,
    nextId: c.nextId,
    canonicalFormVersion: 'v1',
    schemaVersion: 1,
  });
  const taskRunSvc = new TaskRunService({ runs, events, reconciler, now: c.now, nextId: c.nextId });
  const checkpointSvc = new CheckpointService({ checkpoints: checkpointsRepo, events, now: c.now, nextId: c.nextId });

  return {
    db,
    runs,
    checkpointsRepo,
    sessions,
    graphs,
    sessionSvc: new SessionService({ sessions, events, lock: new SqliteWorkspaceLockService(db), now: c.now, nextId: c.nextId }),
    goalSvc: new GoalService({ goals: new SqliteGoalRepository(db), events, sessionId: 'S', now: c.now, nextId: c.nextId }),
    taskSvc: new TaskService({ tasks: new SqliteTaskRepository(db), events, sessionId: 'S', now: c.now, nextId: c.nextId }),
    graphCommit: new GraphCommitService({ graphs, committer: new SqliteGraphCommitter(db), graphService: graphSvc, now: c.now, nextId: c.nextId }),
    exec: new ExecutionCoordinator({ executions: new SqliteTaskExecutionRepository(db), now: c.now }),
    taskRunSvc,
    checkpointSvc,
    recovery: (rec: ProcessReconciler = reconciler) =>
      new CrashRecoveryService({
        runs,
        checkpoints: checkpointSvc,
        taskRuns: new TaskRunService({ runs, events, reconciler: rec, now: c.now, nextId: c.nextId }),
      }),
  };
}

/**
 * "Process 1": bring a session to mid-execution — a TaskRun left RUNNING (unfinished) and
 * a checkpoint captured before the crash. Returns nothing; the state lives in the db file.
 */
async function driveToMidExecution(dbPath: string, runId = 'R-1'): Promise<void> {
  const k = boot(dbPath, 'P1');
  await new SqliteBudgetRepository(k.db).create(sessionBudget());
  await k.sessionSvc.create({ session: session(), hostname: 'h', processId: 1 });
  await k.goalSvc.create(goal());
  await k.sessionSvc.transition('S', 'SESSION_INITIALIZED');
  await k.sessionSvc.transition('S', 'SESSION_READY');

  await k.taskSvc.create(task('A'));
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
  await k.graphs.commit(seed, mutation([], 0, 'M-seed'));
  await k.graphCommit.commit(mutation([{ kind: 'ADD_TASK', task: task('A') }], 1, 'M-plan'));

  await k.exec.init('A');
  await k.exec.setState('A', 'READY');
  await k.taskRunSvc.start(runningRun('A', runId)); // RUNNING — NOT finalized (mid-execution)
  await k.exec.onRunStarted('A', runId);

  // Checkpoint captures the mid-execution state (task A RUNNING) before the crash.
  await k.checkpointSvc.capture(
    {
      sessionId: 'S',
      graphVersion: 2,
      workspaceRevision: revision('HASH-1'),
      agentChangeSet: [],
      sessionState: 'RUNNING',
      taskStates: { A: 'RUNNING' },
      budgetState: 'ACTIVE',
      lastEventId: 'E-last',
      capturedAt: '2026-01-01T00:00:20.000Z',
      schemaVersion: 1,
    },
    'HASH-1',
  );

  // CRASH: drop the process without finalizing the run. Closing the adapter flushes WAL;
  // the run row stays RUNNING on disk (an orphan the next process must reconcile).
  k.db.close();
}

let dir: string;
let dbPath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cf2-crash-e2e-'));
  dbPath = join(dir, 'runtime.db');
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('P1-I2 — crash recovery E2E over a real db file', () => {
  it('recovers an unfinished run to INTERRUPTED after restart, no corruption (CP-004/006)', async () => {
    await driveToMidExecution(dbPath);

    // Sanity: the crashed process left exactly one RUNNING run on disk.
    const probe = boot(dbPath, 'PROBE');
    expect(await probe.runs.findRunning('S')).toHaveLength(1);
    probe.db.close();

    // RESTART: a brand-new process over the SAME file runs recovery.
    const restart = boot(dbPath, 'P2');
    const report = await restart.recovery().recover({
      sessionId: 'S',
      currentHash: 'HASH-1', // workspace unchanged since the checkpoint
      reconciledRevision: revision('HASH-1'),
    });

    // Checkpoint survived the crash and loaded (CP-002/012), no drift.
    expect(report.checkpoint?.checkpoint.graphVersion).toBe(2);
    expect(report.checkpoint?.checkpoint.taskStates).toEqual({ A: 'RUNNING' });
    expect(report.drift).toBe(false);

    // CP-004: the unfinished run is INTERRUPTED, NOT FAILED.
    expect(report.interruptedRuns).toEqual(['R-1']);
    const run = await restart.runs.getById('R-1');
    expect(run?.state).toBe('INTERRUPTED');
    expect(run?.state).not.toBe('FAILED');

    // CP-006: no run left RUNNING (no orphan state).
    expect(await restart.runs.findRunning('S')).toHaveLength(0);

    // No corruption across the crash boundary.
    expect(restart.db.integrityCheck().ok).toBe(true);
    restart.db.close();
  });

  it('reports drift so the caller must reconcile when the workspace changed while crashed (CP-012)', async () => {
    await driveToMidExecution(dbPath);

    const restart = boot(dbPath, 'P2');
    const report = await restart.recovery().recover({
      sessionId: 'S',
      currentHash: 'HASH-CHANGED', // workspace drifted during the crash window
      reconciledRevision: revision('HASH-CHANGED'),
    });

    expect(report.drift).toBe(true); // caller escalates / re-reconciles the workspace
    expect(report.interruptedRuns).toEqual(['R-1']); // the run is still reconciled
    expect((await restart.runs.getById('R-1'))?.state).toBe('INTERRUPTED');
    restart.db.close();
  });

  it('aborts recovery when an orphan process remains, leaving the run RUNNING (CP-005)', async () => {
    await driveToMidExecution(dbPath);

    const orphaned: ProcessReconciler = {
      async reconcile(): Promise<ReconcileResult> {
        return { reconciled: false, killedPids: [], orphanPids: [4242] };
      },
    };
    const restart = boot(dbPath, 'P2', orphaned);
    await expect(
      restart.recovery(orphaned).recover({
        sessionId: 'S',
        currentHash: 'HASH-1',
        reconciledRevision: revision('HASH-1'),
      }),
    ).rejects.toMatchObject({ code: 'UNRECONCILED_FINALIZE' });

    // The run must remain RUNNING — recovery is not allowed to seal it while an orphan lives.
    expect((await restart.runs.getById('R-1'))?.state).toBe('RUNNING');
    expect(restart.db.integrityCheck().ok).toBe(true); // still no corruption
    restart.db.close();
  });

  it('is a no-op when the run was already finalized before the crash (nothing to interrupt)', async () => {
    // process 1: finalize the run SUCCEEDED, THEN crash.
    const k = boot(dbPath, 'P1');
    await new SqliteBudgetRepository(k.db).create(sessionBudget());
    await k.sessionSvc.create({ session: session(), hostname: 'h', processId: 1 });
    await k.goalSvc.create(goal());
    await k.sessionSvc.transition('S', 'SESSION_INITIALIZED');
    await k.sessionSvc.transition('S', 'SESSION_READY');
    await k.taskSvc.create(task('A'));
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
    await k.graphs.commit(seed, mutation([], 0, 'M-seed'));
    await k.graphCommit.commit(mutation([{ kind: 'ADD_TASK', task: task('A') }], 1, 'M-plan'));
    await k.exec.init('A');
    await k.exec.setState('A', 'READY');
    await k.taskRunSvc.start(runningRun('A', 'R-1'));
    await k.taskRunSvc.finalize('R-1', 'RUN_SUCCEEDED', revision('HASH-1'));
    await k.checkpointSvc.capture(
      {
        sessionId: 'S',
        graphVersion: 2,
        workspaceRevision: revision('HASH-1'),
        agentChangeSet: [],
        sessionState: 'RUNNING',
        taskStates: { A: 'PASSED' },
        budgetState: 'ACTIVE',
        lastEventId: 'E-last',
        capturedAt: '2026-01-01T00:00:20.000Z',
        schemaVersion: 1,
      },
      'HASH-1',
    );
    k.db.close(); // crash

    const restart = boot(dbPath, 'P2');
    const report = await restart.recovery().recover({
      sessionId: 'S',
      currentHash: 'HASH-1',
      reconciledRevision: revision('HASH-1'),
    });

    expect(report.interruptedRuns).toEqual([]); // nothing was unfinished
    expect((await restart.runs.getById('R-1'))?.state).toBe('SUCCEEDED'); // untouched
    expect(report.checkpoint?.checkpoint.taskStates).toEqual({ A: 'PASSED' });
    expect(restart.db.integrityCheck().ok).toBe(true);
    restart.db.close();
  });
});
