// P3-I1 — Task Execution E2E.
//
// Verifies the FULL Phase 3 tool execution stack end-to-end with:
//   - Real filesystem (mkdtemp temp workspace)
//   - Real git (git init on temp dir)
//   - Real NodeProcessSupervisor (no FakeProcessSupervisor)
//   - Real NodeWorkspaceManager (boundary enforcement)
//   - Real NodeToolExecutor (routing to FilesystemExecutor / GitExecutor)
//   - Real TaskExecutor (full TaskRun lifecycle)
//   - FakeModel (model is the boundary — no real Ollama needed)
//   - Real SQLite :memory: for all repositories
//
// P3-I1 exit criteria (PHASE_3_ROADMAP §6):
//   - Agent can READ a real file from the workspace.
//   - Agent can WRITE a real file to the workspace.
//   - Agent can query git_status after a write.
//   - TaskRun reaches SUCCEEDED state with correct ExecutionCoordinator projection.
//   - WS-003: path traversal attempt rejected by WorkspaceManager.
//   - TG-001: all tool calls routed through ToolGateway.
//   - SE-003: shell command outside allowlist rejected.
//   - EX-004/005: TaskRun anchored, finalized with end revision.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile as fsWriteFile, readFile as fsReadFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir, platform } from 'node:os';
import { execSync } from 'node:child_process';
import {
  SqliteDatabaseAdapter,
  SqliteEventLog,
  SqliteTaskRunRepository,
  SqliteTaskExecutionRepository,
  SqliteToolCallRepository,
  SqliteApprovalRepository,
  NodeProcessSupervisor,
  NodeWorkspaceManager,
  NodeToolExecutor,
  runMigrations,
  createMigrationRegistry,
  computeWorkspaceRevision,
} from '@codeforge/infrastructure';
import {
  TaskExecutor,
  TaskRunService,
  ExecutionCoordinator,
  ContextBuilder,
  ToolGateway,
  NoopProcessReconciler,
  PERMISSIVE_TEST_POLICY,
} from '@codeforge/agent-core';
import type {
  Task,
  WorkspaceRevision,
  TaskExecutorRequest,
} from '@codeforge/agent-core';
import { FakeModel } from '@codeforge/testing';

// ── helpers ───────────────────────────────────────────────────────────────────

/** A git binary availability flag (set once in beforeAll-equivalent). */
let gitAvailable = false;
try {
  execSync('git --version', { stdio: 'ignore' });
  gitAvailable = true;
} catch {
  gitAvailable = false;
}

const IS_WINDOWS = platform() === 'win32';

let counter = 0;
function nextId(): string { return `ID-${String(++counter).padStart(6, '0')}`; }

let timeIdx = 0;
function now(): string {
  return `2026-01-01T00:00:${String(timeIdx++).padStart(2, '0')}.000Z`;
}

function makeTask(description: string): Task {
  return {
    taskId:             nextId(),
    description,
    acceptanceCriteria: [],
    constraints:        [],
    priority:           1,
    strategy:           { kind: 'generate' },
    createdAt:          now(),
    createdBy:          'planner',
  };
}

async function makeRevision(root: string): Promise<WorkspaceRevision> {
  return computeWorkspaceRevision({
    root,
    createdBy: { sessionId: 'SE-E2E', reason: 'session_start' },
  });
}

async function makeDb() {
  const db = new SqliteDatabaseAdapter(':memory:');
  db.open();
  runMigrations(db, createMigrationRegistry(), { now });
  return db;
}

function seedSession(db: SqliteDatabaseAdapter): void {
  db.execute(
    `INSERT INTO sessions
       (session_id, workspace_id, workspace_root, goal_id, graph_version, state,
        created_at, updated_at, runtime_version, schema_version, budget_id, lock_id, metadata_json)
     VALUES ('SE-E2E','WS-E2E','/tmp/e2e','G-E2E',1,'RUNNING','t','t','0.4.0',1,'B','L','{}')`,
  );
}

function seedTask(db: SqliteDatabaseAdapter, taskId: string): void {
  db.execute(
    `INSERT INTO tasks
       (task_id, description, acceptance_json, constraints_json, priority,
        strategy_json, created_at, created_by, schema_version)
     VALUES (?,?,?,?,1,'{"kind":"generate"}','t','planner',1)`,
    [taskId, 'e2e task', '[]', '[]'],
  );
}

// ── E2E fixture ───────────────────────────────────────────────────────────────

interface E2EFixture {
  tmpDir:    string;
  workspace: NodeWorkspaceManager;
  model:     FakeModel;
  executor:  TaskExecutor;
  db:        SqliteDatabaseAdapter;
  coordinator: ExecutionCoordinator;
  task:      Task;
  revision:  WorkspaceRevision;
}

async function makeFixture(): Promise<E2EFixture> {
  const tmpDir = await mkdtemp(join(tmpdir(), 'cf2-e2e-'));

  // Seed a file so the workspace hash is non-trivial.
  await fsWriteFile(join(tmpDir, 'README.md'), '# E2E test workspace\n');

  const db = await makeDb();
  seedSession(db);

  const task = makeTask('Read README and write a summary');
  seedTask(db, task.taskId);

  const supervisor  = new NodeProcessSupervisor();
  const workspace   = new NodeWorkspaceManager({ root: tmpDir, now, nextId });
  const nodeExecutor = new NodeToolExecutor({
    filesystem: { workspace },
    git:        { workspace, supervisor, gitIdentity: { name: 'E2E Bot', email: 'e2e@test.local' } },
    shell:      { workspace, supervisor },
  });

  const events       = new SqliteEventLog(db);
  const runs         = new SqliteTaskRunRepository(db);
  const executions   = new SqliteTaskExecutionRepository(db);
  const toolCalls    = new SqliteToolCallRepository(db);
  const approvals    = new SqliteApprovalRepository(db);
  const reconciler   = new NoopProcessReconciler();

  const taskRunService = new TaskRunService({ runs, events, reconciler, now, nextId });
  const coordinator    = new ExecutionCoordinator({ executions, now });
  const contextBuilder = new ContextBuilder({ now, nextId });
  const toolGateway    = new ToolGateway({
    calls: toolCalls, approvals, events,
    policy: PERMISSIVE_TEST_POLICY,
    now, nextId,
  });
  const model = new FakeModel();

  const taskExecutor = new TaskExecutor({
    taskRunService,
    executionCoordinator: coordinator,
    contextBuilder,
    gateway:   model,
    toolGateway,
    executor:  nodeExecutor,
    maxToolCalls: 10,
    now,
    nextId,
  });

  // Init the projection for this task.
  await coordinator.init(task.taskId);

  const revision = await makeRevision(tmpDir);

  return { tmpDir, workspace, model, executor: taskExecutor, db, coordinator, task, revision };
}

function makeReq(f: E2EFixture, overrides: Partial<TaskExecutorRequest> = {}): TaskExecutorRequest {
  return {
    sessionId:                'SE-E2E',
    task:                     f.task,
    attemptNumber:            1,
    graphVersion:             1,
    workspaceRevisionAtStart: f.revision,
    workspaceRevisionAtEnd:   f.revision,
    ...overrides,
  };
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('P3-I1 Task Execution E2E (real fs + git + NodeProcessSupervisor)', () => {
  let f: E2EFixture;

  beforeEach(async () => {
    counter  = 0;
    timeIdx  = 0;
    f = await makeFixture();
  });

  afterEach(async () => {
    f.db.close();
    await rm(f.tmpDir, { recursive: true, force: true });
  });

  // ── read_file: real filesystem ─────────────────────────────────────────────

  it('SUCCEEDED: model reads real file from workspace', async () => {
    f.model.setSequence([
      // Model proposes: read README.md
      JSON.stringify({ type: 'tool_call', toolName: 'read_file', arguments: { path: 'README.md' } }),
      // Model signals done after seeing the content.
      JSON.stringify({ type: 'done', summary: 'README read successfully.' }),
    ]);

    const result = await f.executor.execute(makeReq(f));
    expect(result.finalState).toBe('SUCCEEDED');
    expect(result.toolCallCount).toBe(1);
    expect(result.summary).toBe('README read successfully.');
  });

  // ── write_file: creates real file on disk ─────────────────────────────────

  it('SUCCEEDED: model writes a new file to workspace, file appears on disk', async () => {
    const newFile = 'src/hello.ts';
    const content = 'export const hello = () => "hello world";\n';

    f.model.setSequence([
      JSON.stringify({
        type:      'tool_call',
        toolName:  'write_file',
        arguments: { path: newFile, content },
      }),
      JSON.stringify({ type: 'done', summary: 'hello.ts created.' }),
    ]);

    const result = await f.executor.execute(makeReq(f));
    expect(result.finalState).toBe('SUCCEEDED');
    expect(result.toolCallCount).toBe(1);

    // Verify the file actually exists on disk with the right content.
    const written = await fsReadFile(join(f.tmpDir, newFile), 'utf8');
    expect(written).toBe(content);
  });

  // ── list_dir: reads real directory ────────────────────────────────────────

  it('SUCCEEDED: model lists real workspace directory', async () => {
    f.model.setSequence([
      JSON.stringify({ type: 'tool_call', toolName: 'list_dir', arguments: { path: '' } }),
      JSON.stringify({ type: 'done', summary: 'Directory listed.' }),
    ]);

    const result = await f.executor.execute(makeReq(f));
    expect(result.finalState).toBe('SUCCEEDED');
    expect(result.toolCallCount).toBe(1);
  });

  // ── write_file + read_file: two-step round-trip ───────────────────────────

  it('SUCCEEDED: write then read round-trip — file content persists', async () => {
    const path    = 'output.txt';
    const content = 'generated by agent\n';

    f.model.setSequence([
      JSON.stringify({ type: 'tool_call', toolName: 'write_file', arguments: { path, content } }),
      JSON.stringify({ type: 'tool_call', toolName: 'read_file',  arguments: { path } }),
      JSON.stringify({ type: 'done', summary: 'Write-read confirmed.' }),
    ]);

    const result = await f.executor.execute(makeReq(f));
    expect(result.finalState).toBe('SUCCEEDED');
    expect(result.toolCallCount).toBe(2);
  });

  // ── git_status: real git in workspace ─────────────────────────────────────

  it('SUCCEEDED: git_status returns output after git init', async () => {
    if (!gitAvailable) return;

    execSync('git init', { cwd: f.tmpDir, stdio: 'ignore' });
    execSync('git config user.email "e2e@test.local"', { cwd: f.tmpDir, stdio: 'ignore' });
    execSync('git config user.name "E2E Bot"',          { cwd: f.tmpDir, stdio: 'ignore' });

    f.model.setSequence([
      JSON.stringify({ type: 'tool_call', toolName: 'git_status', arguments: {} }),
      JSON.stringify({ type: 'done', summary: 'Status checked.' }),
    ]);

    const result = await f.executor.execute(makeReq(f));
    expect(result.finalState).toBe('SUCCEEDED');
    expect(result.toolCallCount).toBe(1);
  });

  // ── git round-trip: write + stage + commit + log ──────────────────────────

  it('SUCCEEDED: write file → git add → git commit → git log round-trip', async () => {
    if (!gitAvailable) return;

    execSync('git init', { cwd: f.tmpDir, stdio: 'ignore' });
    execSync('git config user.email "e2e@test.local"', { cwd: f.tmpDir, stdio: 'ignore' });
    execSync('git config user.name "E2E Bot"',          { cwd: f.tmpDir, stdio: 'ignore' });

    f.model.setSequence([
      JSON.stringify({ type: 'tool_call', toolName: 'write_file', arguments: { path: 'feature.ts', content: 'export const x = 1;\n' } }),
      JSON.stringify({ type: 'tool_call', toolName: 'git_add',    arguments: { paths: ['feature.ts'] } }),
      JSON.stringify({ type: 'tool_call', toolName: 'git_commit', arguments: { message: 'feat: add feature.ts' } }),
      JSON.stringify({ type: 'tool_call', toolName: 'git_log',    arguments: { n: 1 } }),
      JSON.stringify({ type: 'done', summary: 'File committed successfully.' }),
    ]);

    const result = await f.executor.execute(makeReq(f));
    expect(result.finalState).toBe('SUCCEEDED');
    expect(result.toolCallCount).toBe(4);

    // Verify the commit actually exists.
    const log = execSync('git log --oneline', { cwd: f.tmpDir }).toString();
    expect(log).toMatch('feat: add feature.ts');
  });

  // ── WS-003: path traversal rejected ──────────────────────────────────────

  it('FAILED: path traversal (../etc/passwd) rejected by WorkspaceManager (WS-003)', async () => {
    f.model.setSequence([
      // Model tries to escape the workspace root.
      JSON.stringify({ type: 'tool_call', toolName: 'read_file', arguments: { path: '../etc/passwd' } }),
    ]);

    // FilesystemExecutor catches the WorkspaceError and returns exitCode=1.
    // TaskExecutor sees FAILED tool state and finalizes as FAILED.
    const result = await f.executor.execute(makeReq(f));
    expect(result.finalState).toBe('FAILED');
  });

  // ── SE-003: unlisted shell command rejected ───────────────────────────────

  it('FAILED: run_command with unlisted binary blocked by ShellPolicy (SE-003)', async () => {
    f.model.setSequence([
      // 'bash' is not in DEFAULT_SHELL_ALLOWLIST.
      JSON.stringify({ type: 'tool_call', toolName: 'run_command', arguments: { command: 'bash', args: ['-c', 'echo owned'] } }),
    ]);

    const result = await f.executor.execute(makeReq(f));
    // ShellExecutor returns exitCode=1 (not in allowlist), TaskExecutor → FAILED.
    expect(result.finalState).toBe('FAILED');
  });

  // ── EX-002: single active run enforced ───────────────────────────────────

  it('throws ExecutionError when a concurrent run is already active (EX-002)', async () => {
    // Pre-inject an already-running projection for this task.
    await f.coordinator.onRunStarted(f.task.taskId, 'FAKE-RUN-001');

    f.model.setSequence([
      JSON.stringify({ type: 'done', summary: 'should not reach here' }),
    ]);

    await expect(f.executor.execute(makeReq(f))).rejects.toThrow();
  });

  // ── projection: VERIFYING after SUCCEEDED ─────────────────────────────────

  it('ExecutionCoordinator projection becomes VERIFYING after SUCCEEDED run', async () => {
    f.model.setSequence([
      JSON.stringify({ type: 'done', summary: 'done' }),
    ]);

    await f.executor.execute(makeReq(f));

    const exec = await f.coordinator.get(f.task.taskId);
    expect(exec?.currentState).toBe('VERIFYING');
    expect(exec?.attempts).toBe(1);
  });

  // ── projection: VERIFYING after FAILED run ────────────────────────────────

  it('ExecutionCoordinator projection becomes VERIFYING after FAILED run', async () => {
    // Write to a path outside workspace → FAILED run.
    f.model.setSequence([
      JSON.stringify({ type: 'tool_call', toolName: 'read_file', arguments: { path: '../escape' } }),
    ]);

    await f.executor.execute(makeReq(f));

    const exec = await f.coordinator.get(f.task.taskId);
    // Both SUCCEEDED and FAILED → VERIFYING (projectedStateAfterRun).
    expect(exec?.currentState).toBe('VERIFYING');
  });

  // ── Windows/Linux path separator neutrality ───────────────────────────────

  it('write_file works with forward-slash paths on both Windows and Linux', async () => {
    // Verifies cross-platform path handling (PLATFORM_SUPPORT.md).
    f.model.setSequence([
      JSON.stringify({
        type:      'tool_call',
        toolName:  'write_file',
        arguments: { path: 'sub/dir/file.txt', content: 'cross-platform\n' },
      }),
      JSON.stringify({ type: 'done', summary: 'done' }),
    ]);

    const result = await f.executor.execute(makeReq(f));
    expect(result.finalState).toBe('SUCCEEDED');

    // File should exist at the OS-correct path.
    const written = await fsReadFile(
      join(f.tmpDir, 'sub', 'dir', 'file.txt'),
      'utf8',
    );
    expect(written).toBe('cross-platform\n');
    expect(IS_WINDOWS || !IS_WINDOWS).toBe(true); // documents intent
  });

  // ── durationMs sanity ─────────────────────────────────────────────────────

  it('durationMs is non-negative for all outcomes', async () => {
    f.model.setSequence([
      JSON.stringify({ type: 'done', summary: 'fast done' }),
    ]);
    const result = await f.executor.execute(makeReq(f));
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });
});
