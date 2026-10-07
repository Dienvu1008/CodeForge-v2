// P10.6 — TaskExecutor progress events + control-at-tool-boundary.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  SqliteDatabaseAdapter,
  SqliteSessionRepository,
  SqliteTaskRepository,
  SqliteTaskRunRepository,
  SqliteTaskExecutionRepository,
  SqliteEventLog,
  SqliteToolCallRepository,
  SqliteApprovalRepository,
  SqliteWorkspaceLockService,
  runMigrations,
  createMigrationRegistry,
} from '@codeforge/infrastructure';
import {
  ExecutionCoordinator,
  TaskRunService,
  TaskExecutor,
  NoopProcessReconciler,
  ToolGateway,
  ContextBuilder,
  SessionService,
  PERMISSIVE_TEST_POLICY,
  type LoopControl,
  type Task,
  type Session,
  type WorkspaceRevision,
} from '@codeforge/agent-core';
import { FakeModel } from '@codeforge/testing';

function counters(): { now: () => string; nextId: () => string } {
  let t = 0; let n = 0;
  return {
    now: () => '2026-01-01T00:00:' + String(t++ % 60).padStart(2, '0') + '.000Z',
    nextId: () => 'ID-' + String(n++).padStart(5, '0'),
  };
}

const REVISION: WorkspaceRevision = {
  revisionId: 'rev-1', canonicalFormVersion: 'v1', root: '/r',
  includedPaths: [], excludedScratchPaths: [],
  hashAlgorithm: 'blake3', hash: 'H', fileCount: 0, totalBytes: 0,
  createdAt: '2026-01-01T00:00:00.000Z', createdBy: { sessionId: 'S', reason: 'session_start' },
};

const TASK: Task = {
  taskId: 'T1', description: 'do a thing', strategy: { kind: 'generate' },
  acceptanceCriteria: [], constraints: [], priority: 1,
  createdAt: '2026-01-01T00:00:00.000Z', createdBy: 'planner',
};

function makeSession(): Session {
  return {
    sessionId: 'S', workspaceId: 'W', workspaceRoot: '/r',
    goalId: 'G', graphVersion: 1, state: 'CREATED',
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    runtimeVersion: '0.10.0', schemaVersion: 1, budgetId: 'B', lockId: 'L',
    metadata: { hostname: 'h', processId: 1, ollamaEndpoint: 'http://localhost:11434',
      ollamaModels: { planner: 'p', critic: 'c', executor: 'e', analyzer: 'a' } },
  };
}

let db: SqliteDatabaseAdapter;
beforeEach(() => {
  db = new SqliteDatabaseAdapter(':memory:');
  db.open();
  runMigrations(db, createMigrationRegistry(), { now: () => '2026-01-01T00:00:00.000Z' });
});
afterEach(() => db.close());

async function build(c: ReturnType<typeof counters>, model: FakeModel, loopControl?: LoopControl) {
  const sessions = new SqliteSessionRepository(db);
  const events = new SqliteEventLog(db);
  const lock = new SqliteWorkspaceLockService(db);
  const sessionSvc = new SessionService({ sessions, events, lock, now: c.now, nextId: c.nextId });
  await sessionSvc.create({ session: makeSession(), hostname: 'h', processId: 1 });
  await new SqliteTaskRepository(db).create(TASK);

  const taskRuns = new SqliteTaskRunRepository(db);
  const executions = new SqliteTaskExecutionRepository(db);
  const toolCalls = new SqliteToolCallRepository(db);
  const approvals = new SqliteApprovalRepository(db);
  const coordinator = new ExecutionCoordinator({ executions, now: c.now });
  const runSvc = new TaskRunService({ runs: taskRuns, events, reconciler: new NoopProcessReconciler(), now: c.now, nextId: c.nextId });
  await coordinator.init('T1');

  const exec = new TaskExecutor({
    taskRunService: runSvc, executionCoordinator: coordinator,
    contextBuilder: new ContextBuilder({ now: c.now, nextId: c.nextId }), gateway: model,
    toolGateway: new ToolGateway({ calls: toolCalls, approvals, events, policy: PERMISSIVE_TEST_POLICY, now: c.now, nextId: c.nextId }),
    executor: { execute: async () => ({ exitCode: 0, stdout: 'ok', stderr: '', timedOut: false }) },
    events,
    ...(loopControl ? { loopControl } : {}),
    now: c.now, nextId: c.nextId,
  });
  return { exec, events };
}

async function run(exec: TaskExecutor): Promise<void> {
  await exec.execute({
    sessionId: 'S', task: TASK, attemptNumber: 1, graphVersion: 1,
    workspaceRevisionAtStart: REVISION, workspaceRevisionAtEnd: REVISION,
  });
}

describe('P10.6 TaskExecutor progress events', () => {
  it('emits MODEL_SELECTED + DECISION_REQUESTED/COMPLETED around the model call', async () => {
    const c = counters();
    const model = new FakeModel();
    model.setResponse(/./, JSON.stringify({ type: 'done', summary: 'done' }));
    const { exec, events } = await build(c, model);

    await run(exec);

    const types = (await events.query({ sessionId: 'S' })).map((e) => e.type);
    expect(types).toContain('MODEL_SELECTED');
    expect(types).toContain('DECISION_REQUESTED');
    expect(types).toContain('DECISION_COMPLETED');
    // MODEL_SELECTED comes before the first decision.
    expect(types.indexOf('MODEL_SELECTED')).toBeLessThan(types.indexOf('DECISION_REQUESTED'));
  });

  it('DECISION_COMPLETED carries the decision kind', async () => {
    const c = counters();
    const model = new FakeModel();
    model.setResponse(/./, JSON.stringify({ type: 'done', summary: 'ok' }));
    const { exec, events } = await build(c, model);

    await run(exec);

    const completed = (await events.query({ sessionId: 'S' })).find((e) => e.type === 'DECISION_COMPLETED');
    expect((completed?.payload as { decision?: string })?.decision).toBe('done');
  });
});

describe('P10.6 TaskExecutor control-at-tool-boundary', () => {
  it('cancel at the step boundary stops the loop before the model is called', async () => {
    const c = counters();
    const model = new FakeModel();
    model.setResponse(/./, JSON.stringify({ type: 'done', summary: 'should not reach' }));
    const cancelGate: LoopControl = {
      poll: async () => ({ kind: 'cancel' }),
      awaitResume: async () => 'cancel',
    };
    const { exec, events } = await build(c, model, cancelGate);

    await run(exec);

    // Cancelled before any model call → no DECISION_REQUESTED was emitted.
    const types = (await events.query({ sessionId: 'S' })).map((e) => e.type);
    expect(types).not.toContain('DECISION_REQUESTED');
    expect(model.callCount).toBe(0);
  });

  it('pause-then-resume lets the loop proceed', async () => {
    const c = counters();
    const model = new FakeModel();
    model.setResponse(/./, JSON.stringify({ type: 'done', summary: 'ok' }));
    let paused = false;
    const pauseGate: LoopControl = {
      poll: async () => { if (!paused) { paused = true; return { kind: 'pause' }; } return { kind: 'none' }; },
      awaitResume: async () => 'resume',
    };
    const { exec } = await build(c, model, pauseGate);

    await run(exec);

    expect(paused).toBe(true);
    expect(model.callCount).toBeGreaterThan(0); // resumed and called the model
  });
});
