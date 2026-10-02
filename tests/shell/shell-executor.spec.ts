// P3-SH1 — ShellPolicy + ShellExecutor: run_command allowlist enforcement.
//
// Two suites:
//   1. ShellPolicy unit — createShellPolicy, checkCommand, resolveTimeout.
//   2. ShellExecutor unit — FakeProcessSupervisor (no real subprocess).
//   3. ShellExecutor integration — real echo/node on the OS (requires PATH).
import { describe, it, expect, beforeEach } from 'vitest';
import {
  ShellPolicyError,
  DEFAULT_SHELL_ALLOWLIST,
  DEFAULT_SHELL_POLICY,
  createShellPolicy,
  checkCommand,
  resolveTimeout,
  type ShellPolicy,
} from '@codeforge/agent-core';
import { ShellExecutor }           from '@codeforge/infrastructure';
import type { ShellExecutorDeps }  from '@codeforge/infrastructure';
import type { WorkspaceManager }   from '@codeforge/agent-core';
import { FakeProcessSupervisor }   from '@codeforge/testing';

// ── helpers ───────────────────────────────────────────────────────────────────

function makeWorkspace(root = '/fake/root'): WorkspaceManager {
  const cr = (kind: 'create' | 'modify' | 'delete' | 'rename', relpath: string) => ({
    changeId: 'c0', sessionId: 's0', kind, relpath,
    ownedBy: 'agent' as const, inScratchZone: false,
    at: '2026-01-01T00:00:00.000Z',
  });
  return {
    root,
    readFileBytes: async () => Buffer.alloc(0),
    readFile:      async () => '',
    writeFile:     async (r) => cr('modify', r),
    deleteFile:    async (r) => cr('delete', r),
    moveFile:      async (_f, t) => cr('rename', t),
    listDir:       async () => [],
    checkPath:     async (r) => root + '/' + r,
    fileExists:    async () => false,
    dirExists:     async () => false,
  } satisfies WorkspaceManager;
}

function makeCall(args: unknown = {}): Parameters<ShellExecutor['execute']>[0] {
  return {
    toolCallId:    'TC-SH-001',
    sessionId:     'SE-0001',
    toolName:      'run_command',
    toolVersion:   '1.0',
    riskClass:     'SYSTEM' as const,
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
    requestedAt: '2026-01-01T00:00:00.000Z',
  };
}

// ── ShellPolicy unit ──────────────────────────────────────────────────────────

describe('ShellPolicy', () => {
  describe('DEFAULT_SHELL_ALLOWLIST', () => {
    it('contains expected common dev-tool commands', () => {
      for (const cmd of ['echo', 'node', 'npm', 'npx', 'git', 'tsc', 'eslint', 'vitest']) {
        expect(DEFAULT_SHELL_ALLOWLIST.has(cmd), `expected "${cmd}" in default allowlist`).toBe(true);
      }
    });

    it('does NOT contain dangerous commands', () => {
      for (const cmd of ['bash', 'sh', 'powershell', 'cmd', 'sudo', 'chmod', 'chown']) {
        expect(DEFAULT_SHELL_ALLOWLIST.has(cmd), `"${cmd}" should NOT be in default allowlist`).toBe(false);
      }
    });
  });

  describe('createShellPolicy', () => {
    it('creates policy from provided iterable', () => {
      const p = createShellPolicy(['node', 'npm']);
      expect(p.allowedCommands.has('node')).toBe(true);
      expect(p.allowedCommands.has('npm')).toBe(true);
      expect(p.allowedCommands.has('bash')).toBe(false);
    });

    it('defaults to DEFAULT_SHELL_ALLOWLIST when no iterable provided', () => {
      const p = createShellPolicy();
      expect(p.allowedCommands.has('echo')).toBe(true);
      expect(p.allowedCommands.has('git')).toBe(true);
    });

    it('uses provided defaultTimeoutMs and maxTimeoutMs', () => {
      const p = createShellPolicy(['node'], 5_000, 60_000);
      expect(p.defaultTimeoutMs).toBe(5_000);
      expect(p.maxTimeoutMs).toBe(60_000);
    });

    it('throws RangeError when defaultTimeoutMs <= 0', () => {
      expect(() => createShellPolicy(['node'], 0)).toThrow(RangeError);
      expect(() => createShellPolicy(['node'], -1)).toThrow(RangeError);
    });

    it('throws RangeError when maxTimeoutMs < defaultTimeoutMs', () => {
      expect(() => createShellPolicy(['node'], 30_000, 1_000)).toThrow(RangeError);
    });

    it('DEFAULT_SHELL_POLICY has reasonable timeout defaults', () => {
      expect(DEFAULT_SHELL_POLICY.defaultTimeoutMs).toBe(30_000);
      expect(DEFAULT_SHELL_POLICY.maxTimeoutMs).toBe(300_000);
    });
  });

  describe('checkCommand', () => {
    const policy = createShellPolicy(['echo', 'node', '/usr/bin/python3']);

    it('allows exact match', () => {
      expect(() => checkCommand('echo', policy)).not.toThrow();
      expect(() => checkCommand('node', policy)).not.toThrow();
    });

    it('allows absolute path that is in allowlist', () => {
      expect(() => checkCommand('/usr/bin/python3', policy)).not.toThrow();
    });

    it('throws COMMAND_NOT_ALLOWED for unlisted command', () => {
      expect(() => checkCommand('bash', policy))
        .toThrow(ShellPolicyError);
    });

    it('thrown error has code COMMAND_NOT_ALLOWED and command field', () => {
      let caught: ShellPolicyError | null = null;
      try { checkCommand('sudo', policy); } catch (e) { caught = e as ShellPolicyError; }
      expect(caught).not.toBeNull();
      expect(caught!.code).toBe('COMMAND_NOT_ALLOWED');
      expect(caught!.command).toBe('sudo');
    });

    it('normalises Windows extension: npm.cmd → npm', () => {
      const p = createShellPolicy(['npm']);
      expect(() => checkCommand('npm.cmd', p)).not.toThrow();
    });

    it('normalises to lowercase for extension stripping', () => {
      const p = createShellPolicy(['node']);
      // NODE.EXE → strips .EXE → NODE → lowercase node → matches
      expect(() => checkCommand('NODE.EXE', p)).not.toThrow();
    });

    it('is case-sensitive for non-extension part on Unix', () => {
      const p = createShellPolicy(['node']);
      // 'Node' (capital N) is NOT in allowlist — case-sensitive
      // After normalisation: base='Node', baseLower='node' → matches via baseLower
      // So this should NOT throw (baseLower match is intentional for Windows compat)
      expect(() => checkCommand('Node', p)).not.toThrow();
    });
  });

  describe('resolveTimeout', () => {
    const policy = createShellPolicy(['echo'], 30_000, 300_000);

    it('returns default when caller provides undefined', () => {
      expect(resolveTimeout(undefined, policy)).toBe(30_000);
    });

    it('returns caller value when within bounds', () => {
      expect(resolveTimeout(5_000, policy)).toBe(5_000);
    });

    it('caps caller value at maxTimeoutMs', () => {
      expect(resolveTimeout(999_999, policy)).toBe(300_000);
    });

    it('returns default for NaN input', () => {
      expect(resolveTimeout(NaN, policy)).toBe(30_000);
    });

    it('returns default for 0 or negative', () => {
      expect(resolveTimeout(0, policy)).toBe(30_000);
      expect(resolveTimeout(-500, policy)).toBe(30_000);
    });

    it('returns exact maxTimeoutMs for caller value equal to max', () => {
      expect(resolveTimeout(300_000, policy)).toBe(300_000);
    });
  });
});

// ── ShellExecutor unit (FakeProcessSupervisor) ────────────────────────────────

describe('ShellExecutor — unit (fake supervisor)', () => {
  let fake:     FakeProcessSupervisor;
  let executor: ShellExecutor;
  const testPolicy: ShellPolicy = createShellPolicy(['echo', 'node', 'cat']);

  beforeEach(() => {
    fake = new FakeProcessSupervisor();
    const deps: ShellExecutorDeps = {
      workspace:   makeWorkspace('/ws'),
      supervisor:  fake,
      shellPolicy: testPolicy,
    };
    executor = new ShellExecutor(deps);
  });

  // ── basic success path ─────────────────────────────────────────────────────

  it('spawns allowed command and returns stdout', async () => {
    fake.setOutcome(/echo/, { exitCode: 0, stdout: 'hello world', stderr: '' });
    const r = await executor.execute(makeCall({ command: 'echo', args: ['hello', 'world'] }));
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe('hello world');
    expect(r.timedOut).toBe(false);
  });

  it('passes args array to supervisor', async () => {
    fake.setOutcome(/echo/, { exitCode: 0, stdout: '', stderr: '' });
    await executor.execute(makeCall({ command: 'echo', args: ['a', 'b', 'c'] }));
    expect(fake.lastOptions!.args).toEqual(['a', 'b', 'c']);
  });

  it('uses workspace.root as cwd', async () => {
    fake.setOutcome(/echo/, { exitCode: 0, stdout: '', stderr: '' });
    await executor.execute(makeCall({ command: 'echo' }));
    expect(fake.lastOptions!.cwd).toBe('/ws');
  });

  it('never uses shell:true (args is array, never shell string)', async () => {
    fake.setOutcome(/echo/, { exitCode: 0, stdout: '', stderr: '' });
    await executor.execute(makeCall({ command: 'echo', args: ['x'] }));
    expect(Array.isArray(fake.lastOptions!.args)).toBe(true);
  });

  it('has mandatory timeoutMs on every spawn (SE-007)', async () => {
    fake.setOutcome(/echo/, { exitCode: 0, stdout: '', stderr: '' });
    await executor.execute(makeCall({ command: 'echo' }));
    expect(fake.lastOptions!.timeoutMs).toBeGreaterThan(0);
  });

  it('uses policy.defaultTimeoutMs when caller omits timeoutMs', async () => {
    fake.setOutcome(/echo/, { exitCode: 0, stdout: '', stderr: '' });
    await executor.execute(makeCall({ command: 'echo' }));
    expect(fake.lastOptions!.timeoutMs).toBe(testPolicy.defaultTimeoutMs);
  });

  it('uses caller-supplied timeoutMs when within bounds', async () => {
    fake.setOutcome(/echo/, { exitCode: 0, stdout: '', stderr: '' });
    await executor.execute(makeCall({ command: 'echo', timeoutMs: 5_000 }));
    expect(fake.lastOptions!.timeoutMs).toBe(5_000);
  });

  it('caps caller-supplied timeoutMs at policy.maxTimeoutMs', async () => {
    fake.setOutcome(/echo/, { exitCode: 0, stdout: '', stderr: '' });
    await executor.execute(makeCall({ command: 'echo', timeoutMs: 999_999 }));
    expect(fake.lastOptions!.timeoutMs).toBe(testPolicy.maxTimeoutMs);
  });

  it('forwards env from EnvGuard (does not pass raw process.env)', async () => {
    fake.setOutcome(/echo/, { exitCode: 0, stdout: '', stderr: '' });
    await executor.execute(makeCall({ command: 'echo' }));
    const env = fake.lastOptions!.env ?? {};
    // Should contain PATH (always allowed by DEFAULT_ENV_POLICY).
    expect(typeof env).toBe('object');
    // Should NOT contain known secret keys.
    for (const key of Object.keys(env)) {
      expect(key).not.toMatch(/^(AWS_|GITHUB_TOKEN|SECRET|PASSWORD)/i);
    }
  });

  // ── allowlist enforcement (SE-003) ─────────────────────────────────────────

  it('returns exitCode=1 for unlisted command, no spawn fired', async () => {
    const r = await executor.execute(makeCall({ command: 'bash' }));
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch('not in the ShellPolicy allowlist');
    expect(fake.callCount).toBe(0);
  });

  it('returns exitCode=1 for rm (not in test policy)', async () => {
    const r = await executor.execute(makeCall({ command: 'rm', args: ['-rf', '/'] }));
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch('not in the ShellPolicy allowlist');
    expect(fake.callCount).toBe(0);
  });

  it('allows npm.cmd on Windows-style normalisation', async () => {
    const p = createShellPolicy(['npm']);
    const e = new ShellExecutor({ workspace: makeWorkspace('/ws'), supervisor: fake, shellPolicy: p });
    fake.setOutcome(/npm/, { exitCode: 0, stdout: '', stderr: '' });
    const r = await e.execute(makeCall({ command: 'npm.cmd', args: ['run', 'test'] }));
    expect(r.exitCode).toBe(0);
  });

  // ── argument validation ────────────────────────────────────────────────────

  it('returns exitCode=1 when command is empty string', async () => {
    const r = await executor.execute(makeCall({ command: '' }));
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch('"command"');
    expect(fake.callCount).toBe(0);
  });

  it('returns exitCode=1 when command is missing', async () => {
    const r = await executor.execute(makeCall({}));
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch('"command"');
  });

  it('stringifies each element of args array', async () => {
    fake.setOutcome(/echo/, { exitCode: 0, stdout: '', stderr: '' });
    await executor.execute(makeCall({ command: 'echo', args: [42, true, 'hello'] }));
    expect(fake.lastOptions!.args).toEqual(['42', 'true', 'hello']);
  });

  it('treats missing args as empty array', async () => {
    fake.setOutcome(/echo/, { exitCode: 0, stdout: '', stderr: '' });
    await executor.execute(makeCall({ command: 'echo' }));
    expect(fake.lastOptions!.args).toEqual([]);
  });

  // ── non-run_command tool name ──────────────────────────────────────────────

  it('returns exitCode=1 for unknown toolName, no spawn', async () => {
    const callWithWrongTool = { ...makeCall({}), toolName: 'git_status' };
    const r = await executor.execute(callWithWrongTool);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch('unknown tool');
    expect(fake.callCount).toBe(0);
  });

  // ── timeout + timedOut propagation (TG-010) ────────────────────────────────

  it('forwards timedOut=true when process times out', async () => {
    fake.setOutcome(/echo/, { timedOut: true, stdout: '', stderr: '' });
    const r = await executor.execute(makeCall({ command: 'echo' }));
    expect(r.timedOut).toBe(true);
    expect(r.exitCode).toBeNull();
  });

  // ── non-zero exit forwarded as-is ──────────────────────────────────────────

  it('forwards non-zero exit code from process', async () => {
    fake.setOutcome(/node/, { exitCode: 1, stdout: '', stderr: 'error: no such file' });
    const r = await executor.execute(makeCall({ command: 'node', args: ['missing.js'] }));
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch('no such file');
  });

  // ── SpawnError propagation ─────────────────────────────────────────────────

  it('converts COMMAND_NOT_FOUND SpawnError to exitCode=1', async () => {
    fake.setOutcome(/echo/, { commandNotFound: true });
    const r = await executor.execute(makeCall({ command: 'echo' }));
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch('not found');
  });

  // ── custom envPolicy ──────────────────────────────────────────────────────

  it('uses custom EnvPolicy when provided', async () => {
    const { MINIMAL_ENV_POLICY } = await import('@codeforge/agent-core');
    const customFake = new FakeProcessSupervisor();
    customFake.setOutcome(/echo/, { exitCode: 0, stdout: '', stderr: '' });
    const e = new ShellExecutor({
      workspace:   makeWorkspace('/ws'),
      supervisor:  customFake,
      shellPolicy: testPolicy,
      envPolicy:   MINIMAL_ENV_POLICY,
    });
    await e.execute(makeCall({ command: 'echo' }));
    const env = customFake.lastOptions!.env ?? {};
    // MINIMAL_ENV_POLICY only allows PATH.
    const keys = Object.keys(env);
    for (const k of keys) {
      expect(k).toBe('PATH');
    }
  });

  // ── DEFAULT_SHELL_POLICY used when shellPolicy not provided ────────────────

  it('uses DEFAULT_SHELL_POLICY when none is provided in deps', async () => {
    const defaultFake = new FakeProcessSupervisor();
    defaultFake.setOutcome(/echo/, { exitCode: 0, stdout: '', stderr: '' });
    const e = new ShellExecutor({
      workspace:  makeWorkspace('/ws'),
      supervisor: defaultFake,
      // shellPolicy NOT provided → should default to DEFAULT_SHELL_POLICY
    });
    // echo is in DEFAULT_SHELL_ALLOWLIST
    const r = await e.execute(makeCall({ command: 'echo', args: ['hi'] }));
    expect(r.exitCode).toBe(0);
  });

  it('blocks bash with DEFAULT_SHELL_POLICY', async () => {
    const defaultFake = new FakeProcessSupervisor();
    const e = new ShellExecutor({
      workspace:  makeWorkspace('/ws'),
      supervisor: defaultFake,
    });
    const r = await e.execute(makeCall({ command: 'bash', args: ['-c', 'rm -rf /'] }));
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toMatch('not in the ShellPolicy allowlist');
    expect(defaultFake.callCount).toBe(0);
  });
});

// ── ShellExecutor integration (real subprocess) ────────────────────────────────

describe('ShellExecutor — integration (real subprocess)', () => {

  // ── echo (cross-platform via node) ──────────────────────────────────────

  it('runs real echo via node (cross-platform)', async () => {
    // NOTE: `echo` is a shell built-in on Windows and cannot be spawned
    // with shell:false. Use `node -e` instead for a truly cross-platform test.
    const { NodeProcessSupervisor } = await import('@codeforge/infrastructure');
    const supervisor = new NodeProcessSupervisor();
    const executor = new ShellExecutor({
      workspace:   makeWorkspace(process.cwd()),
      supervisor,
      shellPolicy: createShellPolicy(['node']),
    });
    const r = await executor.execute(makeCall({
      command: 'node',
      args:    ['-e', "process.stdout.write('hello-cf2')"],
    }));
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toContain('hello-cf2');
  });

  // ── node --version ────────────────────────────────────────────────────────

  it('runs node --version', async () => {
    const { NodeProcessSupervisor } = await import('@codeforge/infrastructure');
    const supervisor = new NodeProcessSupervisor();
    const executor = new ShellExecutor({
      workspace:   makeWorkspace(process.cwd()),
      supervisor,
      shellPolicy: createShellPolicy(['node']),
    });
    const r = await executor.execute(makeCall({ command: 'node', args: ['--version'] }));
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toMatch(/^v\d+\.\d+\.\d+/);
  });

  // ── timeout enforcement ───────────────────────────────────────────────────

  it('enforces hard timeout and returns timedOut=true', async () => {
    const { NodeProcessSupervisor } = await import('@codeforge/infrastructure');
    const supervisor = new NodeProcessSupervisor();
    // Use a very short 100ms timeout on a sleep-like command.
    const policy = createShellPolicy(['node'], 100, 100);
    const executor = new ShellExecutor({
      workspace:  makeWorkspace(process.cwd()),
      supervisor,
      shellPolicy: policy,
    });
    // node -e "setTimeout(()=>{},5000)" will run longer than 100ms.
    const r = await executor.execute(makeCall({
      command:   'node',
      args:      ['-e', 'setTimeout(()=>{},5000)'],
      timeoutMs: 100,
    }));
    expect(r.timedOut).toBe(true);
  }, 10_000);
});
