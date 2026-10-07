// P10.5 — TaskExecutor in-loop human approval.
//
// A DESTRUCTIVE tool call (delete_file) is APPROVAL_PENDING under any real policy. With an
// ApprovalCoordinator wired, the executor waits for the decision IN-LOOP:
//   approved → the call executes (TG-005 honoured: only APPROVED runs);
//   denied   → the call does NOT execute; the agent sees a note and continues.
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
  buildToolPolicy,
  type ApprovalCoordinator,
  type ApprovalDecision,
  type Task,
  type Session,
  type WorkspaceRevision,
  type ToolCall,
  type ExecutorResult,
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
  taskId: 'T1', description: 'remove the stale file', strategy: { kind: 'generate' },
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

async function run(decision: ApprovalDecision): Promise<{ executed: boolean }> {
  const c = counters();
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

  // Model: propose delete_file (DESTRUCTIVE) once, then done.
  const model = new FakeModel();
  model.setSequence([
    JSON.stringify({ type: 'tool_call', toolName: 'delete_file', arguments: { path: 'stale.txt' } }),
    JSON.stringify({ type: 'done', summary: 'finished' }),
  ]);

  // The decision drives the fake approval coordinator. The ToolGateway must APPROVE the
  // call for execution to happen; the coordinator here does not touch the gateway, so we
  // approve/deny through the gateway inside the fake to mirror the real control path.
  const tg = new ToolGateway({ calls: toolCalls, approvals, events, policy: buildToolPolicy('edits'), now: c.now, nextId: c.nextId });
  const coord: ApprovalCoordinator = {
    awaitDecision: async (_s, toolCallId) => {
      if (decision === 'approved') await tg.approve(toolCallId, 'user');
      else if (decision === 'denied') await tg.deny(toolCallId, 'user', 'no');
      return decision;
    },
  };

  let executed = false;
  const executor = { execute: async (_call: ToolCall): Promise<ExecutorResult> => { executed = true; return { exitCode: 0, stdout: 'deleted', stderr: '', timedOut: false }; } };

  const exec = new TaskExecutor({
    taskRunService: runSvc, executionCoordinator: coordinator,
    contextBuilder: new ContextBuilder({ now: c.now, nextId: c.nextId }), gateway: model,
    toolGateway: tg, executor,
    approvalCoordinator: coord,
    now: c.now, nextId: c.nextId,
  });

  await exec.execute({
    sessionId: 'S', task: TASK, attemptNumber: 1, graphVersion: 1,
    workspaceRevisionAtStart: REVISION, workspaceRevisionAtEnd: REVISION,
  });

  return { executed };
}

describe('P10.5 TaskExecutor — in-loop approval', () => {
  it('approved DESTRUCTIVE call executes', async () => {
    const { executed } = await run('approved');
    expect(executed).toBe(true);
  });

  it('denied DESTRUCTIVE call does NOT execute (TG-005) and the run continues', async () => {
    const { executed } = await run('denied');
    expect(executed).toBe(false);
  });
});
