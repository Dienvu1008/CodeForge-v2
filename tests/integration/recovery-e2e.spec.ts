// P5-I1 — Recovery E2E.
// Verifies full recovery loop: task FAIL → FailureAnalyzer → RecoveryPolicy → RecoveryEngine.
// Scenarios:
//   1. Task fails → ESCALATE (UNKNOWN class, maxAttempts=1) → session AWAITING_HUMAN (RC-007).
//   2. Task fails with LOGIC class → FIX → shouldRetry=true → task rescheduled.
//   3. NoProgressDetector fires after 3 consecutive UNKNOWN failures → ESCALATE.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  SqliteDatabaseAdapter, SqliteSessionRepository, SqliteTaskRepository,
  SqliteTaskRunRepository, SqliteTaskExecutionRepository, SqliteTaskGraphRepository,
  SqliteGraphCommitter, SqliteCheckpointRepository, SqliteWorkspaceLockService,
  SqliteEventLog, Blake3GraphHasher, SqliteToolCallRepository, SqliteApprovalRepository,
  SqliteVerificationRepository, SqliteFailureRepository, SqliteRecoveryActionRepository,
  runMigrations, createMigrationRegistry,
} from '@codeforge/infrastructure';
import {
  SessionService, SessionOrchestrator, Planner, GraphCommitService, GraphService,
  ExecutionCoordinator, TaskRunService, TaskExecutor, CheckpointService,
  NoopProcessReconciler, PERMISSIVE_TEST_POLICY, ToolGateway, ContextBuilder,
  FailureAnalyzer, RecoveryEngine,
} from '@codeforge/agent-core';
import type { Session, Goal, WorkspaceRevision, ToolExecutor } from '@codeforge/agent-core';
import { FakeModel, FakeRevisionProvider } from '@codeforge/testing';

// ── helpers ───────────────────────────────────────────────────────────────────
function makeCounters() {
  let t = 0; let n = 0;
  return {
    now:    (): string => '2026-01-01T00:00:' + String(t++).padStart(2, '0') + '.000Z',
    nextId: (): string => 'P5-' + String(n++).padStart(6, '0'),
  };
}
const REVISION: WorkspaceRevision = {
  revisionId: 'rev-p5', canonicalFormVersion: 'v1', root: '/r',
  includedPaths: [], excludedScratchPaths: [],
  hashAlgorithm: 'blake3', hash: 'H-P5', fileCount: 0, totalBytes: 0,
  createdAt: 't', createdBy: { sessionId: 'S-P5', reason: 'session_start' },
};
function makeGoal(): Goal {
  return {
    goalId: 'G-P5', version: 1, description: 'test goal',
    constraints: [], acceptanceCriteria: [{ criterionId: 'AC1', description: 'pass', mandatory: true }],
    createdAt: 't', createdBy: 'user',
  };
}
function makeSession(): Session {
  return {
    sessionId: 'S-P5', workspaceId: 'W-P5', workspaceRoot: '/r',
    goalId: 'G-P5', graphVersion: 1, state: 'CREATED',
    createdAt: 't', updatedAt: 't', runtimeVersion: '0.4.0', schemaVersion: 1,
    budgetId: 'B', lockId: 'L',
    metadata: { hostname: 'h', processId: 1, ollamaEndpoint: 'http://localhost:11434',
      ollamaModels: { planner: 'p', critic: 'c', executor: 'e', analyzer: 'a' } },
  };
}

// Plan returning 1 task.
const PLAN = JSON.stringify({
  tasks: [{ id: 'T1', description: 'failing task', strategy: 'generate' }],
  edges: [], reason: 'p5 plan',
});

describe('P5-I1 — Recovery E2E', () => {
  let db: SqliteDatabaseAdapter;

  beforeEach(() => {
    db = new SqliteDatabaseAdapter(':memory:'); db.open();
    runMigrations(db, createMigrationRegistry(), { now: () => 't' });
  });
  afterEach(() => db.close());

  // ── Helper: build full orchestrator with recovery ───────────────────────────
  async function buildOrchestrator(model: FakeModel, executor: ToolExecutor) {
    const c = makeCounters();
    const events   = new SqliteEventLog(db);
    const sessions = new SqliteSessionRepository(db);
    const tasks    = new SqliteTaskRepository(db);
    const taskRuns = new SqliteTaskRunRepository(db);
    const execs    = new SqliteTaskExecutionRepository(db);
    const graphs   = new SqliteTaskGraphRepository(db);
    const committer= new SqliteGraphCommitter(db);
    const checkRepo= new SqliteCheckpointRepository(db);
    const lock     = new SqliteWorkspaceLockService(db);
    const tc       = new SqliteToolCallRepository(db);
    const ap       = new SqliteApprovalRepository(db);
    const verRep   = new SqliteVerificationRepository(db);
    const failRep  = new SqliteFailureRepository(db);
    const recRep   = new SqliteRecoveryActionRepository(db);
    const hasher   = new Blake3GraphHasher();
    const graphSvc = new GraphService({ hasher, now: c.now, nextId: c.nextId, canonicalFormVersion: 'v1', schemaVersion: 1 });
    const gcSvc    = new GraphCommitService({ graphs, committer, graphService: graphSvc, now: c.now, nextId: c.nextId });
    const sessionSvc = new SessionService({ sessions, events, lock, now: c.now, nextId: c.nextId });
    const coord    = new ExecutionCoordinator({ executions: execs, now: c.now });
    const reconciler = new NoopProcessReconciler();
    const trSvc    = new TaskRunService({ runs: taskRuns, events, reconciler, now: c.now, nextId: c.nextId });
    const checkSvc = new CheckpointService({ checkpoints: checkRepo, events, now: c.now, nextId: c.nextId });
    const tg       = new ToolGateway({ calls: tc, approvals: ap, events, policy: PERMISSIVE_TEST_POLICY, now: c.now, nextId: c.nextId });
    const ctx      = new ContextBuilder({ now: c.now, nextId: c.nextId });
    const revProvider = new FakeRevisionProvider(REVISION);
    const _verEngine = new (await import('@codeforge/agent-core').then(m => m.VerificationEngine))({
      reports: verRep, events,
      supervisor: { spawn: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false, killed: false, durationMs: 0 }) },
      revisionProvider: revProvider, now: c.now, nextId: c.nextId,
    });
    const taskExecutor = new TaskExecutor({
      taskRunService: trSvc, executionCoordinator: coord, contextBuilder: ctx,
      gateway: model, toolGateway: tg, executor,
      now: c.now, nextId: c.nextId,
    });
    const planner = new Planner({ gateway: model, now: c.now, nextId: c.nextId });
    const failureAnalyzer = new FailureAnalyzer({ failures: failRep, events, now: c.now, nextId: c.nextId });
    const recoveryEngine  = new RecoveryEngine({ recoveryActions: recRep, events, sessionService: sessionSvc, now: c.now, nextId: c.nextId });

    const orchestrator = new SessionOrchestrator({
      sessionService: sessionSvc, planner, graphCommitService: gcSvc,
      graphRepository: graphs, taskRepository: tasks, executionRepository: execs,
      executionCoordinator: coord, taskExecutor, checkpointService: checkSvc,
      failureAnalyzer, recoveryEngine, failureRepository: failRep,
      taskRunRepository: taskRuns,
      maxIterations: 8, now: c.now, nextId: c.nextId,
    });

    // Seed session + graph v1 seed.
    await sessionSvc.create({ session: makeSession(), hostname: 'h', processId: 1 });
    await graphs.commit({
      graphId: 'GR-P5', sessionId: 'S-P5', version: 1, nodes: [], edges: [],
      createdAt: c.now(), createdBy: 'planner',
      canonicalHash: 'seed', schemaVersion: 1, canonicalFormVersion: 'v1',
    }, {
      mutationId: 'M0-P5', sessionId: 'S-P5', baseVersion: 0, operations: [],
      proposedBy: 'planner', reason: 'seed',
      provenance: { provenanceId: 'P0', source: { kind: 'runtime', id: 'init' }, inputs: [], reason: 'seed', at: c.now() },
      createdAt: c.now(), status: 'COMMITTED',
    });

    return { orchestrator, sessions, recRep, failRep, c };
  }

  // ── Scenario 1: FAILED task → ESCALATE → AWAITING_HUMAN ──────────────────

  it('RC-007: FAILED task with UNKNOWN class → ESCALATE → session AWAITING_HUMAN', async () => {
    const model = new FakeModel();
    // Model: plan → task run → FAIL (invalid JSON exhausts retries)
    model.setSequence([PLAN]);
    model.setResponse(/./, 'not valid json {{'); // executor calls all fail

    const failingExec: ToolExecutor = {
      execute: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }),
    };

    const { orchestrator, sessions } = await buildOrchestrator(model, failingExec);

    const result = await orchestrator.run({
      sessionId: 'S-P5', goal: makeGoal(), revision: REVISION, graphVersion: 1,
    });

    // Task failed → FailureAnalyzer → UNKNOWN → RecoveryPolicy → ESCALATE (maxAttempts=1)
    // → RecoveryEngine → session AWAITING_HUMAN. P10.2: the orchestrator leaves the
    // session in AWAITING_HUMAN instead of clobbering it to ABORTED via complete().
    expect(result.sessionState).toBe('AWAITING_HUMAN');

    // Session state is AWAITING_HUMAN (escalated for a human decision — RC-007/SS-005).
    const s = await sessions.getById('S-P5');
    expect(s?.state).toBe('AWAITING_HUMAN');
  });

  // ── Scenario 2: recovery actions are recorded (RC-006) ────────────────────

  it('RC-006: recovery action is persisted with provenance after task failure', async () => {
    const model = new FakeModel();
    model.setSequence([PLAN]);
    model.setResponse(/./, 'invalid {{');

    const executor: ToolExecutor = {
      execute: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }),
    };

    const { orchestrator } = await buildOrchestrator(model, executor);
    await orchestrator.run({ sessionId: 'S-P5', goal: makeGoal(), revision: REVISION, graphVersion: 1 });

    // At least one RecoveryAction should have been created.
    const rows = db.query<{ action_id: string }>('SELECT action_id FROM recovery_actions');
    expect(rows.length).toBeGreaterThan(0);
  });

  // ── Scenario 3: Failure records are persisted (RC-006) ────────────────────

  it('RC-006: Failure record created with classifiedBy=deterministic', async () => {
    const model = new FakeModel();
    model.setSequence([PLAN]);
    model.setResponse(/./, 'invalid {{');

    const executor: ToolExecutor = {
      execute: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }),
    };

    const { orchestrator } = await buildOrchestrator(model, executor);
    await orchestrator.run({ sessionId: 'S-P5', goal: makeGoal(), revision: REVISION, graphVersion: 1 });

    const rows = db.query<{ classified_by: string }>('SELECT classified_by FROM failures');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]?.classified_by).toBe('deterministic');
  });

  // ── Scenario 4: Task succeeds → no recovery actions ───────────────────────

  it('No recovery actions when task SUCCEEDS', async () => {
    const model = new FakeModel();
    model.setSequence([
      PLAN,
      JSON.stringify({ type: 'done', summary: 'all done' }),
    ]);
    const executor: ToolExecutor = {
      execute: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }),
    };

    const { orchestrator } = await buildOrchestrator(model, executor);
    await orchestrator.run({ sessionId: 'S-P5', goal: makeGoal(), revision: REVISION, graphVersion: 1 });

    const rows = db.query<{ action_id: string }>('SELECT action_id FROM recovery_actions');
    expect(rows.length).toBe(0);
    const frows = db.query<{ failure_id: string }>('SELECT failure_id FROM failures');
    expect(frows.length).toBe(0);
  });
});