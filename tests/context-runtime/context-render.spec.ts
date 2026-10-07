// P10.3 — TaskExecutor renders collected context into the model prompt (the "last mile").
//
// Proves gap #2: a ContextProvider's signals flow through ContextBuilder → ContextSnapshot
// → the model prompt, with workspace content wrapped as UNTRUSTED (CX-005/SE-010). Uses a
// FakeModel that records the prompt it received; no real Ollama, no tree-sitter.
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
  type ContextSignals,
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
  taskId: 'T1', description: 'use the existing helper', strategy: { kind: 'generate' },
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

/** Create the session + task rows the task_runs FK requires. */
async function seed(db: SqliteDatabaseAdapter, c: { now: () => string; nextId: () => string }): Promise<void> {
  const sessions = new SqliteSessionRepository(db);
  const events = new SqliteEventLog(db);
  const lock = new SqliteWorkspaceLockService(db);
  const sessionSvc = new SessionService({ sessions, events, lock, now: c.now, nextId: c.nextId });
  await sessionSvc.create({ session: makeSession(), hostname: 'h', processId: 1 });
  await new SqliteTaskRepository(db).create(TASK);
}

let db: SqliteDatabaseAdapter;
beforeEach(() => {
  db = new SqliteDatabaseAdapter(':memory:');
  db.open();
  runMigrations(db, createMigrationRegistry(), { now: () => '2026-01-01T00:00:00.000Z' });
});
afterEach(() => db.close());

describe('P10.3 TaskExecutor context rendering', () => {
  it('injects collected files + symbols into the prompt as untrusted content', async () => {
    const c = counters();
    const model = new FakeModel();
    model.setResponse(/./, JSON.stringify({ type: 'done', summary: 'noted the context' }));

    await seed(db, c);
    const events = new SqliteEventLog(db);
    const taskRuns = new SqliteTaskRunRepository(db);
    const executions = new SqliteTaskExecutionRepository(db);
    const toolCalls = new SqliteToolCallRepository(db);
    const approvals = new SqliteApprovalRepository(db);

    const coordinator = new ExecutionCoordinator({ executions, now: c.now });
    const runSvc = new TaskRunService({ runs: taskRuns, events, reconciler: new NoopProcessReconciler(), now: c.now, nextId: c.nextId });
    const ctxBuilder = new ContextBuilder({ now: c.now, nextId: c.nextId });

    // Fake context provider: a util file + an exported symbol `computeTax`.
    const signals: ContextSignals = {
      workspaceFiles: new Map([
        ['src/util.ts', 'export function computeTax(amount: number): number {\n  return amount * 0.1;\n}\n'],
      ]),
      symbols: [
        { file: 'src/util.ts', name: 'computeTax', kind: 'function', startLine: 0, endLine: 2, exported: true },
      ],
      importReverseEdges: new Map(),
      changedPaths: ['src/util.ts'],
    };
    const contextProvider = { collect: async (): Promise<ContextSignals> => signals };

    await coordinator.init('T1');

    const taskExec = new TaskExecutor({
      taskRunService: runSvc, executionCoordinator: coordinator,
      contextBuilder: ctxBuilder, gateway: model,
      toolGateway: new ToolGateway({ calls: toolCalls, approvals, events, policy: PERMISSIVE_TEST_POLICY, now: c.now, nextId: c.nextId }),
      executor: { execute: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }) },
      contextProvider,
      now: c.now, nextId: c.nextId,
    });

    await taskExec.execute({
      sessionId: 'S', task: TASK, attemptNumber: 1, graphVersion: 1,
      workspaceRevisionAtStart: REVISION, workspaceRevisionAtEnd: REVISION,
    });

    const prompt = model.lastPrompt ?? '';
    // The collected file + symbol reached the prompt.
    expect(prompt).toContain('CODEBASE_CONTEXT');
    expect(prompt).toContain('src/util.ts');
    expect(prompt).toContain('computeTax');
    // Workspace content is wrapped as untrusted (CX-005 / SE-001 boundary).
    expect(prompt).toContain('<untrusted>');
    expect(prompt).toContain('</untrusted>');
  });

  it('omits the codebase section when no context provider is wired', async () => {
    const c = counters();
    const model = new FakeModel();
    model.setResponse(/./, JSON.stringify({ type: 'done', summary: 'ok' }));

    await seed(db, c);
    const events = new SqliteEventLog(db);
    const taskRuns = new SqliteTaskRunRepository(db);
    const executions = new SqliteTaskExecutionRepository(db);
    const toolCalls = new SqliteToolCallRepository(db);
    const approvals = new SqliteApprovalRepository(db);

    const coordinator = new ExecutionCoordinator({ executions, now: c.now });
    const runSvc = new TaskRunService({ runs: taskRuns, events, reconciler: new NoopProcessReconciler(), now: c.now, nextId: c.nextId });
    const ctxBuilder = new ContextBuilder({ now: c.now, nextId: c.nextId });
    await coordinator.init('T1');

    const taskExec = new TaskExecutor({
      taskRunService: runSvc, executionCoordinator: coordinator,
      contextBuilder: ctxBuilder, gateway: model,
      toolGateway: new ToolGateway({ calls: toolCalls, approvals, events, policy: PERMISSIVE_TEST_POLICY, now: c.now, nextId: c.nextId }),
      executor: { execute: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }) },
      now: c.now, nextId: c.nextId,
    });

    await taskExec.execute({
      sessionId: 'S', task: TASK, attemptNumber: 1, graphVersion: 1,
      workspaceRevisionAtStart: REVISION, workspaceRevisionAtEnd: REVISION,
    });

    expect(model.lastPrompt ?? '').not.toContain('CODEBASE_CONTEXT');
  });
});
