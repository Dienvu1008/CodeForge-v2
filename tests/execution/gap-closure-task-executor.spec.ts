/*
 * Copyright 2026 DienVu (Dienvu1008)
 * SPDX-License-Identifier: Apache-2.0
 */

// kernel-gap-closure task 1.7 — TEST-FIRST. TaskExecutor + real ToolGateway(buildToolPolicy) +
// real NodeToolExecutor over a temp workspace + SQLite :memory:.
//
// Expected to FAIL until the implementation tasks land:
//   - `WorkspaceTestBaseline` (infrastructure) and `TaskExecutorDeps.testBaseline` do not exist yet;
//   - run_command is still always SYSTEM (no DESTRUCTIVE/NETWORK classification, NETWORK is not
//     require_approval under `full`), so Property 17 fails for `full`;
//   - `.env` reads are not yet rejected (SENSITIVE_PATH);
//   - runtime-cli.ts does not yet wire WorkspaceTestBaseline.
//
// Property 17 iteration count: 100 (each iteration builds 2 TaskExecutors on SQLite :memory: and
// reuses one temp workspace; measured cheap, so the full 100 is kept).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TaskExecutor,
  ExecutionCoordinator,
  TaskRunService,
  ContextBuilder,
  ToolGateway,
  NoopProcessReconciler,
  buildToolPolicy,
  type ApprovalCoordinator,
  type ApprovalDecision,
  type ToolExecutor,
  type ToolCall,
  type Task,
  type TaskExecutorRequest,
  type TaskExecutorResult,
  type WorkspaceRevision,
} from '@codeforge/agent-core';
import {
  NodeToolExecutor,
  NodeWorkspaceManager,
  WorkspaceTestBaseline,
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
import { forAllAsync, pick, pathOf, plainArgs, pathSegment, int } from '../tool/gap-closure-generators.js';

const here = dirname(fileURLToPath(import.meta.url));
const REPO = join(here, '..', '..');

type Level = 'readonly' | 'edits' | 'full';
const LEVELS: readonly Level[] = ['readonly', 'edits', 'full'];

const ISO = '2026-01-01T00:00:00.000Z';

function makeRevision(): WorkspaceRevision {
  return {
    revisionId: 'rev-1', canonicalFormVersion: 'v1', root: '/r',
    includedPaths: [], excludedScratchPaths: [],
    hashAlgorithm: 'blake3', hash: 'H', fileCount: 0, totalBytes: 0,
    createdAt: ISO, createdBy: { sessionId: 'SE-0001', reason: 'session_start' },
  };
}

const TASK: Task = {
  taskId: 'T1', description: 'work on the project', strategy: { kind: 'generate' },
  acceptanceCriteria: [], constraints: [], priority: 1, createdAt: ISO, createdBy: 'planner',
};

function req(): TaskExecutorRequest {
  const rev = makeRevision();
  return {
    sessionId: 'SE-0001', task: TASK, attemptNumber: 1, graphVersion: 1,
    workspaceRevisionAtStart: rev, workspaceRevisionAtEnd: rev,
  };
}

// ── temp workspace ───────────────────────────────────────────────────────────────────────────

let root: string;

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'cf-gap-te-')));
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function seedWorkspace(): void {
  mkdirSync(join(root, 'tests'), { recursive: true });
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'tests', 'a.test.ts'), 'expect(1).toBe(1);\n');
  writeFileSync(join(root, 'src', 'x.ts'), 'export const x = 1;\n');
  writeFileSync(join(root, '.env'), 'SECRET=hunter2\n');
}

// ── harness ──────────────────────────────────────────────────────────────────────────────────

interface Harness {
  readonly result: TaskExecutorResult;
  readonly model: FakeModel;
  readonly supervisor: FakeProcessSupervisor;
  /** Tool names that reached the executor (i.e. actually executed). */
  readonly executed: string[];
  readonly calls: readonly ToolCall[];
  readonly db: SqliteDatabaseAdapter;
}

interface RunOpts {
  readonly level: Level;
  readonly steps: readonly object[];
  readonly decision?: ApprovalDecision; // undefined → no ApprovalCoordinator wired
  readonly baseline?: boolean;          // wire a captured WorkspaceTestBaseline
}

async function runScripted(opts: RunOpts): Promise<Harness> {
  const db = new SqliteDatabaseAdapter(':memory:');
  db.open();
  runMigrations(db, createMigrationRegistry(), { now: () => ISO });

  let t = 0; let n = 0;
  const now = (): string => `2026-01-01T00:${String(Math.floor(t / 60) % 60).padStart(2, '0')}:${String(t++ % 60).padStart(2, '0')}.000Z`;
  const nextId = (): string => `ID-${String(++n).padStart(6, '0')}`;

  db.execute(
    `INSERT INTO sessions
       (session_id, workspace_id, workspace_root, goal_id, graph_version, state,
        created_at, updated_at, runtime_version, schema_version, budget_id, lock_id, metadata_json)
     VALUES ('SE-0001','WS-001','/tmp/ws','GOAL-001',1,'RUNNING',?,?,'0.4.0',1,'B','L','{}')`,
    [ISO, ISO],
  );
  db.execute(
    `INSERT INTO tasks
       (task_id, description, acceptance_json, constraints_json, priority,
        strategy_json, created_at, created_by, schema_version)
     VALUES ('T1','t','[]','[]',1,'{"kind":"generate"}',?, 'planner',1)`,
    [ISO],
  );

  const events = new SqliteEventLog(db);
  const toolCalls = new SqliteToolCallRepository(db);
  const coordinator = new ExecutionCoordinator({ executions: new SqliteTaskExecutionRepository(db), now });
  await coordinator.init('T1');
  const runSvc = new TaskRunService({
    runs: new SqliteTaskRunRepository(db), events, reconciler: new NoopProcessReconciler(), now, nextId,
  });
  const tg = new ToolGateway({
    calls: toolCalls, approvals: new SqliteApprovalRepository(db), events,
    policy: buildToolPolicy(opts.level), now, nextId,
  });

  const supervisor = new FakeProcessSupervisor();
  const ws = new NodeWorkspaceManager({ root, now: () => new Date().toISOString(), nextId });
  const real = new NodeToolExecutor({
    filesystem: { workspace: ws },
    git: { workspace: ws, supervisor },
    shell: { workspace: ws, supervisor },
  });
  const executed: string[] = [];
  const executor: ToolExecutor = {
    execute: async (call) => { executed.push(call.toolName); return real.execute(call); },
  };

  const model = new FakeModel();
  model.setSequence(opts.steps.map((s) => JSON.stringify(s)));

  let approvalCoordinator: ApprovalCoordinator | undefined;
  if (opts.decision !== undefined) {
    const decision = opts.decision;
    approvalCoordinator = {
      awaitDecision: async (_s, toolCallId) => {
        if (decision === 'approved') await tg.approve(toolCallId, 'user');
        else if (decision === 'denied') await tg.deny(toolCallId, 'user', 'no');
        return decision;
      },
    };
  }

  let testBaseline: WorkspaceTestBaseline | undefined;
  if (opts.baseline === true) {
    testBaseline = new WorkspaceTestBaseline({ root });
    await testBaseline.capture();
  }

  const exec = new TaskExecutor({
    taskRunService: runSvc, executionCoordinator: coordinator,
    contextBuilder: new ContextBuilder({ now, nextId }), gateway: model,
    toolGateway: tg, executor,
    ...(approvalCoordinator !== undefined ? { approvalCoordinator } : {}),
    ...(testBaseline !== undefined ? { testBaseline } : {}),
    now, nextId,
  });

  const result = await exec.execute(req());
  const calls = await toolCalls.listBySession('SE-0001');
  return { result, model, supervisor, executed, calls, db };
}

const DONE = { type: 'done', summary: 'finished' };
const LIST = { type: 'tool_call', toolName: 'list_dir', arguments: { path: '.' } };
const tc = (toolName: string, args: Record<string, unknown>): object => ({ type: 'tool_call', toolName, arguments: args });

// ── Property 17 ──────────────────────────────────────────────────────────────────────────────

describe('Property 17: Unapproved risky calls never execute', () => {
  // Feature: kernel-gap-closure, Property 17: Unapproved risky calls never execute
  it('DESTRUCTIVE and NETWORK run_command: no coordinator → APPROVAL_PENDING with zero executor calls; denying coordinator → run continues, call never executes (100 iterations)', async () => {
    // **Validates: Requirements 3.6, 9.6, 11.1, 11.2**
    seedWorkspace();
    await forAllAsync(0x17ac, 100, async (rng) => {
      const level = pick(rng, LEVELS);
      const risky = pick(rng, ['destructive', 'network'] as const);
      let command: string;
      let args: string[];
      if (risky === 'destructive') {
        command = pick(rng, ['rm', 'rmdir', 'shred']);
        args = [...(command === 'rm' ? ['-rf'] : []), pathOf(rng)];
      } else {
        const host = `${pathSegment(rng)}.example.com`;
        const form = int(rng, 0, 2);
        if (form === 0) { command = pick(rng, ['curl', 'wget']); args = [...plainArgs(rng, int(rng, 0, 2)), `https://${host}/${pathSegment(rng)}`]; }
        else if (form === 1) { command = 'git'; args = [pick(rng, ['push', 'fetch', 'pull', 'clone']), ...plainArgs(rng, int(rng, 0, 2))]; }
        else { command = pick(rng, ['ssh', 'scp']); args = [`${pathSegment(rng)}@${host}`]; }
      }
      const risky_call = tc('run_command', { command, args });

      // (a) no coordinator → run ends at APPROVAL_PENDING, nothing executes.
      const a = await runScripted({ level, steps: [risky_call, LIST, DONE, DONE] });
      try {
        expect(a.result.pendingApprovalToolCallId, `${level} ${command} ${args.join(' ')}`).toBeDefined();
        const pending = a.calls.find((c) => c.toolCallId === a.result.pendingApprovalToolCallId);
        expect(pending?.state).toBe('APPROVAL_PENDING');
        expect(a.executed).toEqual([]);
        expect(a.supervisor.callCount).toBe(0);
      } finally { a.db.close(); }

      // (b) denying coordinator → run CONTINUES (list_dir runs), risky call never executes.
      const b = await runScripted({ level, decision: 'denied', steps: [risky_call, LIST, DONE, DONE] });
      try {
        expect(b.executed).toEqual(['list_dir']);
        expect(b.supervisor.callCount).toBe(0);
        expect(b.result.pendingApprovalToolCallId).toBeUndefined();
        expect(b.model.callCount).toBeGreaterThanOrEqual(3);
      } finally { b.db.close(); }
    });
  });
});

// ── examples: non-fatal rejections ───────────────────────────────────────────────────────────

describe('rejected path / secret read are FAILED tool results; the run continues', () => {
  for (const [label, path] of [['rejected path', '../x'], ['secret read', '.env']] as const) {
    it(`${label}: read_file ${path} → FAILED (not DENIED) and the next scripted step runs`, async () => {
      // **Validates: Requirements 3.6, 9.6**
      seedWorkspace();
      const h = await runScripted({ level: 'full', steps: [tc('read_file', { path }), LIST, DONE, DONE] });
      try {
        const first = h.calls[0];
        expect(first?.toolName).toBe('read_file');
        expect(first?.state).not.toBe('DENIED');
        expect(first?.state).toBe('FAILED');
        expect(h.executed).toEqual(['read_file', 'list_dir']); // the next step ran
        expect(h.result.pendingApprovalToolCallId).toBeUndefined();
        expect(h.result.finalState).toBe('SUCCEEDED');
        // the secret value never reaches the tool result
        expect(JSON.stringify(first?.result ?? {})).not.toContain('hunter2');
      } finally { h.db.close(); }
    });
  }
});

// ── examples: test baseline (G5) ─────────────────────────────────────────────────────────────

describe('test baseline escalation', () => {
  const EDIT = tc('edit_file', { path: 'tests/a.test.ts', oldString: 'toBe(1)', newString: 'toBe(2)' });

  it('editing a baseline test with no coordinator ends at APPROVAL_PENDING and does not modify the file', async () => {
    // **Validates: Requirements 9.7, 11.5**
    seedWorkspace();
    const h = await runScripted({ level: 'full', baseline: true, steps: [EDIT, DONE, DONE] });
    try {
      expect(h.result.pendingApprovalToolCallId).toBeDefined();
      expect(h.executed).toEqual([]);
      expect(readFileSync(join(root, 'tests', 'a.test.ts'), 'utf8')).toContain('toBe(1)');
    } finally { h.db.close(); }
  });

  it('creating a NEW test file (not in the baseline) executes', async () => {
    // **Validates: Requirements 9.7, 11.5**
    seedWorkspace();
    const h = await runScripted({
      level: 'full', baseline: true,
      steps: [tc('write_file', { path: 'tests/new.test.ts', content: 'ok\n' }), DONE],
    });
    try {
      expect(h.executed).toEqual(['write_file']);
      expect(existsSync(join(root, 'tests', 'new.test.ts'))).toBe(true);
      expect(h.result.pendingApprovalToolCallId).toBeUndefined();
    } finally { h.db.close(); }
  });

  it('with NO testBaseline dep the same edit executes (backward compatibility)', async () => {
    // **Validates: Requirements 9.7, 11.5**
    seedWorkspace();
    const h = await runScripted({ level: 'full', baseline: false, steps: [EDIT, DONE] });
    try {
      expect(h.executed).toEqual(['edit_file']);
      expect(h.result.pendingApprovalToolCallId).toBeUndefined();
      expect(readFileSync(join(root, 'tests', 'a.test.ts'), 'utf8')).toContain('toBe(2)');
    } finally { h.db.close(); }
  });
});

// ── static wiring check ──────────────────────────────────────────────────────────────────────

describe('runtime-cli.ts wires WorkspaceTestBaseline (static)', () => {
  const src = readFileSync(join(REPO, 'packages', 'infrastructure', 'src', 'cli', 'runtime-cli.ts'), 'utf8');

  it('constructs it, captures beside captureClean, and passes the same instance to TaskExecutor as testBaseline', () => {
    // **Validates: Requirements 11.5**
    const ctor = /(?:const|let)\s+(\w+)\s*=\s*new\s+WorkspaceTestBaseline\s*\(/.exec(src);
    expect(ctor, 'new WorkspaceTestBaseline(...) assigned to a variable').not.toBeNull();
    const ident = ctor?.[1] ?? '';

    const captureIdx = src.search(new RegExp(`\\b${ident}\\.capture\\s*\\(`));
    const cleanIdx = src.indexOf('captureClean(');
    expect(captureIdx, `${ident}.capture() call`).toBeGreaterThanOrEqual(0);
    expect(cleanIdx, 'captureClean( call').toBeGreaterThanOrEqual(0);
    expect(Math.abs(captureIdx - cleanIdx), 'capture() sits beside captureClean').toBeLessThan(600);

    const start = src.indexOf('new TaskExecutor(');
    expect(start).toBeGreaterThanOrEqual(0);
    const end = src.indexOf('});', start);
    const block = src.slice(start, end);
    const passes = ident === 'testBaseline'
      ? /\btestBaseline\b\s*[,}\n]|\btestBaseline\s*:\s*testBaseline\b/.test(block)
      : new RegExp(`\\btestBaseline\\s*:\\s*${ident}\\b`).test(block);
    expect(passes, `TaskExecutor deps pass testBaseline: ${ident}`).toBe(true);
  });
});
