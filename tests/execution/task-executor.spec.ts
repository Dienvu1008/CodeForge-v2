// P3-TE1 — NodeToolExecutor + TaskExecutor: orchestrate one TaskRun end-to-end.
//
// Two suites:
//   1. NodeToolExecutor unit — routing by toolName via FakeProcessSupervisor.
//   2. TaskExecutor unit — full orchestration with FakeModel + SQLite :memory:.
//      Tests: success path, model signals done, tool call loop, denied tool,
//      model failure → FAILED run, budget exhaustion, finalize side-effects.
import { describe, it, expect, beforeEach } from 'vitest';
import {
  TaskExecutor,
  ExecutionCoordinator,
  TaskRunService,
  ContextBuilder,
  ToolGateway,
  NoopProcessReconciler,
  PERMISSIVE_TEST_POLICY,
  type ToolExecutor,
} from '@codeforge/agent-core';
import type {
  Task,
  WorkspaceRevision,
  TaskExecutorDeps,
  TaskExecutorRequest,
} from '@codeforge/agent-core';
import {
  NodeToolExecutor,
  NodeWorkspaceManager,
  SqliteDatabaseAdapter,
  SqliteEventLog,
  SqliteTaskRunRepository,
  SqliteTaskExecutionRepository,
  SqliteToolCallRepository,
  SqliteApprovalRepository,
  runMigrations,
  createMigrationRegistry,
} from '@codeforge/infrastructure';
import { FakeModel, FakeProcessSupervisor } from '@codeforge/testing';

// ── helpers ───────────────────────────────────────────────────────────────────

/** Simple deterministic ID generator for tests (avoids UlidSources overhead). */
let _uidCounter = 0;
function uid(): string {
  return `UID-${String(++_uidCounter).padStart(8, '0')}`;
}

function makeRevision(root = '/tmp/ws'): WorkspaceRevision {
  return {
    revisionId:          uid(),
    canonicalFormVersion:'v1',
    root,
    includedPaths:        [],
    excludedScratchPaths: [],
    hashAlgorithm:        'blake3',
    hash:                 'aabbcc',
    fileCount:            0,
    totalBytes:           0,
    createdAt:            '2026-01-01T00:00:00.000Z',
    createdBy: {
      sessionId: 'SE-0001',
      reason:    'session_start',
    },
  };
}

function makeTask(description = 'Write a hello world file'): Task {
  return {
    taskId:             uid(),
    description,
    acceptanceCriteria: [{ criterionId: uid(), description: 'file exists', mandatory: true }],
    constraints:        [],
    priority:           1,
    strategy:           { kind: 'generate' },
    createdAt:          '2026-01-01T00:00:00.000Z',
    createdBy:          'planner',
  };
}

async function makeDb() {
  const db = new SqliteDatabaseAdapter(':memory:');
  db.open();
  runMigrations(db, createMigrationRegistry(), { now: () => '2026-01-01T00:00:00.000Z' });
  return db;
}

/** Seed the minimum FK rows (session + task) so task_runs and tool_calls can be inserted. */
function seedSession(db: SqliteDatabaseAdapter, sessionId = 'SE-0001'): void {
  db.execute(
    `INSERT OR IGNORE INTO sessions
       (session_id, workspace_id, workspace_root, goal_id, graph_version, state,
        created_at, updated_at, runtime_version, schema_version, budget_id, lock_id, metadata_json)
     VALUES (?,?,?,?,1,'RUNNING','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z','0.4.0',1,'B','L','{}')`,
    [sessionId, 'WS-001', '/tmp/ws', 'GOAL-001'],
  );
}

function seedTask(db: SqliteDatabaseAdapter, taskId: string): void {
  db.execute(
    `INSERT OR IGNORE INTO tasks
       (task_id, description, acceptance_json, constraints_json, priority,
        strategy_json, created_at, created_by, schema_version)
     VALUES (?,?,?,?,1,'{"kind":"generate"}','2026-01-01T00:00:00.000Z','planner',1)`,
    [taskId, 'test task', '[]', '[]'],
  );
}



let counter = 0;
function makeIdGen() {
  return () => `ID-${String(++counter).padStart(6, '0')}`;
}
function makeNow() {
  let t = 0;
  return () => `2026-01-01T00:00:${String(t++).padStart(2, '0')}.000Z`;
}

// ── NodeToolExecutor unit ─────────────────────────────────────────────────────

describe('NodeToolExecutor — routing', () => {
  let fake: FakeProcessSupervisor;
  let executor: NodeToolExecutor;

  beforeEach(() => {
    fake = new FakeProcessSupervisor();
    const ws = new NodeWorkspaceManager({
      root:   process.cwd(),
      now:    () => new Date().toISOString(),
      nextId: uid,
    });
    executor = new NodeToolExecutor({
      filesystem: { workspace: ws },
      git:        { workspace: ws, supervisor: fake },
      shell:      { workspace: ws, supervisor: fake },
    });
  });

  it('routes git_status to GitExecutor (spawns git)', async () => {
    fake.setOutcome(/git/, { exitCode: 0, stdout: '', stderr: '' });
    const call = {
      toolCallId: 'TC-1', sessionId: 'S1', toolName: 'git_status',
      toolVersion: '1.0', riskClass: 'READ_ONLY' as const,
      arguments: {}, argumentsHash: 'h',
      state: 'RUNNING' as const, proposedBy: 'model' as const,
      provenance: {
        provenanceId: 'PV-1', source: { kind: 'runtime' as const, id: 'S1' },
        inputs: [], reason: 'test', at: '2026-01-01T00:00:00.000Z',
      },
      requestedAt: '2026-01-01T00:00:00.000Z',
    };
    const r = await executor.execute(call);
    expect(r.exitCode).toBe(0);
    expect(fake.callCount).toBe(1);
  });

  it('routes run_command to ShellExecutor (allowlist check fires)', async () => {
    const r = await executor.execute({
      toolCallId: 'TC-2', sessionId: 'S1', toolName: 'run_command',
      toolVersion: '1.0', riskClass: 'SYSTEM' as const,
      arguments: { command: 'bash', args: [] }, argumentsHash: 'h',
      state: 'RUNNING' as const, proposedBy: 'model' as const,
      provenance: {
        provenanceId: 'PV-2', source: { kind: 'runtime' as const, id: 'S1' },
        inputs: [], reason: 'test', at: '2026-01-01T00:00:00.000Z',
      },
      requestedAt: '2026-01-01T00:00:00.000Z',
    });
    // bash is not in DEFAULT_SHELL_ALLOWLIST → exits 1 from ShellExecutor policy check
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch('not in the ShellPolicy allowlist');
    expect(fake.callCount).toBe(0); // no spawn
  });

  it('returns exitCode=1 for unknown toolName', async () => {
    const r = await executor.execute({
      toolCallId: 'TC-3', sessionId: 'S1', toolName: 'teleport',
      toolVersion: '1.0', riskClass: 'READ_ONLY' as const,
      arguments: {}, argumentsHash: 'h',
      state: 'RUNNING' as const, proposedBy: 'model' as const,
      provenance: {
        provenanceId: 'PV-3', source: { kind: 'runtime' as const, id: 'S1' },
        inputs: [], reason: 'test', at: '2026-01-01T00:00:00.000Z',
      },
      requestedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch('no executor registered');
  });

  it('routes all filesystem tools without spawning (no process supervisor needed)', async () => {
    // read_file on a real path returns content (or NOT_FOUND — doesn't matter for routing).
    const r = await executor.execute({
      toolCallId: 'TC-4', sessionId: 'S1', toolName: 'list_dir',
      toolVersion: '1.0', riskClass: 'READ_ONLY' as const,
      arguments: { path: '.' }, argumentsHash: 'h',
      state: 'RUNNING' as const, proposedBy: 'model' as const,
      provenance: {
        provenanceId: 'PV-4', source: { kind: 'runtime' as const, id: 'S1' },
        inputs: [], reason: 'test', at: '2026-01-01T00:00:00.000Z',
      },
      requestedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(r.exitCode).toBe(0);
    expect(fake.callCount).toBe(0); // filesystem executor uses no supervisor
  });
});

// ── TaskExecutor unit ─────────────────────────────────────────────────────────

describe('TaskExecutor — unit (SQLite :memory: + FakeModel)', () => {
  let model:    FakeModel;
  let fakeExec: ToolExecutor;

  beforeEach(() => {
    counter = 0;
    _uidCounter = 0;
    model = new FakeModel();
    fakeExec = {
      execute: async () => ({ exitCode: 0, stdout: 'ok', stderr: '', timedOut: false }),
    };
  });

  async function makeTestDeps(overrides: Partial<TaskExecutorDeps> = {}): Promise<{ deps: TaskExecutorDeps; task: Task; db: SqliteDatabaseAdapter }> {
    const db      = await makeDb();
    const now     = makeNow();
    const nextId  = makeIdGen();
    const events  = new SqliteEventLog(db);
    const runs    = new SqliteTaskRunRepository(db);
    const executions = new SqliteTaskExecutionRepository(db);
    const toolCalls  = new SqliteToolCallRepository(db);
    const approvals  = new SqliteApprovalRepository(db);

    // Seed session row (FK required by task_runs, tool_calls, events).
    seedSession(db, 'SE-0001');

    const task = makeTask();
    // Seed task row (FK required by task_runs, task_executions).
    seedTask(db, task.taskId);

    const reconciler = new NoopProcessReconciler();
    const taskRunService = new TaskRunService({ runs, events, reconciler, now, nextId });
    const executionCoordinator = new ExecutionCoordinator({ executions, now });
    const contextBuilder = new ContextBuilder({ now, nextId });
    const toolGateway = new ToolGateway({
      calls: toolCalls,
      approvals,
      events,
      policy: PERMISSIVE_TEST_POLICY,
      now,
      nextId,
    });

    // Initialize projection for the task.
    await executionCoordinator.init(task.taskId);

    const deps: TaskExecutorDeps = {
      taskRunService,
      executionCoordinator,
      contextBuilder,
      gateway:   model,
      toolGateway,
      executor:  fakeExec,
      now,
      nextId,
      ...overrides,
    };
    return { deps, task, db };
  }

  function makeReq(task: Task, overrides: Partial<TaskExecutorRequest> = {}): TaskExecutorRequest {
    const rev = makeRevision();
    return {
      sessionId:                'SE-0001',
      task,
      attemptNumber:            1,
      graphVersion:             1,
      workspaceRevisionAtStart: rev,
      workspaceRevisionAtEnd:   rev,
      ...overrides,
    };
  }

  // ── success: model signals done immediately ────────────────────────────────

  it('SUCCEEDED when model returns {type:"done"} on first call', async () => {
    const { deps, task } = await makeTestDeps();
    model.setSequence([
      JSON.stringify({ type: 'done', summary: 'Task complete: wrote the file.' }),
    ]);
    const executor = new TaskExecutor({ ...deps, executor: fakeExec });
    const result = await executor.execute(makeReq(task));
    expect(result.finalState).toBe('SUCCEEDED');
    expect(result.toolCallCount).toBe(0);
    expect(result.summary).toBe('Task complete: wrote the file.');
  });

  // ── Tier B2: stated assumptions are injected into the task prompt ──────────

  it('injects a STATED_ASSUMPTIONS section when goalAssumptions are present', async () => {
    const { deps, task } = await makeTestDeps();
    model.setSequence([JSON.stringify({ type: 'done', summary: 'done' })]);
    const executor = new TaskExecutor({ ...deps, executor: fakeExec });
    await executor.execute(makeReq(task, {
      goalAssumptions: [
        'Target language is TypeScript',
        'The CLI reads from stdin',
      ],
    }));
    const prompt = model.lastPrompt ?? '';
    expect(prompt).toContain('STATED_ASSUMPTIONS');
    expect(prompt).toContain('Target language is TypeScript');
    expect(prompt).toContain('The CLI reads from stdin');
    // The assumptions must be framed as fixed constraints to proceed under (option (ii)).
    expect(prompt).toMatch(/Proceed under these assumptions/i);
  });

  it('omits the STATED_ASSUMPTIONS section when no goalAssumptions are given (fail-safe)', async () => {
    const { deps, task } = await makeTestDeps();
    model.setSequence([JSON.stringify({ type: 'done', summary: 'done' })]);
    const executor = new TaskExecutor({ ...deps, executor: fakeExec });
    await executor.execute(makeReq(task)); // no goalAssumptions
    expect(model.lastPrompt ?? '').not.toContain('STATED_ASSUMPTIONS');
  });

  it('omits the STATED_ASSUMPTIONS section when goalAssumptions is empty/blank', async () => {
    const { deps, task } = await makeTestDeps();
    model.setSequence([JSON.stringify({ type: 'done', summary: 'done' })]);
    const executor = new TaskExecutor({ ...deps, executor: fakeExec });
    await executor.execute(makeReq(task, { goalAssumptions: ['', '   '] }));
    expect(model.lastPrompt ?? '').not.toContain('STATED_ASSUMPTIONS');
  });

  // ── P12.7: a contextPlan sizes the ContextBuilder policy ───────────────────

  it('derives the ContextBuilder policy from req.contextPlan (narrow scope → small budget)', async () => {
    const { deps, task } = await makeTestDeps();
    // Spy wrapping the real ContextBuilder to capture the policy it was handed.
    const real = deps.contextBuilder;
    let capturedPolicy: { availableTokens: number; maxItems: number; policyId: string } | undefined;
    const spy = { build: (req: Parameters<typeof real.build>[0]) => { capturedPolicy = req.policy; return real.build(req); } };
    model.setSequence([JSON.stringify({ type: 'done', summary: 'done' })]);
    const executor = new TaskExecutor({ ...deps, contextBuilder: spy as typeof real, executor: fakeExec });
    await executor.execute(makeReq(task, { contextPlan: { scope: 'TASK', maxFiles: 3, repositoryWide: false } }));
    expect(capturedPolicy).toBeDefined();
    expect(capturedPolicy?.policyId).toBe('cx-task');
    expect(capturedPolicy?.availableTokens).toBe(4096); // TASK/FILE tier
    expect(capturedPolicy?.maxItems).toBe(8);           // clamp(8,60, round(3*2))
  });

  it('passes NO policy when contextPlan is absent (ContextBuilder uses its default — fail-safe)', async () => {
    const { deps, task } = await makeTestDeps();
    const real = deps.contextBuilder;
    let sawPolicyKey = true;
    const spy = { build: (req: Parameters<typeof real.build>[0]) => { sawPolicyKey = req.policy !== undefined; return real.build(req); } };
    model.setSequence([JSON.stringify({ type: 'done', summary: 'done' })]);
    const executor = new TaskExecutor({ ...deps, contextBuilder: spy as typeof real, executor: fakeExec });
    await executor.execute(makeReq(task)); // no contextPlan
    expect(sawPolicyKey).toBe(false);
  });

  // ── P12.8: a promptPlan shapes the prompt (persona / guidance / few-shot / verbosity) ──

  it('injects EXPERT_PERSONA, TASK_TYPE_GUIDANCE and EXAMPLE sections when a promptPlan is present', async () => {
    const { deps, task } = await makeTestDeps();
    model.setSequence([JSON.stringify({ type: 'done', summary: 'done' })]);
    const executor = new TaskExecutor({ ...deps, executor: fakeExec });
    await executor.execute(makeReq(task, {
      promptPlan: {
        expertPersona: 'Adopt the perspective of a TypeScript Systems Engineer.',
        taskTypeGuidance: 'This is a BUG FIX. Find the ROOT CAUSE.',
        fewShotExampleId: 'example-bugfix',
        verbosity: 'guarded',
      },
    }));
    const prompt = model.lastPrompt ?? '';
    expect(prompt).toContain('EXPERT_PERSONA');
    expect(prompt).toContain('TypeScript Systems Engineer');
    expect(prompt).toContain('TASK_TYPE_GUIDANCE');
    expect(prompt).toContain('ROOT CAUSE');
    expect(prompt).toContain('EXAMPLE'); // few-shot resolved from the id
  });

  it('guarded verbosity adds a small-model addendum to the system prompt', async () => {
    const { deps, task } = await makeTestDeps();
    model.setSequence([JSON.stringify({ type: 'done', summary: 'done' })]);
    const executor = new TaskExecutor({ ...deps, executor: fakeExec });
    await executor.execute(makeReq(task, { promptPlan: { verbosity: 'guarded' } }));
    const sys = model.history[model.history.length - 1]?.request.systemPrompt ?? '';
    expect(sys).toMatch(/small-model mode/i);
  });

  it('no promptPlan ⇒ no persona/guidance sections and the base system prompt (fail-safe)', async () => {
    const { deps, task } = await makeTestDeps();
    model.setSequence([JSON.stringify({ type: 'done', summary: 'done' })]);
    const executor = new TaskExecutor({ ...deps, executor: fakeExec });
    await executor.execute(makeReq(task));
    expect(model.lastPrompt ?? '').not.toContain('EXPERT_PERSONA');
    const sys = model.history[model.history.length - 1]?.request.systemPrompt ?? '';
    expect(sys).not.toMatch(/small-model mode/i);
    expect(sys).not.toMatch(/You are a strong model/i);
  });

  it('a promptPlan makes the task prompt larger (the steering costs some tokens — measured)', async () => {
    const { deps, task } = await makeTestDeps();
    model.setSequence([JSON.stringify({ type: 'done', summary: 'done' })]);
    const base = new TaskExecutor({ ...deps, executor: fakeExec });
    await base.execute(makeReq(task));
    const before = (model.lastPrompt ?? '').length;

    model.reset();
    model.setSequence([JSON.stringify({ type: 'done', summary: 'done' })]);
    const shaped = new TaskExecutor({ ...deps, executor: fakeExec });
    await shaped.execute(makeReq(task, {
      promptPlan: {
        expertPersona: 'Adopt the perspective of a TypeScript Systems Engineer.',
        taskTypeGuidance: 'This is a BUG FIX. Find the ROOT CAUSE.',
        fewShotExampleId: 'example-bugfix',
        verbosity: 'guarded',
      },
    }));
    const after = (model.lastPrompt ?? '').length;
    // Shaping adds guidance, so the prompt grows — the trade the benchmark must watch.
    expect(after).toBeGreaterThan(before);
  });

  // ── success: one tool call then done ──────────────────────────────────────

  it('SUCCEEDED after one tool call + done signal', async () => {
    const { deps, task } = await makeTestDeps();
    model.setSequence([
      JSON.stringify({ type: 'tool_call', toolName: 'read_file', arguments: { path: 'README.md' }, reasoning: 'check file' }),
      JSON.stringify({ type: 'done', summary: 'All done.' }),
    ]);
    const executor = new TaskExecutor({ ...deps, executor: fakeExec });
    const result = await executor.execute(makeReq(task));
    expect(result.finalState).toBe('SUCCEEDED');
    expect(result.toolCallCount).toBe(1);
  });

  // ── tool-call budget exhausted ─────────────────────────────────────────────

  it('FAILED when maxToolCalls exhausted without done signal', async () => {
    const { deps, task } = await makeTestDeps();
    // Model always proposes read_file, never done.
    model.setResponse(/./, JSON.stringify({
      type: 'tool_call', toolName: 'read_file', arguments: { path: 'x.ts' },
    }));
    const executor = new TaskExecutor({ ...deps, executor: fakeExec, maxToolCalls: 3 });
    const result = await executor.execute(makeReq(task));
    expect(result.finalState).toBe('FAILED');
    // toolCallCount capped by executor behaviour (failed tool stops loop)
  });

  // ── model failure → FAILED ────────────────────────────────────────────────

  it('FAILED when model throws ModelError (unrecoverable)', async () => {
    const { deps, task } = await makeTestDeps();
    const { ModelError } = await import('@codeforge/agent-core');
    model.setError(new ModelError('MODEL_UNAVAILABLE', 'ollama down'));
    const executor = new TaskExecutor({ ...deps, executor: fakeExec });
    const result = await executor.execute(makeReq(task));
    expect(result.finalState).toBe('FAILED');
  });

  // ── model timeout → TIMEOUT run ───────────────────────────────────────────

  it('TIMEOUT run when model throws MODEL_TIMEOUT', async () => {
    const { deps, task } = await makeTestDeps();
    const { ModelError } = await import('@codeforge/agent-core');
    model.setError(new ModelError('MODEL_TIMEOUT', 'took too long'));
    const executor = new TaskExecutor({ ...deps, executor: fakeExec });
    const result = await executor.execute(makeReq(task));
    expect(result.finalState).toBe('TIMEOUT');
  });

  // ── model output invalid → FAILED (after retries) ─────────────────────────

  it('FAILED when model output is permanently invalid JSON', async () => {
    const { deps, task } = await makeTestDeps();
    // FakeModel always returns garbage — parseModelOutput will exhaust retries.
    model.setResponse(/./, 'not valid json at all {{');
    const executor = new TaskExecutor({ ...deps, executor: fakeExec });
    const result = await executor.execute(makeReq(task));
    expect(result.finalState).toBe('FAILED');
  });

  // ── denied tool call → FAILED run ─────────────────────────────────────────

  it('FAILED when tool gateway denies the tool call', async () => {
    const { deps, task, db } = await makeTestDeps();
    // Use same DB (already seeded) with DEFAULT_TOOL_POLICY (denies DESTRUCTIVE).
    const { DEFAULT_TOOL_POLICY } = await import('@codeforge/agent-core');
    const now2 = makeNow();
    const nextId2 = makeIdGen();
    const events2 = new SqliteEventLog(db);
    const tc2 = new SqliteToolCallRepository(db);
    const ap2 = new SqliteApprovalRepository(db);
    const strictGateway = new ToolGateway({
      calls: tc2, approvals: ap2, events: events2,
      policy: DEFAULT_TOOL_POLICY, now: now2, nextId: nextId2,
    });

    model.setSequence([
      // delete_file is DESTRUCTIVE — DEFAULT_TOOL_POLICY denies DESTRUCTIVE tools.
      JSON.stringify({ type: 'tool_call', toolName: 'delete_file', arguments: { path: 'secret.ts' } }),
    ]);
    const executor = new TaskExecutor({ ...deps, toolGateway: strictGateway, executor: fakeExec });
    const result = await executor.execute(makeReq(task));
    expect(result.finalState).toBe('FAILED');
  });

  // ── executor failure → FAILED run ─────────────────────────────────────────

  it('FAILED when tool executor returns exitCode != 0', async () => {
    const { deps, task } = await makeTestDeps();
    const failingExec: ToolExecutor = {
      execute: async () => ({ exitCode: 1, stdout: '', stderr: 'error occurred', timedOut: false }),
    };
    model.setSequence([
      JSON.stringify({ type: 'tool_call', toolName: 'read_file', arguments: { path: 'x.ts' } }),
    ]);
    const executor = new TaskExecutor({ ...deps, executor: failingExec });
    const result = await executor.execute(makeReq(task));
    expect(result.finalState).toBe('FAILED');
  });

  // ── executor timeout → TIMEOUT run ────────────────────────────────────────

  it('TIMEOUT when tool executor returns timedOut=true', async () => {
    const { deps, task } = await makeTestDeps();
    const timedOutExec: ToolExecutor = {
      execute: async () => ({ exitCode: null, stdout: '', stderr: '', timedOut: true }),
    };
    model.setSequence([
      JSON.stringify({ type: 'tool_call', toolName: 'read_file', arguments: { path: 'x.ts' } }),
    ]);
    const executor = new TaskExecutor({ ...deps, executor: timedOutExec });
    const result = await executor.execute(makeReq(task));
    expect(result.finalState).toBe('TIMEOUT');
  });

  // ── finalize writes end revision (EX-L14) ─────────────────────────────────

  it('SUCCEEDED run finalized without error (EX-L14)', async () => {
    const { deps, task } = await makeTestDeps();
    const endRev = makeRevision('/end');
    model.setSequence([
      JSON.stringify({ type: 'done', summary: 'done' }),
    ]);
    const executor = new TaskExecutor({ ...deps, executor: fakeExec });
    const req = makeReq(task, { workspaceRevisionAtEnd: endRev });
    // If finalize throws (EX-L14 violated) this would throw TaskExecutorError.
    const result = await executor.execute(req);
    expect(result.finalState).toBe('SUCCEEDED');
  });

  // ── ExecutionCoordinator projection updated ────────────────────────────────

  it('projection state is VERIFYING after SUCCEEDED run', async () => {
    const { deps, task } = await makeTestDeps();
    model.setSequence([
      JSON.stringify({ type: 'done', summary: 'done' }),
    ]);
    const executor = new TaskExecutor({ ...deps, executor: fakeExec });
    await executor.execute(makeReq(task));

    const execution = await deps.executionCoordinator.get(task.taskId);
    // After SUCCEEDED, projection maps to 'VERIFYING'.
    expect(execution?.currentState).toBe('VERIFYING');
  });

  it('projection state is VERIFYING after FAILED run (verification decides)', async () => {
    const { deps, task } = await makeTestDeps();
    const { ModelError } = await import('@codeforge/agent-core');
    model.setError(new ModelError('MODEL_UNAVAILABLE'));
    const executor = new TaskExecutor({ ...deps, executor: fakeExec });
    await executor.execute(makeReq(task));

    const execution = await deps.executionCoordinator.get(task.taskId);
    // FAILED TaskRun → projection maps to 'VERIFYING' (ExecutionCoordinator.projectedStateAfterRun)
    expect(execution?.currentState).toBe('VERIFYING');
  });

  // ── EX-002: single active run ─────────────────────────────────────────────

  it('throws if a concurrent run is active (EX-002)', async () => {
    const { deps, task } = await makeTestDeps();
    // Simulate an already-running projection.
    await deps.executionCoordinator.onRunStarted(task.taskId, uid());

    model.setSequence([
      JSON.stringify({ type: 'done', summary: 'done' }),
    ]);
    const executor = new TaskExecutor({ ...deps, executor: fakeExec });

    // Should throw because coordinator will see MULTIPLE_ACTIVE_RUNS.
    await expect(executor.execute(makeReq(task))).rejects.toThrow();
  });

  // ── maxToolCalls validation ────────────────────────────────────────────────

  it('throws RangeError when maxToolCalls <= 0', () => {
    // Pass an intentionally incomplete deps object just to test constructor validation.
    expect(() => new TaskExecutor({ maxToolCalls: 0 } as unknown as TaskExecutorDeps)).toThrow(RangeError);
  });

  // ── durationMs is reported ────────────────────────────────────────────────

  it('reports durationMs >= 0', async () => {
    const { deps, task } = await makeTestDeps();
    model.setSequence([JSON.stringify({ type: 'done', summary: 'fast' })]);
    const executor = new TaskExecutor({ ...deps, executor: fakeExec });
    const result = await executor.execute(makeReq(task));
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });
});
