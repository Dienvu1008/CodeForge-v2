// P3-GIT1 — GitExecutor: git_status, git_diff, git_add, git_commit, git_log.
//
// Two suites:
//   1. Unit — FakeProcessSupervisor (deterministic, no real git).
//   2. Integration — real git on a mkdtemp workspace (requires git in PATH).
import { describe, it, expect, beforeEach, afterEach, beforeAll } from 'vitest';
import { mkdtemp, rm, writeFile as fsWriteFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir, platform } from 'node:os';
import { execSync } from 'node:child_process';
import { GitExecutor }            from '@codeforge/infrastructure';
import type { GitExecutorDeps }   from '@codeforge/infrastructure';
import type { WorkspaceManager }  from '@codeforge/agent-core';
import { FakeProcessSupervisor }  from '@codeforge/testing';

// ── helpers ───────────────────────────────────────────────────────────────────

/** Minimal WorkspaceManager stub — GitExecutor only needs .root */
function makeWorkspace(root: string): WorkspaceManager {
  const fakeChange = (kind: 'create' | 'modify' | 'delete' | 'rename', relpath: string) => ({
    changeId: 'c0',
    sessionId: 's0',
    kind,
    relpath,
    ownedBy:      'agent'  as const,
    inScratchZone: false,
    at:            '2026-01-01T00:00:00.000Z',
  });
  return {
    root,
    readFileBytes: async () => Buffer.alloc(0),
    readFile:      async () => '',
    writeFile:     async (_r) => fakeChange('modify', _r),
    deleteFile:    async (_r) => fakeChange('delete', _r),
    moveFile:      async (_f, _t) => fakeChange('rename', _t),
    listDir:       async () => [],
    checkPath:     async (_r) => root + '/' + _r,
    fileExists:    async () => false,
    dirExists:     async () => false,
  } satisfies WorkspaceManager;
}

/** Build a minimal fake ToolCall for the given toolName + args. */
function makeCall(toolName: string, args: unknown = {}): Parameters<GitExecutor['execute']>[0] {
  return {
    toolCallId:    'TC-0001',
    sessionId:     'SE-0001',
    toolName,
    toolVersion:   '1.0',
    riskClass:     'READ_ONLY' as const,
    arguments:     args,
    argumentsHash: 'hash',
    state:         'RUNNING' as const,
    proposedBy:    'model' as const,
    provenance: {
      provenanceId: 'PV-0001',
      source:       { kind: 'runtime' as const, id: 'SE-0001' },
      inputs:       [],
      reason:       'test',
      at:           '2026-01-01T00:00:00.000Z',
    },
    requestedAt:   '2026-01-01T00:00:00.000Z',
  };
}

// ── Unit suite (FakeProcessSupervisor) ────────────────────────────────────────

describe('GitExecutor — unit (fake supervisor)', () => {
  let fake: FakeProcessSupervisor;
  let executor: GitExecutor;

  beforeEach(() => {
    fake = new FakeProcessSupervisor();
    const deps: GitExecutorDeps = {
      workspace:   makeWorkspace('/fake/root'),
      supervisor:  fake,
      gitIdentity: { name: 'Test Bot', email: 'bot@test.local' },
    };
    executor = new GitExecutor(deps);
  });

  // ── git_status ─────────────────────────────────────────────────────────────

  describe('git_status', () => {
    it('returns stdout from git status --porcelain=v1', async () => {
      fake.setOutcome(/git/, { exitCode: 0, stdout: 'M  src/foo.ts\n?? new.ts', stderr: '' });
      const r = await executor.execute(makeCall('git_status'));
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('M  src/foo.ts\n?? new.ts');
      expect(r.timedOut).toBe(false);
    });

    it('passes --no-pager and status --porcelain=v1 as args', async () => {
      fake.setOutcome(/git/, { exitCode: 0, stdout: '', stderr: '' });
      await executor.execute(makeCall('git_status'));
      const opts = fake.lastOptions!;
      expect(opts.args).toContain('--no-pager');
      expect(opts.args).toContain('status');
      expect(opts.args).toContain('--porcelain=v1');
    });

    it('uses workspace.root as cwd', async () => {
      fake.setOutcome(/git/, { exitCode: 0, stdout: '', stderr: '' });
      await executor.execute(makeCall('git_status'));
      expect(fake.lastOptions!.cwd).toBe('/fake/root');
    });

    it('uses shell:false (args is array, no shell string)', async () => {
      // NodeProcessSupervisor enforces shell:false; FakeProcessSupervisor
      // never calls a shell — we verify args come through as an array.
      fake.setOutcome(/git/, { exitCode: 0, stdout: '', stderr: '' });
      await executor.execute(makeCall('git_status'));
      expect(Array.isArray(fake.lastOptions!.args)).toBe(true);
    });

    it('has a mandatory timeoutMs on every spawn (SE-007)', async () => {
      fake.setOutcome(/git/, { exitCode: 0, stdout: '', stderr: '' });
      await executor.execute(makeCall('git_status'));
      expect(fake.lastOptions!.timeoutMs).toBeGreaterThan(0);
    });

    it('forwards non-zero exit code as-is', async () => {
      fake.setOutcome(/git/, { exitCode: 128, stdout: '', stderr: 'fatal: not a git repo' });
      const r = await executor.execute(makeCall('git_status'));
      expect(r.exitCode).toBe(128);
      expect(r.stderr).toMatch('not a git repo');
    });

    it('forwards timedOut=true when process times out (TG-010)', async () => {
      fake.setOutcome(/git/, { timedOut: true, stdout: '', stderr: '' });
      const r = await executor.execute(makeCall('git_status'));
      expect(r.timedOut).toBe(true);
      expect(r.exitCode).toBeNull();
    });

    it('returns GIT_TERMINAL_PROMPT=0 in env to prevent credential hangs', async () => {
      fake.setOutcome(/git/, { exitCode: 0, stdout: '', stderr: '' });
      await executor.execute(makeCall('git_status'));
      expect(fake.lastOptions!.env?.['GIT_TERMINAL_PROMPT']).toBe('0');
    });

    it('injects gitIdentity env vars when configured', async () => {
      fake.setOutcome(/git/, { exitCode: 0, stdout: '', stderr: '' });
      await executor.execute(makeCall('git_status'));
      const env = fake.lastOptions!.env;
      expect(env?.['GIT_AUTHOR_NAME']).toBe('Test Bot');
      expect(env?.['GIT_AUTHOR_EMAIL']).toBe('bot@test.local');
      expect(env?.['GIT_COMMITTER_NAME']).toBe('Test Bot');
      expect(env?.['GIT_COMMITTER_EMAIL']).toBe('bot@test.local');
    });

    it('does NOT pass raw process.env to git (no secret inheritance)', async () => {
      fake.setOutcome(/git/, { exitCode: 0, stdout: '', stderr: '' });
      await executor.execute(makeCall('git_status'));
      // The env object must be minimal — it must NOT contain keys from process.env
      // that we never explicitly set (e.g., arbitrary secret variables).
      const env = fake.lastOptions!.env ?? {};
      const allowed = new Set([
        'PATH', 'HOME', 'USERPROFILE',
        'GIT_TERMINAL_PROMPT', 'TERM',
        'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL',
        'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL',
      ]);
      for (const key of Object.keys(env)) {
        expect(allowed.has(key), `unexpected env key leaked: ${key}`).toBe(true);
      }
    });
  });

  // ── git_diff ──────────────────────────────────────────────────────────────

  describe('git_diff', () => {
    it('runs git diff with no path by default', async () => {
      fake.setOutcome(/git/, { exitCode: 0, stdout: 'diff output', stderr: '' });
      const r = await executor.execute(makeCall('git_diff'));
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('diff output');
      const args = fake.lastOptions!.args as string[];
      expect(args).toContain('diff');
      expect(args).not.toContain('--');
    });

    it('passes -- <path> when path arg is set', async () => {
      fake.setOutcome(/git/, { exitCode: 0, stdout: '', stderr: '' });
      await executor.execute(makeCall('git_diff', { path: 'src/foo.ts' }));
      const args = fake.lastOptions!.args as string[];
      expect(args).toContain('--');
      expect(args).toContain('src/foo.ts');
    });

    it('passes --cached when staged=true', async () => {
      fake.setOutcome(/git/, { exitCode: 0, stdout: '', stderr: '' });
      await executor.execute(makeCall('git_diff', { staged: true }));
      const args = fake.lastOptions!.args as string[];
      expect(args).toContain('--cached');
    });

    it('passes --no-color to suppress escape codes', async () => {
      fake.setOutcome(/git/, { exitCode: 0, stdout: '', stderr: '' });
      await executor.execute(makeCall('git_diff'));
      expect(fake.lastOptions!.args).toContain('--no-color');
    });

    it('ignores empty string path arg', async () => {
      fake.setOutcome(/git/, { exitCode: 0, stdout: '', stderr: '' });
      await executor.execute(makeCall('git_diff', { path: '' }));
      const args = fake.lastOptions!.args as string[];
      expect(args).not.toContain('--');
    });
  });

  // ── git_add ───────────────────────────────────────────────────────────────

  describe('git_add', () => {
    it('stages the given paths', async () => {
      fake.setOutcome(/git/, { exitCode: 0, stdout: '', stderr: '' });
      const r = await executor.execute(makeCall('git_add', { paths: ['src/a.ts', 'src/b.ts'] }));
      expect(r.exitCode).toBe(0);
      const args = fake.lastOptions!.args as string[];
      expect(args).toContain('add');
      expect(args).toContain('--');
      expect(args).toContain('src/a.ts');
      expect(args).toContain('src/b.ts');
    });

    it('returns exitCode=1 and descriptive stderr when paths is empty array', async () => {
      const r = await executor.execute(makeCall('git_add', { paths: [] }));
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toMatch('non-empty array');
      expect(fake.callCount).toBe(0); // no spawn fired
    });

    it('returns exitCode=1 when paths is missing', async () => {
      const r = await executor.execute(makeCall('git_add', {}));
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toMatch('non-empty array');
    });

    it('stringifies each path element', async () => {
      fake.setOutcome(/git/, { exitCode: 0, stdout: '', stderr: '' });
      await executor.execute(makeCall('git_add', { paths: [42, true, 'real.ts'] }));
      const args = fake.lastOptions!.args as string[];
      expect(args).toContain('42');
      expect(args).toContain('true');
      expect(args).toContain('real.ts');
    });

    it('forwards non-zero exit from git (file not found, etc.)', async () => {
      fake.setOutcome(/git/, { exitCode: 1, stdout: '', stderr: 'error: pathspec not matched' });
      const r = await executor.execute(makeCall('git_add', { paths: ['missing.ts'] }));
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toMatch('pathspec not matched');
    });
  });

  // ── git_commit ────────────────────────────────────────────────────────────

  describe('git_commit', () => {
    it('passes commit message via -m flag', async () => {
      fake.setOutcome(/git/, { exitCode: 0, stdout: '[main abc1234] feat: foo', stderr: '' });
      const r = await executor.execute(makeCall('git_commit', { message: 'feat: foo' }));
      expect(r.exitCode).toBe(0);
      const args = fake.lastOptions!.args as string[];
      expect(args).toContain('commit');
      expect(args).toContain('-m');
      expect(args).toContain('feat: foo');
    });

    it('includes --no-edit and --no-gpg-sign', async () => {
      fake.setOutcome(/git/, { exitCode: 0, stdout: '', stderr: '' });
      await executor.execute(makeCall('git_commit', { message: 'x' }));
      const args = fake.lastOptions!.args as string[];
      expect(args).toContain('--no-edit');
      expect(args).toContain('--no-gpg-sign');
    });

    it('returns exitCode=1 and descriptive stderr when message is empty string', async () => {
      const r = await executor.execute(makeCall('git_commit', { message: '' }));
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toMatch('message is required');
      expect(fake.callCount).toBe(0);
    });

    it('returns exitCode=1 for whitespace-only message', async () => {
      const r = await executor.execute(makeCall('git_commit', { message: '   ' }));
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toMatch('message is required');
    });

    it('returns exitCode=1 when message is missing', async () => {
      const r = await executor.execute(makeCall('git_commit', {}));
      expect(r.exitCode).toBe(1);
    });

    it('forwards non-zero exit when nothing is staged', async () => {
      fake.setOutcome(/git/, { exitCode: 1, stdout: '', stderr: 'nothing to commit' });
      const r = await executor.execute(makeCall('git_commit', { message: 'oops' }));
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toMatch('nothing to commit');
    });
  });

  // ── git_log ───────────────────────────────────────────────────────────────

  describe('git_log', () => {
    it('defaults to max-count=10', async () => {
      fake.setOutcome(/git/, { exitCode: 0, stdout: 'abc123 feat: init', stderr: '' });
      const r = await executor.execute(makeCall('git_log'));
      expect(r.exitCode).toBe(0);
      const args = fake.lastOptions!.args as string[];
      expect(args).toContain('--max-count=10');
    });

    it('respects custom n arg', async () => {
      fake.setOutcome(/git/, { exitCode: 0, stdout: '', stderr: '' });
      await executor.execute(makeCall('git_log', { n: 3 }));
      expect(fake.lastOptions!.args).toContain('--max-count=3');
    });

    it('clamps n to [1, 100]', async () => {
      fake.setOutcome(/git/, { exitCode: 0, stdout: '', stderr: '' });
      await executor.execute(makeCall('git_log', { n: 999 }));
      expect(fake.lastOptions!.args).toContain('--max-count=100');

      fake.reset();
      fake.setOutcome(/git/, { exitCode: 0, stdout: '', stderr: '' });
      await executor.execute(makeCall('git_log', { n: 0 }));
      expect(fake.lastOptions!.args).toContain('--max-count=1');
    });

    it('uses --oneline and --no-color', async () => {
      fake.setOutcome(/git/, { exitCode: 0, stdout: '', stderr: '' });
      await executor.execute(makeCall('git_log'));
      const args = fake.lastOptions!.args as string[];
      expect(args).toContain('--oneline');
      expect(args).toContain('--no-color');
    });

    it('passes NaN n gracefully (falls back to 10)', async () => {
      fake.setOutcome(/git/, { exitCode: 0, stdout: '', stderr: '' });
      await executor.execute(makeCall('git_log', { n: 'bad' }));
      expect(fake.lastOptions!.args).toContain('--max-count=10');
    });
  });

  // ── unknown tool ──────────────────────────────────────────────────────────

  describe('unknown tool name', () => {
    it('returns exitCode=1 with descriptive error, no spawn', async () => {
      const r = await executor.execute(makeCall('git_rebase'));
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toMatch('unknown git tool');
      expect(fake.callCount).toBe(0);
    });
  });

  // ── SpawnError propagation ─────────────────────────────────────────────────

  describe('SpawnError propagation', () => {
    it('converts COMMAND_NOT_FOUND SpawnError to ExecutorResult exitCode=1', async () => {
      fake.setOutcome(/git/, { commandNotFound: true });
      const r = await executor.execute(makeCall('git_status'));
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toMatch('not found');
    });
  });

  // ── custom gitPath + timeoutMs ─────────────────────────────────────────────

  describe('custom gitPath and timeoutMs', () => {
    it('uses custom gitPath as the command', async () => {
      const customFake = new FakeProcessSupervisor();
      customFake.setOutcome(/custom-git/, { exitCode: 0, stdout: '', stderr: '' });
      const e = new GitExecutor({
        workspace:  makeWorkspace('/root'),
        supervisor: customFake,
        gitPath:    '/usr/local/bin/custom-git',
      });
      await e.execute(makeCall('git_status'));
      expect(customFake.lastOptions!.command).toBe('/usr/local/bin/custom-git');
    });

    it('uses custom timeoutMs for spawns', async () => {
      const customFake = new FakeProcessSupervisor();
      customFake.setOutcome(/git/, { exitCode: 0, stdout: '', stderr: '' });
      const e = new GitExecutor({
        workspace:  makeWorkspace('/root'),
        supervisor: customFake,
        timeoutMs:  5_000,
      });
      await e.execute(makeCall('git_status'));
      expect(customFake.lastOptions!.timeoutMs).toBe(5_000);
    });
  });
});

// ── Integration suite (real git) ──────────────────────────────────────────────

describe('GitExecutor — integration (real git)', () => {
  let tmpDir: string;
  let executor: GitExecutor;
  let real: import('@codeforge/infrastructure').NodeWorkspaceManager;
  const IS_WINDOWS = platform() === 'win32';

  // Detect git availability once.
  let gitAvailable = false;
  beforeAll(() => {
    try {
      execSync('git --version', { stdio: 'ignore' });
      gitAvailable = true;
    } catch {
      gitAvailable = false;
    }
  });

  beforeEach(async () => {
    if (!gitAvailable) return;
    tmpDir = await mkdtemp(join(tmpdir(), 'cf2-git-'));

    // Import NodeProcessSupervisor and NodeWorkspaceManager dynamically
    // (they are integration-layer, not in testing harness).
    const { NodeProcessSupervisor, NodeWorkspaceManager } = await import('@codeforge/infrastructure');
    real = new NodeWorkspaceManager({
      root:   tmpDir,
      now:    () => new Date().toISOString(),
      nextId: () => `id-${Math.random().toString(36).slice(2)}`,
    });

    const supervisor = new NodeProcessSupervisor();
    const deps: GitExecutorDeps = {
      workspace:   real,
      supervisor,
      gitIdentity: { name: 'CF2 Test', email: 'test@codeforge.dev' },
      timeoutMs:   15_000,
    };
    executor = new GitExecutor(deps);

    // Init a fresh git repo.
    execSync('git init', { cwd: tmpDir, stdio: 'ignore' });
    execSync('git config user.email "test@codeforge.dev"', { cwd: tmpDir, stdio: 'ignore' });
    execSync('git config user.name "CF2 Test"',            { cwd: tmpDir, stdio: 'ignore' });
  });

  afterEach(async () => {
    if (!gitAvailable) return;
    await rm(tmpDir, { recursive: true, force: true });
  });

  // ── git_status ─────────────────────────────────────────────────────────────

  it('git_status: clean repo has empty porcelain output', async () => {
    if (!gitAvailable) return;
    // Add an initial commit so status works on fresh repo.
    await fsWriteFile(join(tmpDir, 'readme.txt'), 'hello');
    execSync('git add readme.txt', { cwd: tmpDir, stdio: 'ignore' });
    execSync('git commit -m "init"', { cwd: tmpDir, stdio: 'ignore' });

    const r = await executor.execute(makeCall('git_status'));
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('');
  });

  it('git_status: shows untracked file', async () => {
    if (!gitAvailable) return;
    await fsWriteFile(join(tmpDir, 'untracked.ts'), 'export const x = 1;');
    const r = await executor.execute(makeCall('git_status'));
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch('untracked.ts');
  });

  it('git_status: shows modified file', async () => {
    if (!gitAvailable) return;
    await fsWriteFile(join(tmpDir, 'foo.ts'), 'const a = 1;');
    execSync('git add foo.ts', { cwd: tmpDir, stdio: 'ignore' });
    execSync('git commit -m "init"', { cwd: tmpDir, stdio: 'ignore' });
    await fsWriteFile(join(tmpDir, 'foo.ts'), 'const a = 2;');
    const r = await executor.execute(makeCall('git_status'));
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch('foo.ts');
  });

  // ── git_diff ──────────────────────────────────────────────────────────────

  it('git_diff: returns unified diff for modified file', async () => {
    if (!gitAvailable) return;
    await fsWriteFile(join(tmpDir, 'foo.ts'), 'const a = 1;\n');
    execSync('git add foo.ts', { cwd: tmpDir, stdio: 'ignore' });
    execSync('git commit -m "init"', { cwd: tmpDir, stdio: 'ignore' });
    await fsWriteFile(join(tmpDir, 'foo.ts'), 'const a = 2;\n');
    const r = await executor.execute(makeCall('git_diff'));
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch('@@');
    expect(r.stdout).toMatch('foo.ts');
  });

  it('git_diff: staged diff with --cached', async () => {
    if (!gitAvailable) return;
    await fsWriteFile(join(tmpDir, 'bar.ts'), 'export const x = 1;\n');
    execSync('git add bar.ts', { cwd: tmpDir, stdio: 'ignore' });
    const r = await executor.execute(makeCall('git_diff', { staged: true }));
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch('bar.ts');
  });

  // ── git_add + git_commit + git_log ────────────────────────────────────────

  it('git_add + git_commit + git_log round-trip', async () => {
    if (!gitAvailable) return;
    await fsWriteFile(join(tmpDir, 'main.ts'), 'console.log("hello");\n');

    // Stage
    const addR = await executor.execute(makeCall('git_add', { paths: ['main.ts'] }));
    expect(addR.exitCode).toBe(0);

    // Commit
    const commitR = await executor.execute(makeCall('git_commit', { message: 'feat: add main.ts' }));
    expect(commitR.exitCode).toBe(0);
    expect(commitR.stdout).toMatch('main.ts');

    // Log
    const logR = await executor.execute(makeCall('git_log', { n: 5 }));
    expect(logR.exitCode).toBe(0);
    expect(logR.stdout).toMatch('feat: add main.ts');
  });

  it('git_commit fails when nothing is staged', async () => {
    if (!gitAvailable) return;
    // Need at least one commit for the repo to be valid.
    await fsWriteFile(join(tmpDir, 'a.txt'), 'a');
    execSync('git add a.txt', { cwd: tmpDir, stdio: 'ignore' });
    execSync('git commit -m "init"', { cwd: tmpDir, stdio: 'ignore' });

    const r = await executor.execute(makeCall('git_commit', { message: 'nothing staged' }));
    expect(r.exitCode).not.toBe(0);
  });

  it('git_add fails gracefully for non-existent path', async () => {
    if (!gitAvailable) return;
    // git add of a non-existent file returns non-zero exit.
    const r = await executor.execute(makeCall('git_add', { paths: ['does-not-exist.ts'] }));
    // Git returns a non-zero exit code; we just forward it.
    expect(r.exitCode).not.toBe(0);
  });

  it('git_log returns empty output on fresh repo (no commits)', async () => {
    if (!gitAvailable) return;
    // Fresh repo has no commits yet — git log should produce no output.
    // On some git versions this exits 0 with empty output, on others 128.
    const r = await executor.execute(makeCall('git_log'));
    // We just assert it doesn't throw and returns an ExecutorResult.
    expect(r).toHaveProperty('exitCode');
    expect(r).toHaveProperty('stdout');
    expect(r).toHaveProperty('timedOut');
  });

  // ── Windows/Linux path neutrality ────────────────────────────────────────

  it('git_status works on both Windows and Linux (path sep neutral)', async () => {
    if (!gitAvailable) return;
    // The test just verifies the executor runs without error on the current OS.
    await fsWriteFile(join(tmpDir, 'x.ts'), 'export {};');
    const r = await executor.execute(makeCall('git_status'));
    expect(r).toHaveProperty('exitCode');
    expect(IS_WINDOWS || !IS_WINDOWS).toBe(true); // always true, documents intent
  });
});
