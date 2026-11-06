// kernel-gap-closure task 1.5 — ShellExecutor argument checks (TEST-FIRST).
//
// Covers Property 8 (spawns exactly when no argument escapes), Property 13 (shell part: sensitive /
// protected access rules for shell arguments) and the example matrix of Requirements 3 and 8.
//
// Expected to FAIL until task 4.2 (ShellExecutor argument checks), 3.2 (shell-classifier) and
// 4.1 (NodeWorkspaceManager.checkAccess) land. Tests that assert behaviour which already holds today
// (spawn request unchanged, `echo $HOME`, `go test ./...`, `git add .gitignore`) pass now and must
// keep passing.
//
// Setup: real NodeWorkspaceManager over a realpath'ed temp directory (forward slashes, removed in
// afterAll), real ShellExecutor, recording FakeProcessSupervisor (no process is started).
//
// Allowlist note: DEFAULT_SHELL_ALLOWLIST contains echo printf cat head tail wc grep find ls dir pwd
// hostname mkdir cp mv rm node npm npx yarn pnpm tsc eslint vitest jest git python3 pip3 curl wget.
// It does NOT contain `go`, `touch`, `tee` or `rmdir`. Examples that need them (`go test ./...`, the
// mutating-command rows of Property 13) run with an extended policy (default allowlist + those names);
// everything else uses the default policy.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_SHELL_ALLOWLIST,
  DEFAULT_SHELL_POLICY,
  DEFAULT_ENV_POLICY,
  createShellPolicy,
  resolveTimeout,
  safeEnv,
} from '@codeforge/agent-core';
import type { ToolCall, ExecutorResult } from '@codeforge/agent-core';
import { NodeWorkspaceManager, ShellExecutor } from '@codeforge/infrastructure';
import { FakeProcessSupervisor } from '@codeforge/testing';
import {
  bool,
  forAllAsync,
  int,
  pathSegment,
  pick,
  randomCase,
  type Rng,
} from '../tool/gap-closure-generators.js';

// ── fixtures ──────────────────────────────────────────────────────────────────────────────────

let rootDir = '';
let workspace: NodeWorkspaceManager;
const supervisor = new FakeProcessSupervisor();

const EXTENDED_POLICY = createShellPolicy([...DEFAULT_SHELL_ALLOWLIST, 'go', 'touch', 'tee', 'rmdir']);

beforeAll(() => {
  rootDir = realpathSync(mkdtempSync(join(tmpdir(), 'cf-shell-args-'))).replace(/\\/g, '/');
  writeFileSync(join(rootDir, 'a.txt'), 'x');
  let n = 0;
  workspace = new NodeWorkspaceManager({
    root: rootDir,
    now: () => '2026-01-01T00:00:00.000Z',
    nextId: () => `c${++n}`,
  });
});

afterAll(() => {
  if (rootDir) rmSync(rootDir, { recursive: true, force: true });
});

beforeEach(() => {
  supervisor.reset();
});

function makeExecutor(policy = DEFAULT_SHELL_POLICY): ShellExecutor {
  return new ShellExecutor({ workspace, supervisor, shellPolicy: policy });
}

function makeCall(args: Record<string, unknown>): ToolCall {
  return {
    toolCallId: 'TC-SHA-001',
    sessionId: 'SE-0001',
    toolName: 'run_command',
    toolVersion: '1.0',
    riskClass: 'SYSTEM',
    arguments: args,
    argumentsHash: 'hash',
    state: 'RUNNING',
    proposedBy: 'model',
    provenance: {
      provenanceId: 'PV-0001',
      source: { kind: 'runtime', id: 'SE-0001' },
      inputs: [],
      reason: 'test',
      at: '2026-01-01T00:00:00.000Z',
    },
    requestedAt: '2026-01-01T00:00:00.000Z',
  };
}

async function run(
  command: string,
  args: readonly string[],
  policy = DEFAULT_SHELL_POLICY,
  extra: Record<string, unknown> = {},
): Promise<ExecutorResult> {
  return makeExecutor(policy).execute(makeCall({ command, args: [...args], ...extra }));
}

function expectRejected(res: ExecutorResult, code: string, arg?: string): void {
  expect(res.exitCode).toBe(1);
  expect(res.timedOut).toBe(false);
  expect(res.stdout).toBe('');
  expect(res.stderr).toContain(code);
  if (arg !== undefined) expect(res.stderr).toContain(arg);
  expect(supervisor.callCount).toBe(0);
}

// ── independent reference: argument classes ───────────────────────────────────────────────────
// The reference is by construction: every generated argument carries the class the Glossary
// assigns to it, so no production helper is consulted.

type ArgClass = 'safe' | 'escape' | 'env';
interface GenArg {
  readonly text: string;
  readonly cls: ArgClass;
}

function safeArg(rng: Rng): GenArg {
  const s = () => pathSegment(rng);
  const forms: Array<() => string> = [
    () => s(),
    () => `./${s()}`,
    () => `${s()}/${s()}`,
    () => `${s()}/../${s()}`, // stays inside the root
    () => pick(rng, ['-a', '-v', '--force', '--quiet', '-rf']),
    () => `key=${s()}`,
    () => `key=${s()}/${s()}`,
    () => `https://example.com/${s()}/../../${s()}`, // URL: never path-like
    () => `${s()} ${s()}/../../${s()}`, // whitespace: never path-like
    () => `"../${s()}"`, // quote: never path-like
    () => `../${s()}|${s()}`, // metacharacter: never path-like
  ];
  return { text: pick(rng, forms)(), cls: 'safe' };
}

function escapeArg(rng: Rng): GenArg {
  const s = () => pathSegment(rng);
  const forms: Array<() => string> = [
    () => '..',
    () => `../${s()}`,
    () => `${s()}/../../${s()}`,
    () => '/etc/hosts',
    () => '/',
    () => `/${s()}/${s()}`,
    () => '~',
    () => `~/${s()}`,
    () => 'C:\\Windows\\win.ini',
    () => `D:/${s()}`,
    () => `key=../${s()}`,
    () => `key=/etc/${s()}`,
  ];
  return { text: pick(rng, forms)(), cls: 'escape' };
}

function envArg(rng: Rng): GenArg {
  const s = () => pathSegment(rng);
  const forms: Array<() => string> = [
    () => '$HOME',
    () => `$HOME/${s()}`,
    () => '${HOME}/x',
    () => `%APPDATA%\\${s()}`,
    () => '$(pwd)',
    () => `key=$HOME`,
  ];
  return { text: pick(rng, forms)(), cls: 'env' };
}

function genArgs(rng: Rng): GenArg[] {
  const n = int(rng, 0, 4);
  const out: GenArg[] = [];
  for (let i = 0; i < n; i++) {
    const r = rng();
    out.push(r < 0.5 ? safeArg(rng) : r < 0.75 ? escapeArg(rng) : envArg(rng));
  }
  return out;
}

const ENV_EXEMPT = new Set(['echo', 'printf']);

/** Reference: the first argument that escapes for `command`, or undefined. */
function firstEscaping(command: string, args: readonly GenArg[]): GenArg | undefined {
  return args.find((a) => a.cls === 'escape' || (a.cls === 'env' && !ENV_EXEMPT.has(command)));
}

const ARG_COMMANDS = [
  'echo', 'printf', 'cat', 'ls', 'find', 'grep', 'head', 'node', 'npm', 'git', 'rm', 'cp', 'mv', 'mkdir', 'tsc',
] as const;

// ── Property 8 ────────────────────────────────────────────────────────────────────────────────

describe('ShellExecutor path-like arguments', () => {
  it('Property 8: spawns exactly when no argument escapes; spawn request is unchanged', async () => {
    // Feature: kernel-gap-closure, Property 8: The shell executor spawns exactly when no argument escapes
    // Validates: Requirements 3.1, 3.2, 3.3, 3.7
    await forAllAsync(0x5e08, 200, async (rng) => {
      supervisor.reset();
      const command = pick(rng, ARG_COMMANDS);
      const args = genArgs(rng);
      const texts = args.map((a) => a.text);
      const timeoutMs = bool(rng) ? int(rng, 1, 600_000) : undefined;
      const res = await run(command, texts, DEFAULT_SHELL_POLICY, timeoutMs === undefined ? {} : { timeoutMs });

      const offending = firstEscaping(command, args);
      if (offending === undefined) {
        // Spawned exactly once; request equals what ShellExecutor built before the change.
        expect(supervisor.callCount, `${command} ${JSON.stringify(texts)}`).toBe(1);
        expect(supervisor.lastOptions).toEqual({
          command,
          args: texts,
          cwd: workspace.root,
          env: safeEnv(process.env as Record<string, string | undefined>, DEFAULT_ENV_POLICY),
          timeoutMs: resolveTimeout(timeoutMs, DEFAULT_SHELL_POLICY),
        });
        expect(res.exitCode).toBe(0);
      } else {
        expect(supervisor.callCount, `${command} ${JSON.stringify(texts)}`).toBe(0);
        expectRejected(res, 'PATH_ESCAPE', offending.text);
      }
    });
  });

  it('Property 8: the command given as one string with extra tokens is still rejected before spawn', async () => {
    // Feature: kernel-gap-closure, Property 8: The shell executor spawns exactly when no argument escapes
    // `rm -rf ..` as one string is not an allowlisted name (COMMAND_NOT_ALLOWED today); it must never spawn.
    const res = await run('rm -rf ..', []);
    expect(res.exitCode).toBe(1);
    expect(supervisor.callCount).toBe(0);
  });

  // ── examples ──────────────────────────────────────────────────────────────────────────────

  it.each([
    ['rm', ['-rf', '..'], '..'],
    ['cat', ['../../etc/hosts'], '../../etc/hosts'],
    ['ls', ['~'], '~'],
    ['find', ['/'], '/'],
    ['cat', ['C:\\Windows\\win.ini'], 'C:\\Windows\\win.ini'],
    ['ls', ['$HOME'], '$HOME'],
  ] as Array<[string, string[], string]>)(
    'example: `%s %j` is rejected with PATH_ESCAPE and does not spawn',
    async (command, args, offending) => {
      // Note: `~` and the drive-letter form are only caught if the implementation treats them as
      // absolute/home references itself: checkPath resolves `~` and (on linux) `C:\...` as in-root
      // relative names. Task 4.2 must handle them per the Glossary.
      expectRejected(await run(command, args), 'PATH_ESCAPE', offending);
    },
  );

  it('example: `echo $HOME` spawns (env expansion exempt for echo)', async () => {
    const res = await run('echo', ['$HOME']);
    expect(res.exitCode).toBe(0);
    expect(supervisor.callCount).toBe(1);
    expect(supervisor.lastOptions?.args).toEqual(['$HOME']);
  });

  it('example: `printf %s $HOME` spawns (env expansion exempt for printf)', async () => {
    await run('printf', ['%s', '$HOME']);
    expect(supervisor.callCount).toBe(1);
  });

  it('example: `go test ./...` spawns (go allowed by an extended policy)', async () => {
    // `go` is not in DEFAULT_SHELL_ALLOWLIST, so the default policy rejects it earlier.
    const denied = await run('go', ['test', './...']);
    expect(denied.exitCode).toBe(1);
    expect(denied.stderr).toContain('not in the ShellPolicy allowlist'); // COMMAND_NOT_ALLOWED
    expect(supervisor.callCount).toBe(0);

    const res = await run('go', ['test', './...'], EXTENDED_POLICY);
    expect(res.exitCode).toBe(0);
    expect(supervisor.callCount).toBe(1);
    expect(supervisor.lastOptions?.args).toEqual(['test', './...']);
  });

  it('example: `git add .gitignore` spawns', async () => {
    await run('git', ['add', '.gitignore']);
    expect(supervisor.callCount).toBe(1);
  });

  it('example: absolute path INSIDE the root follows the actual checkPath outcome', async () => {
    // Current behaviour (read from NodeWorkspaceManager.checkPath / canonicalizePath): an absolute
    // path is canonicalised as is and accepted when it lies within the root (isWithinRoot), so
    // `cat <root>/a.txt` is NOT a PATH_ESCAPE and spawns. An absolute path outside the root is.
    const inside = `${rootDir}/a.txt`;
    await expect(workspace.checkPath(inside)).resolves.toBe(inside);
    const res = await run('cat', [inside]);
    expect(res.exitCode).toBe(0);
    expect(supervisor.callCount).toBe(1);
    expect(supervisor.lastOptions?.args).toEqual([inside]);
  });

  it('example: an absolute path OUTSIDE the root is PATH_ESCAPE', async () => {
    expectRejected(await run('cat', ['/etc/hosts']), 'PATH_ESCAPE', '/etc/hosts');
  });

  it('example: an unrelated URL and a quoted string never count as path-like', async () => {
    await run('curl', ['https://example.com/a/../../b']);
    await run('grep', ['a/../../b c', 'a.txt']);
    expect(supervisor.callCount).toBe(2);
  });
});

// ── Property 13 (shell part) ──────────────────────────────────────────────────────────────────

const SENSITIVE_BASES = [
  '.env', '.env.local', '.env.production', 'server.pem', 'server.key', 'id_rsa', 'id_ed25519',
  '.npmrc', '.pypirc', '.netrc', 'credentials', 'cert.p12', 'cert.pfx',
] as const;
const SENSITIVE_DIR_FILES = ['.ssh/known_hosts', '.ssh/config', '.aws/credentials'] as const;
const EXEMPT_PATHS = ['.env.example', '.env.sample', '.env.template', 'id_rsa.pub', '.ssh/id_rsa.pub'] as const;
const PROTECTED_PATHS = ['.git/config', '.git/hooks/pre-commit', '.hg/hgrc', '.svn/entries'] as const;
const NEVER_PROTECTED = ['.gitignore', '.github/workflows/ci.yml', '.gitattributes', '.gitmodules'] as const;

const ANY_COMMANDS = ['echo', 'cat', 'ls', 'find', 'grep', 'node', 'git', 'rm', 'cp', 'mv', 'mkdir', 'touch', 'tee'] as const;
const MUTATING_COMMANDS = ['rm', 'rmdir', 'mv', 'cp', 'mkdir', 'touch', 'tee'] as const; // all in EXTENDED_POLICY
const READ_COMMANDS = ['echo', 'cat', 'ls', 'find', 'grep', 'node', 'git'] as const;

/** Applies a random prefix directory, separator style and letter case to a literal path. */
function decorate(rng: Rng, path: string): string {
  let p = path;
  if (bool(rng, 0.4)) p = `${pathSegment(rng)}/${p}`;
  if (bool(rng)) p = randomCase(rng, p);
  if (bool(rng, 0.4)) p = p.replace(/\//g, '\\');
  if (bool(rng, 0.2)) p = `./${p}`;
  return p;
}

describe('Shell and git arguments obey the same access rules', () => {
  it('Property 13: a sensitive file candidate is rejected for every command, git included', async () => {
    // Feature: kernel-gap-closure, Property 13: Shell and git arguments obey the same access rules
    // Validates: Requirements 8.1, 8.3
    await forAllAsync(0x5e13, 200, async (rng) => {
      supervisor.reset();
      const command = pick(rng, ANY_COMMANDS);
      const sensitive = decorate(rng, pick(rng, [...SENSITIVE_BASES, ...SENSITIVE_DIR_FILES]));
      const before = bool(rng) ? [pathSegment(rng)] : [];
      const after = bool(rng) ? [pathSegment(rng)] : [];
      const res = await run(command, [...before, sensitive, ...after], EXTENDED_POLICY);
      expectRejected(res, 'SENSITIVE_PATH', sensitive);
    });
  });

  it('Property 13: exempt names (.env.example, *.pub) are not sensitive and spawn', async () => {
    // Feature: kernel-gap-closure, Property 13: Shell and git arguments obey the same access rules
    // Validates: Requirements 8.1
    await forAllAsync(0x5e14, 100, async (rng) => {
      supervisor.reset();
      const command = pick(rng, READ_COMMANDS);
      const arg = decorate(rng, pick(rng, EXEMPT_PATHS));
      await run(command, [arg], EXTENDED_POLICY);
      expect(supervisor.callCount, `${command} ${arg}`).toBe(1);
    });
  });

  it('Property 13: a protected path is rejected for MUTATING_PATH_COMMANDS and open for the rest', async () => {
    // Feature: kernel-gap-closure, Property 13: Shell and git arguments obey the same access rules
    // Validates: Requirements 8.2, 8.3
    await forAllAsync(0x5e15, 200, async (rng) => {
      supervisor.reset();
      const target = decorate(rng, pick(rng, PROTECTED_PATHS));
      if (bool(rng)) {
        const command = pick(rng, MUTATING_COMMANDS);
        const res = await run(command, [pathSegment(rng), target], EXTENDED_POLICY);
        expectRejected(res, 'PROTECTED_PATH', target);
      } else {
        const command = pick(rng, READ_COMMANDS); // includes git: exempt from the protected rule
        await run(command, [target], EXTENDED_POLICY);
        expect(supervisor.callCount, `${command} ${target}`).toBe(1);
      }
    });
  });

  it('Property 13: names that merely start with .git are never protected', async () => {
    // Feature: kernel-gap-closure, Property 13: Shell and git arguments obey the same access rules
    // Validates: Requirements 8.2
    await forAllAsync(0x5e16, 100, async (rng) => {
      supervisor.reset();
      const command = pick(rng, MUTATING_COMMANDS);
      const arg = decorate(rng, pick(rng, NEVER_PROTECTED));
      await run(command, [arg], EXTENDED_POLICY);
      expect(supervisor.callCount, `${command} ${arg}`).toBe(1);
    });
  });

  it('example: `cat .env` is SENSITIVE_PATH and does not spawn', async () => {
    expectRejected(await run('cat', ['.env']), 'SENSITIVE_PATH', '.env');
  });

  it('example: `git add .env` is SENSITIVE_PATH (git is not exempt from the sensitive rule)', async () => {
    expectRejected(await run('git', ['add', '.env']), 'SENSITIVE_PATH', '.env');
  });

  it('example: `cp a .git/config` is PROTECTED_PATH and does not spawn', async () => {
    expectRejected(await run('cp', ['a', '.git/config']), 'PROTECTED_PATH', '.git/config');
  });

  it('example: `git add .git/config`-style git arguments are exempt from the protected rule', async () => {
    await run('git', ['update-index', '.git/config']);
    expect(supervisor.callCount).toBe(1);
  });

  it('example: `cat .git/config` (read) spawns', async () => {
    await run('cat', ['.git/config']);
    expect(supervisor.callCount).toBe(1);
  });

  it('example: `cat .env.example` spawns', async () => {
    await run('cat', ['.env.example']);
    expect(supervisor.callCount).toBe(1);
  });
});
