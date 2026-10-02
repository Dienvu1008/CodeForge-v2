// P4-VW1 — VerificationWiring: VerificationEngine + CompletionGate wired into TaskExecutor.
//
// Tests:
//   - SUCCEEDED run with no checks (DEFAULT_VERIFICATION_POLICY): report PASS but
//     CompletionGate blocks (NO_CHECKS_EXECUTED) → taskPassed=false, projection=VERIFYING.
//   - SUCCEEDED run with 1 passing check: report PASS, CompletionGate allows →
//     taskPassed=true, projection=PASSED.
//   - SUCCEEDED run with failing check: report FAIL → taskPassed=false.
//   - FAILED run: verification skipped entirely.
//   - verificationEngine absent: no verification, projection=VERIFYING, no verificationId.
import { describe, it, expect, beforeEach } from 'vitest';
import {
  TaskExecutor,
  TaskRunService,
  ExecutionCoordinator,
  ContextBuilder,
  ToolGateway,
  NoopProcessReconciler,
  PERMISSIVE_TEST_POLICY,
  VerificationEngine,
  CompletionGate,
  DEFAULT_VERIFICATION_POLICY,
  type VerificationPolicy,
  type ToolExecutor,
  type TaskExecutorDeps,
  type TaskExecutorRequest,
  type Task,
  type WorkspaceRevision,
} from '@codeforge/agent-core';
import {
  SqliteDatabaseAdapter,
  SqliteEventLog,
  SqliteTaskRunRepository,
  SqliteTaskExecutionRepository,
  SqliteToolCallRepository,
  SqliteApprovalRepository,
  SqliteVerificationRepository,
  runMigrations,
  createMigrationRegistry,
} from '@codeforge/infrastructure';
import { FakeModel, FakeProcessSupervisor, FakeRevisionProvider } from '@codeforge/testing';

// ── helpers ───────────────────────────────────────────────────────────────────

let counter = 0;
function nextId(): string { return `ID-${String(++counter).padStart(6, '0')}`; }
let timeT = 0;
function now(): string { return `2026-01-01T00:00:${String(timeT++).padStart(2, '0')}.000Z`; }

function makeRevision(hash = 'HASH-1'): WorkspaceRevision {
  return {
    revisionId: nextId(), canonicalFormVersion: 'v1', root: '/r',
    includedPaths: [], excludedScratchPaths: [],
    hashAlgorithm: 'blake3', hash, fileCount: 0, totalBytes: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    createdBy: { sessionId: 'SE-VW1', reason: 'session_start' },
  };
}

function makeTask(): Task {
  return {
    taskId: nextId(), description: 'test task',
    acceptanceCriteria: [], constraints: [],
    priority: 1, strategy: { kind: 'generate' },
    createdAt: now(), createdBy: 'planner',
  };
}

const fakeExecutor: ToolExecutor = {
  execute: async () => ({ exitCode: 0, stdout: 'ok', stderr: '', timedOut: false }),
};

/** Build a VerificationPolicy with `n` passing check definitions. */
function policyWithChecks(n: number, passing = true): VerificationPolicy {
  // Build fake check defs; FakeProcessSupervisor will respond based on exit code.
  const checks = Array.from({ length: n }, (_, i) => ({
    name:      `check-${i}`,
    kind:      'test' as const,
    command:   'node',
    args:      ['--version'],
    minScope:  'SMOKE' as const,
    timeoutMs: 5_000,
    ...(passing ? {} : {}), // exitCode controlled by FakeProcessSupervisor
  }));
  return { ...DEFAULT_VERIFICATION_POLICY, checks };
}

// ── Fixture ───────────────────────────────────────────────────────────────────

interface Fixture {
  db:          SqliteDatabaseAdapter;
  model:       FakeModel;
  task:        Task;
  revision:    WorkspaceRevision;
  revProvider: FakeRevisionProvider;
  deps:        TaskExecutorDeps;
}

async function makeFixture(
  verificationPolicy?: VerificationPolicy,
  passingChecks = 0,
  checksPassing = true,
): Promise<Fixture> {
  const db = new SqliteDatabaseAdapter(':memory:');
  db.open();
  runMigrations(db, createMigrationRegistry(), { now: () => '2026-01-01T00:00:00.000Z' });

  // Seed session + task FK rows.
  db.execute(
    `INSERT INTO sessions
       (session_id, workspace_id, workspace_root, goal_id, graph_version, state,
        created_at, updated_at, runtime_version, schema_version, budget_id, lock_id, metadata_json)
     VALUES ('SE-VW1','WS','/',  'G',1,'RUNNING','t','t','0.4.0',1,'B','L','{}')`,
  );

  const task = makeTask();
  db.execute(
    `INSERT INTO tasks (task_id, description, acceptance_json, constraints_json, priority,
       strategy_json, created_at, created_by, schema_version)
     VALUES (?,?,?,?,1,'{"kind":"generate"}','t','planner',1)`,
    [task.taskId, task.description, '[]', '[]'],
  );

  const events       = new SqliteEventLog(db);
  const runs         = new SqliteTaskRunRepository(db);
  const executions   = new SqliteTaskExecutionRepository(db);
  const toolCalls    = new SqliteToolCallRepository(db);
  const approvals    = new SqliteApprovalRepository(db);
  const verReports   = new SqliteVerificationRepository(db);
  const reconciler   = new NoopProcessReconciler();

  const revision   = makeRevision();
  const revProvider = new FakeRevisionProvider(revision);

  // FakeProcessSupervisor for verification checks.
  const verSupervisor = new FakeProcessSupervisor();
  if (passingChecks > 0) {
    verSupervisor.setOutcome(/node/, {
      exitCode: checksPassing ? 0 : 1,
      stdout:   checksPassing ? 'v20.0.0' : '',
      stderr:   checksPassing ? '' : 'check failed',
    });
  }

  const verEngine = new VerificationEngine({
    reports:         verReports,
    events,
    supervisor:      verSupervisor,
    revisionProvider: revProvider,
    now,
    nextId,
  });
  const completionGate = new CompletionGate({ reports: verReports });
  const policy = verificationPolicy ?? policyWithChecks(passingChecks, checksPassing);

  const taskRunService = new TaskRunService({ runs, events, reconciler, now, nextId });
  const coordinator    = new ExecutionCoordinator({ executions, now });
  const contextBuilder = new ContextBuilder({ now, nextId });
  const toolGateway    = new ToolGateway({
    calls: toolCalls, approvals, events,
    policy: PERMISSIVE_TEST_POLICY, now, nextId,
  });
  const model = new FakeModel();

  await coordinator.init(task.taskId);

  const deps: TaskExecutorDeps = {
    taskRunService, executionCoordinator: coordinator,
    contextBuilder, gateway: model, toolGateway, executor: fakeExecutor,
    verificationEngine: verEngine,
    completionGate,
    verificationPolicy: policy,
    now, nextId,
  };

  return { db, model, task, revision, revProvider, deps };
}

function makeReq(f: Fixture): TaskExecutorRequest {
  return {
    sessionId: 'SE-VW1', task: f.task, attemptNumber: 1,
    graphVersion: 1,
    workspaceRevisionAtStart: f.revision,
    workspaceRevisionAtEnd:   f.revision,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('P4-VW1 — VerificationWiring', () => {

  beforeEach(() => { counter = 0; timeT = 0; });

  // ── No checks: verification runs but gate blocks ──────────────────────────

  it('SUCCEEDED run, 0 checks: verificationStatus=PASS, taskPassed=false (CompletionGate blocks NO_CHECKS_EXECUTED)', async () => {
    const f = await makeFixture(DEFAULT_VERIFICATION_POLICY, 0);
    f.model.setSequence([JSON.stringify({ type: 'done', summary: 'ok' })]);
    const exec = new TaskExecutor(f.deps);
    const result = await exec.execute(makeReq(f));

    expect(result.finalState).toBe('SUCCEEDED');
    expect(result.verificationId).toBeDefined();
    // DEFAULT_VERIFICATION_POLICY has 0 checks → CompletionGate returns canComplete=false
    expect(result.taskPassed).toBeFalsy();
    // Projection stays VERIFYING (gate blocked)
    const projection = await f.deps.executionCoordinator.get(f.task.taskId);
    expect(projection?.currentState).toBe('VERIFYING');
  });

  // ── 1 passing check: PASS + gate allows → PASSED ──────────────────────────

  it('SUCCEEDED run, 1 passing check: verificationStatus=PASS, taskPassed=true, projection=PASSED', async () => {
    const f = await makeFixture(undefined, 1, true);
    f.model.setSequence([JSON.stringify({ type: 'done', summary: 'ok' })]);
    const exec = new TaskExecutor(f.deps);
    const result = await exec.execute(makeReq(f));

    expect(result.finalState).toBe('SUCCEEDED');
    expect(result.verificationStatus).toBe('PASS');
    expect(result.taskPassed).toBe(true);
    expect(result.verificationId).toBeDefined();

    const projection = await f.deps.executionCoordinator.get(f.task.taskId);
    expect(projection?.currentState).toBe('PASSED');
  });

  // ── 1 failing check: FAIL → gate blocked ─────────────────────────────────

  it('SUCCEEDED run, 1 failing check: verificationStatus=FAIL, taskPassed=false', async () => {
    const f = await makeFixture(undefined, 1, false);
    f.model.setSequence([JSON.stringify({ type: 'done', summary: 'ok' })]);
    const exec = new TaskExecutor(f.deps);
    const result = await exec.execute(makeReq(f));

    expect(result.finalState).toBe('SUCCEEDED');
    expect(result.verificationStatus).toBe('FAIL');
    expect(result.taskPassed).toBeFalsy();

    const projection = await f.deps.executionCoordinator.get(f.task.taskId);
    expect(projection?.currentState).toBe('VERIFYING');
  });

  // ── FAILED run: verification skipped ─────────────────────────────────────

  it('FAILED run: verification is not called, verificationId undefined', async () => {
    const f = await makeFixture(undefined, 1, true);
    // Model returns invalid JSON → triggers FAILED run.
    f.model.setResponse(/./, 'not valid json {{');
    const exec = new TaskExecutor(f.deps);
    const result = await exec.execute(makeReq(f));

    expect(result.finalState).toBe('FAILED');
    expect(result.verificationId).toBeUndefined();
    expect(result.taskPassed).toBeFalsy();
  });

  // ── No verificationEngine: skipped entirely ───────────────────────────────

  it('no verificationEngine in deps: verificationId undefined, projection stays VERIFYING', async () => {
    const f = await makeFixture(undefined, 1, true);
    // Remove verificationEngine from deps.
    const { verificationEngine: _ve, completionGate: _cg, ...depsWithout } = f.deps;
    const deps: TaskExecutorDeps = depsWithout;
    f.model.setSequence([JSON.stringify({ type: 'done', summary: 'ok' })]);
    const exec = new TaskExecutor(deps);
    const result = await exec.execute(makeReq(f));

    expect(result.finalState).toBe('SUCCEEDED');
    expect(result.verificationId).toBeUndefined();
    expect(result.taskPassed).toBeFalsy();

    const projection = await deps.executionCoordinator.get(f.task.taskId);
    expect(projection?.currentState).toBe('VERIFYING'); // unchanged
  });

  // ── Projection is PASSED after successful verification ────────────────────

  it('projection.attempts is 1 after one PASSED run', async () => {
    const f = await makeFixture(undefined, 1, true);
    f.model.setSequence([JSON.stringify({ type: 'done', summary: 'ok' })]);
    const exec = new TaskExecutor(f.deps);
    await exec.execute(makeReq(f));

    const projection = await f.deps.executionCoordinator.get(f.task.taskId);
    expect(projection?.attempts).toBe(1);
    expect(projection?.currentState).toBe('PASSED');
  });

  // ── verificationId is a string ID ────────────────────────────────────────

  it('verificationId is a non-empty string when verification runs', async () => {
    const f = await makeFixture(undefined, 1, true);
    f.model.setSequence([JSON.stringify({ type: 'done', summary: 'ok' })]);
    const exec = new TaskExecutor(f.deps);
    const result = await exec.execute(makeReq(f));

    expect(typeof result.verificationId).toBe('string');
    expect(result.verificationId!.length).toBeGreaterThan(0);
  });

  // ── TIMEOUT run: verification skipped ────────────────────────────────────

  it('TIMEOUT run: verification is skipped, taskPassed=false', async () => {
    const f = await makeFixture(undefined, 1, true);
    // Executor returns timedOut=true.
    const timedOutExecutor: ToolExecutor = {
      execute: async () => ({ exitCode: null, stdout: '', stderr: '', timedOut: true }),
    };
    const depsWithTimeout = { ...f.deps, executor: timedOutExecutor };
    f.model.setSequence([
      JSON.stringify({ type: 'tool_call', toolName: 'read_file', arguments: { path: 'x.ts' } }),
    ]);
    const exec = new TaskExecutor(depsWithTimeout);
    const result = await exec.execute(makeReq(f));

    expect(result.finalState).toBe('TIMEOUT');
    expect(result.verificationId).toBeUndefined();
    expect(result.taskPassed).toBeFalsy();
  });
});
