/*
 * Copyright 2026 DienVu (Dienvu1008)
 * SPDX-License-Identifier: Apache-2.0
 */

// Kernel gap closure, task 1.6 (TEST-FIRST; implementation lands in tasks 3.1, 4.1, 4.3).
//
// Real NodeWorkspaceManager + FilesystemExecutor + GitExecutor (FakeProcessSupervisor for git
// spawns) over temp directories under os.tmpdir() (realpath'd, forward slashes, removed after).
//
//   Property 11 (manager part): protected VCS metadata is write-protected and read-open
//   Property 12: path rejections are failed tool results, never exceptions
//   Property 13 (git part): git_diff path / git_add entries that are sensitive never spawn
//   Examples: grep never leaks .env, glob/list_dir still list it, symlinks, fileExists, .env.example
//
// Iterations: 40 per filesystem-heavy property (each iteration creates real files and performs
// several real fs round-trips; 40 x ~8 tool calls keeps the file under a few seconds, including
// on Windows where fs is slow). Pure properties live in tests/tool/path-access-policy.spec.ts at 150.
//
// Notes on deliberate deviations from the task wording:
//   - move_file: FilesystemExecutor has no move_file case today (design Risks). The test asserts
//     the CURRENT behaviour (failed result "unknown filesystem tool", file untouched) and does not
//     invent the tool. WorkspaceManager.moveFile (both endpoints) is tested directly instead.
//   - grep / glob / list_dir: Requirement 6.7 says grep SKIPS sensitive files (exit 0, no content)
//     and glob/list_dir keep listing names. So they are asserted as "never throw, exit 0, no leak",
//     not as exit 1.
//
// **Validates: Requirements 6.2, 6.6, 6.7, 6.8, 7.1, 7.2, 7.4, 7.5, 8.4**
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  mkdtempSync, realpathSync, rmSync, promises as fsp,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import {
  NodeWorkspaceManager,
  FilesystemExecutor,
  GitExecutor,
} from '@codeforge/infrastructure';
import { WorkspaceError } from '@codeforge/agent-core';
import type { ToolCall } from '@codeforge/agent-core';
import { FakeProcessSupervisor } from '@codeforge/testing';
import {
  forAllAsync, pick, int, bool, randomCase, randomString, pathSegment, type Rng,
} from '../tool/gap-closure-generators.js';

const RUNS = 40;
const LOWER_ALNUM = 'abcdefghijklmnopqrstuvwxyz0123456789';

// ── fixtures ────────────────────────────────────────────────────────────────────────────────

let root: string;          // realpath'd, forward slashes
let wm: NodeWorkspaceManager;
let fsx: FilesystemExecutor;
let gitSupervisor: FakeProcessSupervisor;
let gitx: GitExecutor;

function makeCounters(): { now: () => string; nextId: () => string } {
  let t = 0; let n = 0;
  return {
    now: () => `2026-01-01T00:00:${String(t++ % 60).padStart(2, '0')}.000Z`,
    nextId: () => `ID-${String(n++).padStart(6, '0')}`,
  };
}

function call(toolName: string, args: Record<string, unknown>): ToolCall {
  return {
    toolCallId: 'TC-0001', sessionId: 'SE-0001', toolName, toolVersion: '1.0',
    riskClass: 'READ_ONLY', arguments: args, argumentsHash: 'hash',
    state: 'APPROVED', proposedBy: 'model',
    provenance: {
      provenanceId: 'PV-0001', source: { kind: 'runtime', id: 'SE-0001' },
      inputs: [], reason: 'test', at: '2026-01-01T00:00:00.000Z',
    },
    requestedAt: '2026-01-01T00:00:00.000Z',
  };
}

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'cf2-pae-'))).replace(/\\/g, '/');
  const c = makeCounters();
  wm = new NodeWorkspaceManager({ root, now: c.now, nextId: c.nextId });
  fsx = new FilesystemExecutor({ workspace: wm });
  gitSupervisor = new FakeProcessSupervisor();
  gitx = new GitExecutor({ workspace: wm, supervisor: gitSupervisor });
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Absolute path of a workspace-relative path. */
function abs(rel: string): string { return join(root, rel); }

async function put(rel: string, content: string): Promise<void> {
  await fsp.mkdir(dirname(abs(rel)), { recursive: true });
  await fsp.writeFile(abs(rel), content, 'utf8');
}

async function exists(rel: string): Promise<boolean> {
  try { await fsp.access(abs(rel)); return true; } catch { return false; }
}

async function read(rel: string): Promise<string> { return fsp.readFile(abs(rel), 'utf8'); }

async function rejectionOf(p: Promise<unknown>): Promise<WorkspaceError> {
  try { await p; } catch (err) {
    expect(err).toBeInstanceOf(WorkspaceError);
    return err as WorkspaceError;
  }
  throw new Error('expected a WorkspaceError rejection, but the operation resolved');
}

// ── generators ──────────────────────────────────────────────────────────────────────────────

/** Sensitive path templates (all denied by the Sensitive_Path rules). */
const SENSITIVE_TEMPLATES: readonly string[] = [
  '.env', '.env.local', '.env.production', 'server.pem', 'certs/server.key', 'id_rsa', 'id_ed25519',
  'keys/store.p12', 'cert.pfx', '.npmrc', '.pypirc', '.netrc', 'credentials', '.aws/credentials',
  '.ssh/known_hosts', '.ssh/config',
];

/** Protected VCS templates (write-protected, read-open). */
const PROTECTED_TEMPLATES: readonly string[] = [
  '.git/config', '.git/hooks/pre-commit', '.git/HEAD', '.hg/hgrc', '.svn/entries', 'sub/.git/config',
];

/** Look-alikes that must NOT be protected. */
const NOT_PROTECTED: readonly string[] = [
  '.github/workflows/ci.yml', '.gitignore', '.gitattributes', '.gitmodules', '.gitkeep', '.gitlab-ci.yml',
];

/** Safe, non-sensitive, non-protected source names. */
const SAFE_NAMES: readonly string[] = ['a.txt', 'main.ts', 'notes.md', 'data.json'];

interface Target { readonly rel: string; readonly prefix: string }

/** Each iteration works under its own folder so files from earlier iterations never interfere. */
function target(rng: Rng, label: string, i: number, templates: readonly string[]): Target {
  const extra = bool(rng, 0.4) ? `${pathSegment(rng, 5)}/` : '';
  const prefix = `${label}${i}/${extra}`;
  const tpl = randomCase(rng, pick(rng, templates));
  return { rel: `${prefix}${tpl}`, prefix };
}

/** Unique lowercase secret marker (lowercase so grep's default case-insensitivity cannot matter). */
function marker(rng: Rng): string { return `secret-${randomString(rng, LOWER_ALNUM, 12)}`; }

// ═══════════════════════════════════════════════════════════════════════════════════════════
// Property 11 (manager part)
// ═══════════════════════════════════════════════════════════════════════════════════════════

describe('Property 11 (manager part): protected VCS metadata is write-protected and read-open', () => {
  // Feature: kernel-gap-closure, Property 11: Protected VCS metadata is write-protected and read-open
  it('write, delete and move (either endpoint) of a protected path throw PROTECTED_PATH and change nothing', async () => {
    await forAllAsync(1101, RUNS, async (rng, i) => {
      const t = target(rng, 'p11w', i, PROTECTED_TEMPLATES);
      const original = `orig-${marker(rng)}`;
      const existing = bool(rng);
      if (existing) await put(t.rel, original);

      // write (new or existing)
      const w = await rejectionOf(wm.writeFile(t.rel, `changed-${original}`, 'S'));
      expect(w.code).toBe('PROTECTED_PATH');
      if (existing) expect(await read(t.rel)).toBe(original);
      else {
        expect(await exists(t.rel)).toBe(false);
        // The guard must run before mkdirp: a rejected write may not create the protected directory.
        expect(await exists(dirname(t.rel))).toBe(false);
      }

      if (existing) {
        const d = await rejectionOf(wm.deleteFile(t.rel, 'S'));
        expect(d.code).toBe('PROTECTED_PATH');
        expect(await read(t.rel)).toBe(original);
      }

      // move: normal -> protected (destination), protected -> normal (source)
      const src = `${t.prefix}${pick(rng, SAFE_NAMES)}`;
      await put(src, 'plain');
      const toProtected = await rejectionOf(wm.moveFile(src, t.rel, 'S'));
      expect(toProtected.code).toBe('PROTECTED_PATH');
      expect(await read(src)).toBe('plain');
      if (!existing) expect(await exists(t.rel)).toBe(false);

      if (existing) {
        const dest = `${t.prefix}moved-${pathSegment(rng, 5)}.txt`;
        const fromProtected = await rejectionOf(wm.moveFile(t.rel, dest, 'S'));
        expect(fromProtected.code).toBe('PROTECTED_PATH');
        expect(await read(t.rel)).toBe(original);
        expect(await exists(dest)).toBe(false);
      }
    });
  });

  it('readFile, readFileBytes, listDir, fileExists and dirExists on protected paths behave as without the policy', async () => {
    await forAllAsync(1102, RUNS, async (rng, i) => {
      const t = target(rng, 'p11r', i, PROTECTED_TEMPLATES);
      const body = `body-${marker(rng)}`;
      await put(t.rel, body);

      expect(await wm.readFile(t.rel)).toBe(body);
      expect((await wm.readFileBytes(t.rel)).toString('utf8')).toBe(body);
      expect(await wm.fileExists(t.rel)).toBe(true);
      const parent = dirname(t.rel).replace(/\\/g, '/');
      expect(await wm.dirExists(parent)).toBe(true);
      const names = (await wm.listDir(parent)).map((e) => e.name);
      expect(names).toContain(t.rel.slice(parent.length + 1).split('/')[0]);
    });
  });

  it('look-alike names (.github, .gitignore, .gitattributes, .gitmodules, .gitkeep, .gitlab-ci.yml) stay writable, deletable and movable', async () => {
    await forAllAsync(1103, RUNS, async (rng, i) => {
      const prefix = `p11l${i}/`;
      const rel = `${prefix}${randomCase(rng, pick(rng, NOT_PROTECTED))}`;
      await wm.writeFile(rel, 'v1', 'S');
      expect(await read(rel)).toBe('v1');
      await wm.writeFile(rel, 'v2', 'S');
      expect(await read(rel)).toBe('v2');
      const dest = `${prefix}${pick(rng, NOT_PROTECTED).replace(/^\.github\/workflows\//, '')}.moved`;
      await wm.moveFile(rel, dest, 'S');
      expect(await exists(rel)).toBe(false);
      expect(await read(dest)).toBe('v2');
      await wm.deleteFile(dest, 'S');
      expect(await exists(dest)).toBe(false);
    });
  });

  it('a sensitive endpoint of moveFile is rejected as SENSITIVE_PATH and the source stays (example)', async () => {
    await put('p11m/a.txt', 'plain');
    const e = await rejectionOf(wm.moveFile('p11m/a.txt', 'p11m/.env', 'S'));
    expect(e.code).toBe('SENSITIVE_PATH');
    expect(await read('p11m/a.txt')).toBe('plain');
    expect(await exists('p11m/.env')).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════
// Property 12
// ═══════════════════════════════════════════════════════════════════════════════════════════

describe('Property 12: path rejections are failed tool results, never exceptions', () => {
  // Feature: kernel-gap-closure, Property 12: Path rejections are failed tool results, never exceptions
  it('read_file / write_file / edit_file / delete_file on a sensitive path: exit 1, SENSITIVE_PATH, file unchanged, no secret in the result', async () => {
    await forAllAsync(1201, RUNS, async (rng, i) => {
      const t = target(rng, 'p12s', i, SENSITIVE_TEMPLATES);
      const secret = marker(rng);
      const original = `alpha ${secret}`;
      const existing = bool(rng, 0.8);
      if (existing) await put(t.rel, original);

      const attempts: Array<[string, Record<string, unknown>]> = [
        ['write_file', { path: t.rel, content: 'overwritten' }],
      ];
      if (existing) {
        attempts.push(
          ['read_file', { path: t.rel }],
          ['edit_file', { path: t.rel, oldString: 'alpha', newString: 'omega' }],
          ['delete_file', { path: t.rel }],
        );
      }
      for (const [tool, args] of attempts) {
        const res = await fsx.execute(call(tool, args)); // must not throw
        expect(res.exitCode, `${tool} on ${t.rel}`).toBe(1);
        expect(res.stderr, `${tool} on ${t.rel}`).toContain('SENSITIVE_PATH');
        expect(res.stdout).not.toContain(secret);
        expect(res.stderr).not.toContain(secret);
      }
      if (existing) expect(await read(t.rel)).toBe(original);
      else expect(await exists(t.rel)).toBe(false);
    });
  });

  it('write_file / edit_file / delete_file on a protected path: exit 1, PROTECTED_PATH, file unchanged; read_file still works', async () => {
    await forAllAsync(1202, RUNS, async (rng, i) => {
      const t = target(rng, 'p12p', i, PROTECTED_TEMPLATES);
      const original = `alpha ${marker(rng)}`;
      await put(t.rel, original);

      for (const [tool, args] of [
        ['write_file', { path: t.rel, content: 'overwritten' }],
        ['edit_file', { path: t.rel, oldString: 'alpha', newString: 'omega' }],
        ['delete_file', { path: t.rel }],
      ] as Array<[string, Record<string, unknown>]>) {
        const res = await fsx.execute(call(tool, args));
        expect(res.exitCode, `${tool} on ${t.rel}`).toBe(1);
        expect(res.stderr, `${tool} on ${t.rel}`).toContain('PROTECTED_PATH');
      }
      expect(await read(t.rel)).toBe(original);

      const readRes = await fsx.execute(call('read_file', { path: t.rel }));
      expect(readRes.exitCode).toBe(0);
      expect(readRes.stdout).toBe(original);
    });
  });

  it('grep, glob and list_dir never throw; grep skips the sensitive file (exit 0, no content, no path); glob and list_dir still list names', async () => {
    await forAllAsync(1203, RUNS, async (rng, i) => {
      const t = target(rng, 'p12g', i, SENSITIVE_TEMPLATES);
      const secret = marker(rng);
      await put(t.rel, `line ${secret}`);
      // Control file proves grep itself works in this folder.
      await put(`p12g${i}/control.txt`, `control ${secret}`);

      // The pattern is NOT the marker (grep echoes its pattern in the header).
      const g = await fsx.execute(call('grep', { pattern: 'secret-[a-z0-9]{12}', path: `p12g${i}` }));
      expect(g.exitCode).toBe(0);
      expect(g.stdout).toContain('control.txt');
      const sensitiveHits = g.stdout.split('\n').filter((l) => l.includes(secret) && !l.includes('control.txt'));
      expect(sensitiveHits).toEqual([]);
      expect(g.stdout.toLowerCase()).not.toContain(t.rel.toLowerCase());

      const gl = await fsx.execute(call('glob', { pattern: `p12g${i}/**` }));
      expect(gl.exitCode).toBe(0);
      expect(gl.stdout).toContain(t.rel);

      const parent = dirname(t.rel).replace(/\\/g, '/');
      const ld = await fsx.execute(call('list_dir', { path: parent }));
      expect(ld.exitCode).toBe(0);
      expect(ld.stdout).toContain(t.rel.slice(parent.length + 1).split('/')[0]!);
    });
    // glob walks the whole shared temp workspace, which grows each iteration: allow more than 5 s.
  }, 30_000);

  it('move_file is not implemented by FilesystemExecutor today: failed result, no throw, file untouched (documents current behaviour)', async () => {
    await put('p12mv/a.txt', 'plain');
    for (const to of ['p12mv/b.txt', 'p12mv/.env', 'p12mv/.git/config']) {
      const res = await fsx.execute(call('move_file', { path: 'p12mv/a.txt', to }));
      expect(res.exitCode).toBe(1);
      expect(res.stderr).toContain('unknown filesystem tool');
    }
    expect(await read('p12mv/a.txt')).toBe('plain');
    expect(await exists('p12mv/b.txt')).toBe(false);
    expect(await exists('p12mv/.env')).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════
// Property 13 (git part)
// ═══════════════════════════════════════════════════════════════════════════════════════════

describe('Property 13 (git part): git_diff path and git_add entries that are sensitive never spawn', () => {
  // Feature: kernel-gap-closure, Property 13: Shell and git arguments obey the same access rules
  it('a sensitive git_diff path returns exit 1 SENSITIVE_PATH and does not spawn', async () => {
    await forAllAsync(1301, RUNS, async (rng) => {
      gitSupervisor.reset();
      const rel = `${bool(rng) ? `${pathSegment(rng, 5)}/` : ''}${randomCase(rng, pick(rng, SENSITIVE_TEMPLATES))}`;
      const res = await gitx.execute(call('git_diff', { path: rel, ...(bool(rng) ? { staged: true } : {}) }));
      expect(res.exitCode, rel).toBe(1);
      expect(res.stderr, rel).toContain('SENSITIVE_PATH');
      expect(gitSupervisor.callCount, rel).toBe(0);
    });
  });

  it('git_add with a sensitive entry anywhere in the list returns exit 1 SENSITIVE_PATH and does not spawn', async () => {
    await forAllAsync(1302, RUNS, async (rng) => {
      gitSupervisor.reset();
      const paths: string[] = [];
      const n = int(rng, 1, 4);
      for (let k = 0; k < n; k++) paths.push(`${pathSegment(rng, 5)}/${pick(rng, SAFE_NAMES)}`);
      const bad = `${bool(rng) ? `${pathSegment(rng, 5)}/` : ''}${randomCase(rng, pick(rng, SENSITIVE_TEMPLATES))}`;
      paths.splice(int(rng, 0, paths.length), 0, bad);
      const res = await gitx.execute(call('git_add', { paths }));
      expect(res.exitCode, bad).toBe(1);
      expect(res.stderr, bad).toContain('SENSITIVE_PATH');
      expect(gitSupervisor.callCount, bad).toBe(0);
    });
  });

  it('non-sensitive paths (including .env.example, .gitignore and .git-adjacent look-alikes) still spawn exactly once', async () => {
    await forAllAsync(1303, RUNS, async (rng) => {
      gitSupervisor.reset();
      const okPaths = ['.env.example', '.env.sample', '.env.template', '.gitignore', 'src/env.js',
        '.github/workflows/ci.yml', 'id_rsa.pub', ...SAFE_NAMES];
      const chosen = [pick(rng, okPaths), pick(rng, okPaths)];
      const add = await gitx.execute(call('git_add', { paths: chosen }));
      expect(add.exitCode).toBe(0);
      expect(gitSupervisor.callCount).toBe(1);
      expect(gitSupervisor.lastOptions?.args).toEqual(['--no-pager', 'add', '--', ...chosen]);

      gitSupervisor.reset();
      const diff = await gitx.execute(call('git_diff', { path: chosen[0] }));
      expect(diff.exitCode).toBe(0);
      expect(gitSupervisor.callCount).toBe(1);
    });
  });

  it('git_status, git_log and git_commit are unaffected (example)', async () => {
    gitSupervisor.reset();
    expect((await gitx.execute(call('git_status', {}))).exitCode).toBe(0);
    expect((await gitx.execute(call('git_log', { n: 3 }))).exitCode).toBe(0);
    expect((await gitx.execute(call('git_commit', { message: 'msg' }))).exitCode).toBe(0);
    expect(gitSupervisor.callCount).toBe(3);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════
// Examples
// ═══════════════════════════════════════════════════════════════════════════════════════════

/** Symlink support probe (Windows without developer mode / admin denies symlink creation). */
async function probeSymlinks(): Promise<boolean> {
  const d = mkdtempSync(join(tmpdir(), 'cf2-pae-sl-'));
  try {
    await fsp.writeFile(join(d, 't'), 'x');
    await fsp.symlink('t', join(d, 'l'), 'file');
    return true;
  } catch {
    return false;
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
}
const canSymlink = await probeSymlinks();

describe('Examples: .env handling', () => {
  it('grep for a unique marker stored in .env never returns the marker or the path', async () => {
    const secret = 'uniq-kq3x7v2m9137';
    await put('ex-grep/.env', `TOKEN=${secret}\n`);
    await put('ex-grep/readme.txt', 'nothing here\n');
    const res = await fsx.execute(call('grep', { pattern: 'uniq-[a-z0-9]+9137', path: 'ex-grep' }));
    expect(res.exitCode).toBe(0);
    expect(res.stdout).not.toContain(secret);
    expect(res.stdout).not.toContain('.env');
    expect(res.stdout).toContain('no matches');
  });

  it('glob and list_dir still list .env (a name is not secret content)', async () => {
    await put('ex-list/.env', 'A=1\n');
    await put('ex-list/.env.example', 'A=\n');
    const gl = await fsx.execute(call('glob', { pattern: 'ex-list/**' }));
    expect(gl.exitCode).toBe(0);
    expect(gl.stdout).toContain('ex-list/.env');
    expect(gl.stdout).toContain('ex-list/.env.example');
    const ld = await fsx.execute(call('list_dir', { path: 'ex-list' }));
    expect(ld.exitCode).toBe(0);
    expect(ld.stdout).toContain('f .env');
    expect(ld.stdout).toContain('f .env.example');
  });

  it('fileExists(".env") behaves as before (true) while readFile is rejected', async () => {
    await put('ex-exists/.env', 'A=1\n');
    expect(await wm.fileExists('ex-exists/.env')).toBe(true);
    expect(await wm.fileExists('ex-exists/.env.nope')).toBe(false);
    expect((await rejectionOf(wm.readFile('ex-exists/.env'))).code).toBe('SENSITIVE_PATH');
    expect((await rejectionOf(wm.readFileBytes('ex-exists/.env'))).code).toBe('SENSITIVE_PATH');
  });

  it('.env.example (and .sample, .template) can be read and written', async () => {
    for (const name of ['.env.example', '.env.sample', '.env.template']) {
      const rel = `ex-example/${name}`;
      await put(rel, 'A=\n');
      const res = await fsx.execute(call('read_file', { path: rel }));
      expect(res.exitCode, name).toBe(0);
      expect(res.stdout).toBe('A=\n');
      const w = await fsx.execute(call('write_file', { path: rel, content: 'A=placeholder\n' }));
      expect(w.exitCode, name).toBe(0);
      expect(await read(rel)).toBe('A=placeholder\n');
    }
  });

  it('the rejection message is actionable: names the code and points at an example file', async () => {
    await put('ex-msg/.env', 'A=1\n');
    const res = await fsx.execute(call('read_file', { path: 'ex-msg/.env' }));
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain('SENSITIVE_PATH');
    expect(res.stderr).toContain('.env.example');
  });
});

describe('Examples: symlinks inside the workspace (skipped when the OS denies symlink creation)', () => {
  it.skipIf(!canSymlink)('a symlink to .env is rejected for read and write; the target is unchanged', async () => {
    await put('ex-sl1/.env', 'TOKEN=hidden\n');
    await fsp.symlink('.env', abs('ex-sl1/link-env'), 'file');
    expect((await rejectionOf(wm.readFile('ex-sl1/link-env'))).code).toBe('SENSITIVE_PATH');
    expect((await rejectionOf(wm.writeFile('ex-sl1/link-env', 'x', 'S'))).code).toBe('SENSITIVE_PATH');
    const res = await fsx.execute(call('read_file', { path: 'ex-sl1/link-env' }));
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain('SENSITIVE_PATH');
    expect(res.stdout).not.toContain('hidden');
    expect(await read('ex-sl1/.env')).toBe('TOKEN=hidden\n');
  });

  it.skipIf(!canSymlink)('a symlink to .git/config is read-open and write-protected', async () => {
    await put('ex-sl2/.git/config', '[core]\n');
    await fsp.symlink('.git/config', abs('ex-sl2/link-gitcfg'), 'file');
    expect(await wm.readFile('ex-sl2/link-gitcfg')).toBe('[core]\n');
    expect((await rejectionOf(wm.writeFile('ex-sl2/link-gitcfg', 'x', 'S'))).code).toBe('PROTECTED_PATH');
    expect((await rejectionOf(wm.deleteFile('ex-sl2/link-gitcfg', 'S'))).code).toBe('PROTECTED_PATH');
    const res = await fsx.execute(call('write_file', { path: 'ex-sl2/link-gitcfg', content: 'x' }));
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain('PROTECTED_PATH');
    expect(await read('ex-sl2/.git/config')).toBe('[core]\n');
  });
});
