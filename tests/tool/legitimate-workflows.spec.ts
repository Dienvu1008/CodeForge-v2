/*
 * Copyright 2026 DienVu (Dienvu1008)
 * SPDX-License-Identifier: Apache-2.0
 */

// kernel-gap-closure task 1.8 — "legitimate workflows still work" matrix (Requirement 12).
// Regression guard against over-blocking: each row drives a real ToolGateway (buildToolPolicy(level)),
// the risk class from resolveToolRiskClass, and the real executors over a temp workspace. Processes go
// through FakeProcessSupervisor.
//
// TEST-FIRST: rows that call `resolveToolRiskClass` (task 3.3) or rely on the v2 policy (task 3.4)
// fail until then; rows using only current behaviour pass already.
//
// Allowlist note: DEFAULT_SHELL_ALLOWLIST (unchanged by this spec) has node, npm, git, python3 but NOT
// go, cargo, dart or `python`. For those rows the shell policy is extended in the test, so what is
// asserted is that the NEW rules (classification, argument checks) are not the reason for a block.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import {
  ToolGateway,
  buildToolPolicy,
  resolveToolRiskClass,
  createShellPolicy,
  DEFAULT_SHELL_ALLOWLIST,
  type AutonomyLevel,
  type Approval,
  type DomainEvent,
  type ExecutorResult,
  type RiskClass,
  type ToolCall,
  type ToolExecutor,
  type ToolCallPatch,
} from '@codeforge/agent-core';
import { NodeToolExecutor, NodeWorkspaceManager } from '@codeforge/infrastructure';
import { FakeProcessSupervisor } from '@codeforge/testing';

// ── harness ───────────────────────────────────────────────────────────────────────────────────

const NOW = '2026-01-01T00:00:00.000Z';

/** Test files that existed "at goal start" (the baseline the agent must not touch). */
const BASELINE_TESTS = new Set(['test/round.test.js', 'test.js']);
const TEST_BASELINE = { isBaselineTest: (p: string): boolean => BASELINE_TESTS.has(p) };

class MemCalls {
  readonly map = new Map<string, ToolCall>();
  async create(call: ToolCall): Promise<void> { this.map.set(call.toolCallId, call); }
  async getById(id: string): Promise<ToolCall | null> { return this.map.get(id) ?? null; }
  async transition(id: string, patch: ToolCallPatch): Promise<void> {
    const cur = this.map.get(id);
    if (cur !== undefined) this.map.set(id, { ...cur, ...patch } as ToolCall);
  }
}

class MemApprovals {
  readonly map = new Map<string, Approval>();
  async create(a: Approval): Promise<void> { this.map.set(a.toolCallId, a); }
  async getByToolCall(id: string): Promise<Approval | null> { return this.map.get(id) ?? null; }
}

const memEvents = {
  async append(_e: DomainEvent): Promise<void> { /* not under test */ },
  async *stream(): AsyncGenerator<DomainEvent> { /* empty */ },
  async query(): Promise<readonly DomainEvent[]> { return []; },
};

interface Outcome {
  readonly riskClass: RiskClass;
  /** State right after `ToolGateway.request` (APPROVED = allowed without a human). */
  readonly requestState: ToolCall['state'];
  /** Terminal state after the optional approval and execution; undefined when never executed. */
  readonly finalState: ToolCall['state'] | undefined;
  /** The executor result of the call, when it was executed. */
  readonly result: ExecutorResult | undefined;
}

let root: string;
let fake: FakeProcessSupervisor;
let seq: number;

function seed(rel: string, content: string): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf8');
}

function buildExecutor(extraCommands: readonly string[] = []): ToolExecutor {
  const workspace = new NodeWorkspaceManager({ root, now: () => NOW, nextId: () => `W-${seq++}` });
  const shellPolicy = createShellPolicy([...DEFAULT_SHELL_ALLOWLIST, ...extraCommands]);
  return new NodeToolExecutor({
    filesystem: { workspace },
    git: { workspace, supervisor: fake },
    shell: { workspace, supervisor: fake, shellPolicy },
  });
}

/**
 * Drive one proposal through risk resolution → ToolGateway.request → (optional approve) → execute.
 */
async function drive(
  level: AutonomyLevel,
  toolName: string,
  args: Record<string, unknown>,
  opts: { approve?: boolean; extraCommands?: readonly string[] } = {},
): Promise<Outcome> {
  const calls = new MemCalls();
  const gateway = new ToolGateway({
    calls, approvals: new MemApprovals(), events: memEvents,
    policy: buildToolPolicy(level), now: () => NOW, nextId: () => `ID-${seq++}`,
  });
  const riskClass = resolveToolRiskClass(toolName, args, { testBaseline: TEST_BASELINE });
  const toolCallId = `TC-${seq++}`;
  const requested = await gateway.request({
    toolCallId, sessionId: 'S', toolName, toolVersion: '1.0', riskClass,
    arguments: args, argumentsHash: `h-${toolCallId}`, state: 'REQUESTED', proposedBy: 'model',
    provenance: { provenanceId: 'PV', source: { kind: 'model', id: 'executor' }, inputs: [], reason: 't', at: NOW },
    requestedAt: NOW,
  });

  let state = requested.state;
  if (state === 'APPROVAL_PENDING' && opts.approve === true) {
    state = (await gateway.approve(toolCallId, 'user')).state;
  }
  if (state !== 'APPROVED') {
    return { riskClass, requestState: requested.state, finalState: undefined, result: undefined };
  }

  const inner = buildExecutor(opts.extraCommands);
  let result: ExecutorResult | undefined;
  const capturing: ToolExecutor = {
    execute: async (c) => { result = await inner.execute(c); return result; },
  };
  const done = await gateway.execute(toolCallId, capturing);
  return { riskClass, requestState: requested.state, finalState: done.state, result };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cf-legit-'));
  fake = new FakeProcessSupervisor();
  seq = 0;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// ── R12.1 verification commands ───────────────────────────────────────────────────────────────

describe('R12.1: verification commands run under full without approval', () => {
  const ROWS: ReadonlyArray<{ command: string; args: string[]; allowlisted: boolean }> = [
    { command: 'npm',     args: ['test'],              allowlisted: true  },
    { command: 'node',    args: ['test.js'],           allowlisted: true  },
    { command: 'go',      args: ['test', './...'],     allowlisted: false },
    { command: 'cargo',   args: ['test'],              allowlisted: false },
    { command: 'dart',    args: ['test'],              allowlisted: false },
    { command: 'python',  args: ['-m', 'pytest'],      allowlisted: false },
  ];

  it.each(ROWS)('$command $args executes: SYSTEM, allowed, spawned with the same args', async (row) => {
    // Pin which rows depend on the extended policy (the allowlist itself is not changed by this spec).
    expect(DEFAULT_SHELL_ALLOWLIST.has(row.command)).toBe(row.allowlisted);

    const out = await drive('full', 'run_command', { command: row.command, args: row.args }, {
      extraCommands: [row.command],
    });

    expect(out.riskClass).toBe('SYSTEM');
    expect(out.requestState).toBe('APPROVED');
    expect(out.finalState).toBe('SUCCEEDED');
    expect(fake.callCount).toBe(1);
    expect(fake.lastOptions?.command).toBe(row.command);
    expect(fake.lastOptions?.args).toEqual(row.args);
  });
});

// ── R12.2 rm -rf dist ─────────────────────────────────────────────────────────────────────────

describe('R12.2: rm -rf dist asks, then executes once approved', () => {
  it('is DESTRUCTIVE and requires approval under full (no spawn without a human)', async () => {
    seed('dist/bundle.js', 'x');
    const out = await drive('full', 'run_command', { command: 'rm', args: ['-rf', 'dist'] });

    expect(out.riskClass).toBe('DESTRUCTIVE');
    expect(out.requestState).toBe('APPROVAL_PENDING');
    expect(out.finalState).toBeUndefined();
    expect(fake.callCount).toBe(0);
  });

  it('spawns rm with args -rf dist after an approving coordinator', async () => {
    seed('dist/bundle.js', 'x');
    const out = await drive('full', 'run_command', { command: 'rm', args: ['-rf', 'dist'] }, { approve: true });

    expect(out.requestState).toBe('APPROVAL_PENDING');
    expect(out.finalState).toBe('SUCCEEDED');
    expect(fake.callCount).toBe(1);
    expect(fake.lastOptions?.command).toBe('rm');
    expect(fake.lastOptions?.args).toEqual(['-rf', 'dist']);
    expect(fake.lastOptions?.cwd.replace(/\\/g, '/')).toBe(root.replace(/\\/g, '/'));
  });
});

// ── R12.3 write_file of new files ─────────────────────────────────────────────────────────────

describe('R12.3: write_file of a new source or test file executes without approval', () => {
  const LEVELS: readonly AutonomyLevel[] = ['full', 'edits'];

  for (const level of LEVELS) {
    it(`new source file under ${level}`, async () => {
      const out = await drive(level, 'write_file', { path: 'src/feature.js', content: 'module.exports = 1;\n' });
      expect(out.riskClass).toBe('MODIFY_WORKSPACE');
      expect(out.requestState).toBe('APPROVED');
      expect(out.finalState).toBe('SUCCEEDED');
      expect(readFileSync(join(root, 'src', 'feature.js'), 'utf8')).toBe('module.exports = 1;\n');
    });

    it(`new test file under ${level} (not in the baseline)`, async () => {
      const out = await drive(level, 'write_file', { path: 'test/feature.test.js', content: 'it("x", () => {});\n' });
      expect(out.riskClass).toBe('MODIFY_WORKSPACE');
      expect(out.requestState).toBe('APPROVED');
      expect(out.finalState).toBe('SUCCEEDED');
      expect(existsSync(join(root, 'test', 'feature.test.js'))).toBe(true);
    });
  }
});

// ── R12.4 reads that look sensitive but are not ───────────────────────────────────────────────

describe('R12.4: read_file returns .env.example, src/env.js and .github/workflows/ci.yml', () => {
  const FILES: ReadonlyArray<readonly [string, string]> = [
    ['.env.example', 'API_URL=http://localhost\n'],
    ['src/env.js', 'export const env = {};\n'],
    ['.github/workflows/ci.yml', 'name: ci\non: push\n'],
  ];

  it.each(FILES)('%s', async (path, content) => {
    seed(path, content);
    const out = await drive('full', 'read_file', { path });

    expect(out.riskClass).toBe('READ_ONLY');
    expect(out.requestState).toBe('APPROVED');
    expect(out.finalState).toBe('SUCCEEDED');
    expect(out.result?.exitCode).toBe(0);
    expect(out.result?.stdout).toContain(content.trim().split('\n')[0]);
  });
});

// ── R12.5 edit_file on non-test source ────────────────────────────────────────────────────────

describe('R12.5: edit_file on a non-test source file executes without approval', () => {
  for (const level of ['full', 'edits'] as const) {
    it(`under ${level}`, async () => {
      seed('src/app.js', 'const a = 1;\n');
      seed('test/round.test.js', 'it("x", () => {});\n'); // a baseline test exists, but is not touched
      const out = await drive(level, 'edit_file', { path: 'src/app.js', oldString: 'a = 1', newString: 'a = 2' });

      expect(out.riskClass).toBe('MODIFY_WORKSPACE');
      expect(out.requestState).toBe('APPROVED');
      expect(out.finalState).toBe('SUCCEEDED');
      expect(readFileSync(join(root, 'src', 'app.js'), 'utf8')).toBe('const a = 2;\n');
    });
  }
});

// ── R12.6 git tools unchanged ─────────────────────────────────────────────────────────────────

describe('R12.6: git tools behave as before', () => {
  const ROWS: ReadonlyArray<{
    tool: string; args: Record<string, unknown>; risk: RiskClass; gitArgs: string[];
  }> = [
    { tool: 'git_status', args: {},                         risk: 'READ_ONLY',        gitArgs: ['status'] },
    { tool: 'git_diff',   args: { path: 'src/app.js' },     risk: 'READ_ONLY',        gitArgs: ['diff', '--no-color', '--', 'src/app.js'] },
    { tool: 'git_add',    args: { paths: ['src/app.js'] },  risk: 'MODIFY_WORKSPACE', gitArgs: ['add', '--', 'src/app.js'] },
    { tool: 'git_commit', args: { message: 'feat: x' },     risk: 'MODIFY_WORKSPACE', gitArgs: ['commit', '--no-edit', '--no-gpg-sign', '-m', 'feat: x'] },
    { tool: 'git_log',    args: { n: 5 },                   risk: 'READ_ONLY',        gitArgs: ['log', '--max-count=5', '--oneline', '--no-color'] },
  ];

  for (const level of ['full', 'edits'] as const) {
    it.each(ROWS)(`$tool keeps risk $risk and executes via the supervisor under ${level}`, async (row) => {
      const out = await drive(level, row.tool, row.args);

      expect(out.riskClass).toBe(row.risk);
      expect(out.requestState).toBe('APPROVED');
      expect(out.finalState).toBe('SUCCEEDED');
      expect(fake.callCount).toBe(1);
      const spawnArgs = fake.lastOptions?.args ?? [];
      // GitExecutor may add global options (e.g. --no-pager); the subcommand arguments must follow.
      expect(spawnArgs.join('\u0000')).toContain(row.gitArgs.join('\u0000'));
    });
  }
});
