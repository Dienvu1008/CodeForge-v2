/*
 * Copyright 2026 DienVu (Dienvu1008)
 * SPDX-License-Identifier: Apache-2.0
 */

// Kernel gap closure, task 1.6 (TEST-FIRST; implementation lands in task 4.4).
//
// Property 15: baseline capture matches the reference listing.
//   Real WorkspaceTestBaseline over generated temp trees (test-like and ordinary files, files inside
//   node_modules / .git / dist / build / coverage / .cache / .codeforge / .cf2). The reference listing
//   below is written independently of the production code (plain segment checks, no shared helper).
//
// "No file content is read" is checked three ways, because no single check works everywhere:
//   1. best-effort spies on node:fs read entry points (fs.promises.readFile/open, fs.readFileSync,
//      fs.openSync, fs.createReadStream). They only see calls made through those module objects, so a
//      destructured named import in the implementation would escape them (hence the next point);
//   2. POSIX only (skipped on Windows and when running as root): every file is chmod 000 and capture
//      must still succeed with the same result, which is impossible if it opened files;
//   3. code review of task 4.4 (the implementation must use readdir only).
//
// Iterations: 40 for the tree property (each iteration builds a real tree of up to 25 files and walks
// it), 150 for the pure case/separator rewrite property.
//
// **Validates: Requirements 9.1**
import { describe, it, expect, afterEach, vi } from 'vitest';
import fs, { mkdtempSync, realpathSync, rmSync, promises as fsp } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkspaceTestBaseline } from '@codeforge/infrastructure';
import {
  forAll, forAllAsync, pick, int, bool, randomCase, type Rng,
} from '../tool/gap-closure-generators.js';

const TREE_RUNS = 40;
const PURE_RUNS = 150;

// ── reference model (independent of production code) ─────────────────────────────────────

const REF_SKIPPED_DIRS: readonly string[] = [
  'node_modules', '.git', 'dist', 'build', 'coverage', '.cache', '.codeforge', '.cf2',
];
const REF_TEST_DIRS: readonly string[] = ['test', 'tests', '__tests__', 'spec'];

/** Reference: is this '/'-separated lowercase path a test-like file path? */
function refIsTestLike(rel: string): boolean {
  const segs = rel.split('/');
  const base = segs[segs.length - 1]!;
  const dirs = segs.slice(0, -1);
  if (dirs.some((d) => REF_TEST_DIRS.includes(d))) return true;
  if (/^test\..+$/.test(base)) return true;
  if (/^.+\.test\..+$/.test(base)) return true;
  if (/^.+\.spec\..+$/.test(base)) return true;
  if (base.startsWith('test_') && base.length > 5) return true;
  if (/^.+_test\..+$/.test(base)) return true;
  return false;
}

/** Reference: is any DIRECTORY segment of the path a skipped directory? */
function refIsSkipped(rel: string): boolean {
  const dirs = rel.split('/').slice(0, -1);
  return dirs.some((d) => REF_SKIPPED_DIRS.includes(d));
}

function refBaseline(files: readonly string[]): Set<string> {
  return new Set(files.filter((f) => !refIsSkipped(f) && refIsTestLike(f)));
}

// ── generators ──────────────────────────────────────────────────────────────────────────

const DIR_POOL: readonly string[] = [
  'src', 'lib', 'pkg', 'protest', 'test', 'tests', '__tests__', 'spec',
  'node_modules', '.git', 'dist', 'build', 'coverage', '.cache', '.codeforge', '.cf2',
];
const FILE_POOL: readonly string[] = [
  'index.ts', 'util.js', 'README.md', 'notes.txt', 'latest.js', 'contest.ts', 'test.js', 'test.ts',
  'a.test.ts', 'b.spec.js', 'c.test.js', 'test_x.py', 'x_test.go', 'main_test.ts', 'a.js', 'data.json',
];

/** Distinct '/'-separated lowercase file paths (1..25), dirs 0..3 deep drawn from DIR_POOL. */
function genTree(rng: Rng): string[] {
  const out = new Set<string>();
  const n = int(rng, 1, 25);
  for (let k = 0; k < n; k++) {
    const depth = int(rng, 0, 3);
    const dirs: string[] = [];
    for (let d = 0; d < depth; d++) dirs.push(pick(rng, DIR_POOL));
    out.add([...dirs, pick(rng, FILE_POOL)].join('/'));
  }
  return [...out];
}

/** Case / separator / "./" rewrite that must not change a baseline verdict. */
function rewrite(rng: Rng, rel: string): string {
  let r = randomCase(rng, rel);
  if (bool(rng)) r = r.replace(/\//g, '\\');
  if (bool(rng, 0.3)) r = r.replace(/\//g, '//');
  if (bool(rng, 0.3)) r = `./${r}`;
  return r;
}

// ── fixtures ────────────────────────────────────────────────────────────────────────────

const cleanup: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of cleanup.splice(0)) rmSync(d, { recursive: true, force: true });
});

function newRoot(): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'cf2-base-')));
  cleanup.push(d);
  return d.replace(/\\/g, '/');
}

async function materialise(root: string, files: readonly string[]): Promise<void> {
  for (const f of files) {
    const p = join(root, f);
    await fsp.mkdir(dirname(p), { recursive: true });
    await fsp.writeFile(p, `content of ${f}\n`, 'utf8');
  }
}

// ═══════════════════════════════════════════════════════════════════════════════════════
// Property 15
// ═══════════════════════════════════════════════════════════════════════════════════════

describe('Property 15: baseline capture matches the reference listing', () => {
  // Feature: kernel-gap-closure, Property 15: Baseline capture matches the reference listing
  it('isBaselineTest and size equal the reference listing for generated trees', async () => {
    await forAllAsync(1501, TREE_RUNS, async (rng) => {
      const root = newRoot();
      const files = genTree(rng);
      await materialise(root, files);
      const expected = refBaseline(files);

      const baseline = new WorkspaceTestBaseline({ root });
      await baseline.capture();

      for (const f of files) {
        expect(baseline.isBaselineTest(f), `${f} (expected ${expected.has(f)})`).toBe(expected.has(f));
      }
      expect(baseline.size).toBe(expected.size);
      // A path that was never created is not a member, even when it looks test-like.
      expect(baseline.isBaselineTest('never/created/a.test.ts')).toBe(false);
    });
  });

  it('isBaselineTest is invariant under case, separator, duplicate-separator and "./" rewrites', async () => {
    const root = newRoot();
    const files = [
      'src/a.test.ts', 'tests/helper.js', 'spec/b.rb', 'test.js', 'x_test.go', 'test_y.py',
      'src/index.ts', 'node_modules/pkg/test/z.js', 'latest.js',
    ];
    await materialise(root, files);
    const baseline = new WorkspaceTestBaseline({ root });
    await baseline.capture();
    const expected = refBaseline(files);

    forAll(1502, PURE_RUNS, (rng) => {
      const f = pick(rng, files);
      const rw = rewrite(rng, f);
      expect(baseline.isBaselineTest(rw), `${JSON.stringify(rw)} from ${f}`).toBe(expected.has(f));
    });
  });

  it('skips node_modules, .git, dist, build, coverage, .cache, .codeforge and .cf2 (example)', async () => {
    const root = newRoot();
    const skipped = REF_SKIPPED_DIRS.map((d) => `${d}/inner/a.test.ts`);
    const kept = ['src/a.test.ts', 'tests/b.js'];
    await materialise(root, [...skipped, ...kept]);
    const baseline = new WorkspaceTestBaseline({ root });
    await baseline.capture();
    for (const s of skipped) expect(baseline.isBaselineTest(s), s).toBe(false);
    for (const k of kept) expect(baseline.isBaselineTest(k), k).toBe(true);
    expect(baseline.size).toBe(kept.length);
  });

  it('an empty workspace gives an empty baseline, and capture() replaces the previous set (example)', async () => {
    const root = newRoot();
    const baseline = new WorkspaceTestBaseline({ root });
    await baseline.capture();
    expect(baseline.size).toBe(0);
    expect(baseline.isBaselineTest('a.test.ts')).toBe(false);

    await materialise(root, ['a.test.ts']);
    await baseline.capture();
    expect(baseline.size).toBe(1);
    expect(baseline.isBaselineTest('a.test.ts')).toBe(true);

    await fsp.rm(join(root, 'a.test.ts'));
    await baseline.capture();
    expect(baseline.size).toBe(0);
  });

  it('a file created after capture is not a member (the agent may edit its own new tests)', async () => {
    const root = newRoot();
    await materialise(root, ['old.test.ts']);
    const baseline = new WorkspaceTestBaseline({ root });
    await baseline.capture();
    await materialise(root, ['new.test.ts']);
    expect(baseline.isBaselineTest('old.test.ts')).toBe(true);
    expect(baseline.isBaselineTest('new.test.ts')).toBe(false);
  });

  it('capture() does not read file content (best-effort spies on node:fs read entry points)', async () => {
    const root = newRoot();
    await materialise(root, ['src/a.test.ts', 'tests/b.js', 'src/index.ts', 'node_modules/p/test/c.js']);

    const underRoot = (args: unknown[]): boolean =>
      typeof args[0] === 'string' && args[0].replace(/\\/g, '/').startsWith(root);
    const spies = [
      vi.spyOn(fsp, 'readFile'),
      vi.spyOn(fsp, 'open'),
      vi.spyOn(fs, 'readFileSync'),
      vi.spyOn(fs, 'openSync'),
      vi.spyOn(fs, 'createReadStream'),
    ];

    const baseline = new WorkspaceTestBaseline({ root });
    await baseline.capture();

    for (const spy of spies) {
      const hits = spy.mock.calls.filter((c) => underRoot(c as unknown[]));
      expect(hits, 'a file under the workspace root was opened or read during capture').toEqual([]);
    }
    expect(baseline.isBaselineTest('src/a.test.ts')).toBe(true);
  });

  // POSIX only: unreadable files make any content read fail. Windows has no chmod 000, and root ignores it.
  const canChmod = process.platform !== 'win32' && typeof process.getuid === 'function' && process.getuid() !== 0;
  it.skipIf(!canChmod)('capture() succeeds with the same result when every file is chmod 000 (POSIX only)', async () => {
    await forAllAsync(1503, 10, async (rng) => {
      const root = newRoot();
      const files = genTree(rng);
      await materialise(root, files);
      for (const f of files) await fsp.chmod(join(root, f), 0o000);
      const expected = refBaseline(files);

      const baseline = new WorkspaceTestBaseline({ root });
      await baseline.capture();
      for (const f of files) expect(baseline.isBaselineTest(f), f).toBe(expected.has(f));
      expect(baseline.size).toBe(expected.size);
    });
  });
});
