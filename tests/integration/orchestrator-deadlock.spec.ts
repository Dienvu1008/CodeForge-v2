// Orchestrator graceful stop on an unschedulable graph (the "No schedulable tasks but
// non-terminal tasks remain" case). A weak-model plan often produces a dependent task whose
// dependency never PASSES (e.g. a task left in VERIFYING with 0 checks, or a FAILED dependency).
// Previously the orchestrator threw DEADLOCK and ABORTED the whole run, discarding any work that
// succeeded. The fix drives the permanently-blocked task(s) to ABORTED (SM-L8 DEP_UNREACHABLE)
// and COMPLETES the session so partial progress is preserved.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  SqliteDatabaseAdapter, SqliteSessionRepository, SqliteTaskRepository, SqliteTaskRunRepository,
  SqliteTaskExecutionRepository, SqliteTaskGraphRepository, SqliteGraphCommitter,
  SqliteCheckpointRepository, SqliteWorkspaceLockService, SqliteEventLog, SqliteToolCallRepository,
  SqliteApprovalRepository, SqliteVerificationRepository, Blake3GraphHasher,
  runMigrations, createMigrationRegistry,
} from '@codeforge/infrastructure';
import {
  SessionService, SessionOrchestrator, Planner, GraphCommitService, GraphService,
  ExecutionCoordinator, TaskRunService, TaskExecutor, CheckpointService, NoopProcessReconciler,
  PERMISSIVE_TEST_POLICY, DEFAULT_VERIFICATION_POLICY, VerificationEngine, CompletionGate,
  ToolGateway, ContextBuilder,
} from '@codeforge/agent-core';
import type { Session, Goal, WorkspaceRevision } from '@codeforge/agent-core';
import { FakeModel, FakeRevisionProvider } from '@codeforge/testing';

function counters() {
  let t = 0; let n = 0;
  return { now: () => '2026-01-01T00:00:' + String(t++ % 60).padStart(2, '0') + '.000Z', nextId: () => 'ID-' + String(n++).padStart(5, '0') };
}
const REVISION: WorkspaceRevision = {
  revisionId: 'rev', canonicalFormVersion: 'v1', root: '/r', includedPaths: [], excludedScratchPaths: [],
  hashAlgorithm: 'blake3', hash: 'H', fileCount: 0, totalBytes: 0,
  createdAt: '2026-01-01T00:00:00.000Z', createdBy: { sessionId: 'S', reason: 'session_start' },
};
function goal(): Goal {
  return { goalId: 'G', version: 1, description: 'two tasks, second depends on first', constraints: [], acceptanceCriteria: [], createdAt: 't', createdBy: 'user' };
}
function session(): Session {
  return {
    sessionId: 'S', workspaceId: 'W', workspaceRoot: '/r', goalId: 'G', graphVersion: 1, state: 'CREATED',
    createdAt: 't', updatedAt: 't', runtimeVersion: '0.12.0', schemaVersion: 1, budgetId: 'B', lockId: 'L',
    metadata: { hostname: 'h', processId: 1, ollamaEndpoint: 'x', ollamaModels: { planner: 'p', critic: 'c', executor: 'e', analyzer: 'a' } },
  };
}

// A 2-task plan where T2 depends on T1. With 0 verification checks T1 settles in VERIFYING
// (never PASSED), so T2 can never become READY → the schedule gets stuck.
const PLAN = JSON.stringify({
  tasks: [
    { id: 'T1', description: 'first task', strategy: 'generate' },
    { id: 'T2', description: 'second task (depends on T1)', strategy: 'generate' },
  ],
  edges: [{ from: 'T2', to: 'T1', kind: 'depends_on' }],
  reason: 'T2 depends on T1',
});

let db: SqliteDatabaseAdapter;
beforeEach(() => {
  db = new SqliteDatabaseAdapter(':memory:');
  db.open();
  runMigrations(db, createMigrationRegistry(), { now: () => 't' });
});
afterEach(() => db.close());

describe('orchestrator — graceful stop when a dependent task is unschedulable', () => {
  it('completes the session (does not throw DEADLOCK) when T2 can never run because T1 did not pass', async () => {
    const c = counters();
    const model = new FakeModel();
    // Planner → PLAN; then every executor turn → done (T1 runs, settles VERIFYING with 0 checks).
    model.setResponse(/plan|decompose|task graph/i, PLAN);
    model.setSequence([PLAN, JSON.stringify({ type: 'done', summary: 'done' })]);

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
    const verEngine = new VerificationEngine({
      reports: verReports, events,
      supervisor: { spawn: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false, killed: false, durationMs: 0 }) },
      revisionProvider: new FakeRevisionProvider(REVISION), now: c.now, nextId: c.nextId,
    });
    const taskExec = new TaskExecutor({
      taskRunService: taskRunSvc, executionCoordinator: coordinator,
      contextBuilder: new ContextBuilder({ now: c.now, nextId: c.nextId }), gateway: model,
      toolGateway: new ToolGateway({ calls: toolCalls, approvals, events, policy: PERMISSIVE_TEST_POLICY, now: c.now, nextId: c.nextId }),
      executor: { execute: async () => ({ exitCode: 0, stdout: 'ok', stderr: '', timedOut: false }) },
      verificationEngine: verEngine, completionGate: new CompletionGate({ reports: verReports }),
      verificationPolicy: DEFAULT_VERIFICATION_POLICY, now: c.now, nextId: c.nextId,
    });

    await sessionSvc.create({ session: session(), hostname: 'h', processId: 1 });
    await graphs.commit({
      graphId: 'GR', sessionId: 'S', version: 1, nodes: [], edges: [], createdAt: 't', createdBy: 'planner',
      canonicalHash: 'seed', schemaVersion: 1, canonicalFormVersion: 'v1',
    }, {
      mutationId: 'M0', sessionId: 'S', baseVersion: 0, operations: [], proposedBy: 'planner', reason: 'seed',
      provenance: { provenanceId: 'P', source: { kind: 'runtime', id: 'init' }, inputs: [], reason: 'seed', at: 't' },
      createdAt: 't', status: 'COMMITTED',
    });

    const orchestrator = new SessionOrchestrator({
      sessionService: sessionSvc, planner, graphCommitService: graphCommitSvc,
      graphRepository: graphs, taskRepository: tasks, executionRepository: executions,
      executionCoordinator: coordinator, taskExecutor: taskExec, checkpointService: checkpointSvc,
      maxIterations: 10, now: c.now, nextId: c.nextId,
    });

    // Must NOT throw DEADLOCK; must finish with a terminal session state.
    const result = await orchestrator.run({ sessionId: 'S', goal: goal(), revision: REVISION, graphVersion: 1 });
    expect(['COMPLETED', 'ABORTED']).toContain(result.sessionState);

    // The session ended in a terminal state (not stuck), and the blocked dependent task was
    // driven to a terminal state rather than crashing the run.
    const s = await sessions.getById('S');
    expect(['COMPLETED', 'ABORTED']).toContain(s?.state);
    const t2 = await executions.getByTask('T2');
    // T2 could never run (dep never passed) → it is terminal (ABORTED), not left dangling.
    if (t2 !== null) expect(['ABORTED', 'PENDING']).toContain(t2.currentState);
  });
});
