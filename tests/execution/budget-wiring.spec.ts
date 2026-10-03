// P4-BW1 — BudgetWiring: BudgetRepository.consume() debit per tool call (BU-003/005).
import { describe, it, expect, beforeEach } from 'vitest';
import {
  TaskExecutor, TaskRunService, ExecutionCoordinator, ContextBuilder, ToolGateway,
  NoopProcessReconciler, PERMISSIVE_TEST_POLICY,
  type TaskExecutorDeps, type TaskExecutorRequest, type Task, type WorkspaceRevision,
} from '@codeforge/agent-core';
import {
  SqliteDatabaseAdapter, SqliteEventLog, SqliteTaskRunRepository,
  SqliteTaskExecutionRepository, SqliteToolCallRepository, SqliteApprovalRepository,
  SqliteBudgetRepository, runMigrations, createMigrationRegistry,
} from '@codeforge/infrastructure';
import { FakeModel } from '@codeforge/testing';

let counter = 0;
function nextId(): string { return 'BW-' + String(++counter).padStart(6, '0'); }
let timeT = 0;
function now(): string { return '2026-01-01T00:00:' + String(timeT++).padStart(2, '0') + '.000Z'; }

function makeRevision(): WorkspaceRevision {
  return {
    revisionId: nextId(), canonicalFormVersion: 'v1', root: '/r',
    includedPaths: [], excludedScratchPaths: [],
    hashAlgorithm: 'blake3', hash: 'H', fileCount: 0, totalBytes: 0,
    createdAt: '2026-01-01T00:00:00.000Z', createdBy: { sessionId: 'SE-BW', reason: 'session_start' },
  };
}
function makeTask(): Task {
  return {
    taskId: nextId(), description: 'budget test',
    acceptanceCriteria: [], constraints: [],
    priority: 1, strategy: { kind: 'generate' },
    createdAt: now(), createdBy: 'planner',
  };
}
const fakeExec = { execute: async () => ({ exitCode: 0, stdout: 'ok', stderr: '', timedOut: false }) };

async function setup() {
  const db = new SqliteDatabaseAdapter(':memory:');
  db.open();
  runMigrations(db, createMigrationRegistry(), { now: () => '2026-01-01T00:00:00.000Z' });
  db.execute(
    "INSERT INTO sessions (session_id, workspace_id, workspace_root, goal_id, graph_version, state, created_at, updated_at, runtime_version, schema_version, budget_id, lock_id, metadata_json) VALUES ('SE-BW','W','/','G',1,'RUNNING','t','t','0.4.0',1,'B','L','{}')"
  );
  const task = makeTask();
  db.execute(
    "INSERT INTO tasks (task_id, description, acceptance_json, constraints_json, priority, strategy_json, created_at, created_by, schema_version) VALUES (?,?,?,?,1,'{\"kind\":\"generate\"}','t','planner',1)",
    [task.taskId, task.description, '[]', '[]']
  );
  const events   = new SqliteEventLog(db);
  const runs     = new SqliteTaskRunRepository(db);
  const execs    = new SqliteTaskExecutionRepository(db);
  const tc       = new SqliteToolCallRepository(db);
  const ap       = new SqliteApprovalRepository(db);
  const budgets  = new SqliteBudgetRepository(db);
  const rec      = new NoopProcessReconciler();
  const trs      = new TaskRunService({ runs, events, reconciler: rec, now, nextId });
  const coord    = new ExecutionCoordinator({ executions: execs, now });
  const ctx      = new ContextBuilder({ now, nextId });
  const tg       = new ToolGateway({ calls: tc, approvals: ap, events, policy: PERMISSIVE_TEST_POLICY, now, nextId });
  await coord.init(task.taskId);
  const rev = makeRevision();
  const req: TaskExecutorRequest = {
    sessionId: 'SE-BW', task, attemptNumber: 1, graphVersion: 1,
    workspaceRevisionAtStart: rev, workspaceRevisionAtEnd: rev,
  };
  const base: Omit<TaskExecutorDeps, 'budgetRepository' | 'budgetId'> = {
    taskRunService: trs, executionCoordinator: coord,
    contextBuilder: ctx, gateway: new FakeModel(),
    toolGateway: tg, executor: fakeExec, now, nextId,
  };
  return { db, budgets, task, req, base };
}

describe('P4-BW1 — BudgetWiring', () => {
  beforeEach(() => { counter = 0; timeT = 0; });

  it('no budgetRepository: run succeeds without debit', async () => {
    const { req, base } = await setup();
    const m = new FakeModel();
    m.setSequence([JSON.stringify({ type: 'done', summary: 'ok' })]);
    const r = await new TaskExecutor({ ...base, gateway: m }).execute(req);
    expect(r.finalState).toBe('SUCCEEDED');
  });

  it('budget toolCalls=2: 3rd call is blocked → TIMEOUT (BU-005)', async () => {
    const { budgets, req, base } = await setup();
    const budgetId = nextId();
    await budgets.create({
      budgetId, scope: 'session', scopeId: 'SE-BW',
      limits:   { wallClockMs: 9999999, modelTokens: 9999999, toolCalls: 2, recoveryAttempts: 10 },
      consumed: { wallClockMs: 0, modelTokens: 0, toolCalls: 0, recoveryAttempts: 0 },
      createdAt: now(), updatedAt: now(),
    });
    const m = new FakeModel();
    m.setResponse(/./, JSON.stringify({ type: 'tool_call', toolName: 'read_file', arguments: { path: 'x.ts' } }));
    const r = await new TaskExecutor({ ...base, gateway: m, budgetRepository: budgets, budgetId }).execute(req);
    expect(r.finalState).toBe('TIMEOUT');
    expect(r.toolCallCount).toBe(2);
  });

  it('budget toolCalls=0: first call immediately blocked → TIMEOUT', async () => {
    const { budgets, req, base } = await setup();
    const budgetId = nextId();
    await budgets.create({
      budgetId, scope: 'session', scopeId: 'SE-BW',
      limits:   { wallClockMs: 9999999, modelTokens: 9999999, toolCalls: 0, recoveryAttempts: 10 },
      consumed: { wallClockMs: 0, modelTokens: 0, toolCalls: 0, recoveryAttempts: 0 },
      createdAt: now(), updatedAt: now(),
    });
    const m = new FakeModel();
    m.setSequence([JSON.stringify({ type: 'tool_call', toolName: 'read_file', arguments: { path: 'x.ts' } })]);
    const r = await new TaskExecutor({ ...base, gateway: m, budgetRepository: budgets, budgetId }).execute(req);
    expect(r.finalState).toBe('TIMEOUT');
    expect(r.toolCallCount).toBe(0);
  });

  it('budget toolCalls=10: run SUCCEEDS and 1 debit recorded', async () => {
    const { budgets, req, base } = await setup();
    const budgetId = nextId();
    await budgets.create({
      budgetId, scope: 'session', scopeId: 'SE-BW',
      limits:   { wallClockMs: 9999999, modelTokens: 9999999, toolCalls: 10, recoveryAttempts: 10 },
      consumed: { wallClockMs: 0, modelTokens: 0, toolCalls: 0, recoveryAttempts: 0 },
      createdAt: now(), updatedAt: now(),
    });
    const m = new FakeModel();
    m.setSequence([
      JSON.stringify({ type: 'tool_call', toolName: 'read_file', arguments: { path: 'x.ts' } }),
      JSON.stringify({ type: 'done', summary: 'done' }),
    ]);
    const r = await new TaskExecutor({ ...base, gateway: m, budgetRepository: budgets, budgetId }).execute(req);
    expect(r.finalState).toBe('SUCCEEDED');
    expect(r.toolCallCount).toBe(1);
    const updated = await budgets.getById(budgetId);
    expect(updated?.consumed.toolCalls).toBe(1);
  });

  it('done signal immediately: no budget debit', async () => {
    const { budgets, req, base } = await setup();
    const budgetId = nextId();
    await budgets.create({
      budgetId, scope: 'session', scopeId: 'SE-BW',
      limits:   { wallClockMs: 9999999, modelTokens: 9999999, toolCalls: 0, recoveryAttempts: 10 },
      consumed: { wallClockMs: 0, modelTokens: 0, toolCalls: 0, recoveryAttempts: 0 },
      createdAt: now(), updatedAt: now(),
    });
    const m = new FakeModel();
    m.setSequence([JSON.stringify({ type: 'done', summary: 'fast' })]);
    const r = await new TaskExecutor({ ...base, gateway: m, budgetRepository: budgets, budgetId }).execute(req);
    expect(r.finalState).toBe('SUCCEEDED');
    const updated = await budgets.getById(budgetId);
    expect(updated?.consumed.toolCalls).toBe(0);
  });
});