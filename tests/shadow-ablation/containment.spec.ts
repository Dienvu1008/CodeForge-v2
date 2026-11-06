/*
 * Copyright 2026 DienVu (Dienvu1008)
 * SPDX-License-Identifier: Apache-2.0
 */

// kernel-shadow-ablation — sandbox and containment (design C5, C6, C9; Properties 12, 13).
//
// Property 12 drives a REAL `NodeWorkspaceManager` (the Kernel) wrapped in a REAL
// `AblationWorkspaceManager` with generated escaping targets (`..` chains, absolute paths,
// mixed separators) for every WorkspaceManager operation, in both modes. The escape targets
// point AT a sentinel directory: a separate `mkdtemp` sibling of the sandbox inside
// `realpath(os.tmpdir())`. Its full contents are hashed before and after every operation, and
// `os.tmpdir()` is scanned for any new entry named like the (unique) escape leaves.
//
// SAFETY: every generated target is checked (by this file, before use) to resolve inside
// `realpath(os.tmpdir())`, so even a total containment failure could not write anywhere else.
// No test calls `destroySandbox` (an `rm -rf`) on an existing directory that fails the guard.
//
// Requirements 6.5, 7.1, 7.2, 7.3, 7.4, 7.5, 7.6.
import { describe, it, expect, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  OPEN_PATH_ACCESS_POLICY,
  WorkspaceError,
  type ChangeRecord,
  type DirEntry,
  type SpawnOptions,
  type WorkspaceManager,
} from '@codeforge/agent-core';
import { NodeWorkspaceManager } from '@codeforge/infrastructure';
import { FakeProcessSupervisor } from '@codeforge/testing';
import {
  AblationWorkspaceManager,
  ContainedProcessSupervisor,
  DecisionLedger,
  SHADOW_SIMULATED_PATH_SEGMENT,
  SHADOW_SIMULATED_READ,
  SHADOW_SIMULATED_SPAWN,
  SandboxError,
  assertSandboxRoot,
  createSandbox,
  destroySandbox,
  type AblationMode,
  type Sandbox,
} from '@codeforge/testing/shadow-ablation';

// ── seeded PRNG (same mulberry32 generators as tests/mission/clarification-generators.ts; kept
// local because tests/tsconfig.json does not include tests/mission/**) ─────────────────────────

type Rng = () => number;

function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function int(rng: Rng, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}
function bool(rng: Rng, pTrue = 0.5): boolean {
  return rng() < pTrue;
}
function pick<T>(rng: Rng, items: readonly T[]): T {
  if (items.length === 0) throw new Error('pick: empty list');
  return items[int(rng, 0, items.length - 1)] as T;
}
/** Run `body` `runs` times; on failure re-throw with iteration + seed (reproducible counterexample). */
function forAll(seed: number, runs: number, body: (rng: Rng, iteration: number) => void): void {
  const rng = mulberry32(seed);
  for (let i = 0; i < runs; i++) {
    try {
      body(rng, i);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`property failed at iteration ${i} (seed ${seed}): ${msg}`, { cause: err });
    }
  }
}
/** Async twin of `forAll`: re-throws with iteration + seed so a counterexample is reproducible. */
async function forAllAsync(seed: number, runs: number, body: (rng: Rng, iteration: number) => Promise<void>): Promise<void> {
  const rng = mulberry32(seed);
  for (let i = 0; i < runs; i++) {
    try {
      await body(rng, i);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`property failed at iteration ${i} (seed ${seed}): ${msg}`, { cause: err });
    }
  }
}

// ── environment ──────────────────────────────────────────────────────────────────────────────

const isWin = process.platform === 'win32';
const TMP = realpathSync.native(tmpdir());
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
/** Per-run token carried by every unique escape leaf, so the tmpdir scan can find strays. */
const ESC_TOKEN = `cf-esc-${process.pid}-${Date.now().toString(36)}`;

const fold = (p: string): string => (isWin ? p.toLowerCase() : p);

/** Independent of the module under test: does `p` (canonical, absolute) lie strictly under `parent`? */
function strictlyUnder(p: string, parent: string): boolean {
  const r = relative(fold(parent), fold(p));
  return r !== '' && !isAbsolute(r) && r !== '..' && !r.startsWith(`..${sep}`);
}
/** Does `target` (as the Kernel receives it) lexically resolve outside `root`? */
function escapes(root: string, target: string): boolean {
  const abs = resolve(root, target);
  return fold(abs) !== fold(root) && !strictlyUnder(abs, root);
}

// ── cleanup bookkeeping ──────────────────────────────────────────────────────────────────────

const toRemove: string[] = [];
const savedRepoEnv = process.env['CODEFORGE_REPO'];

function tmpMkdtemp(prefix: string): string {
  const dir = realpathSync.native(mkdtempSync(join(TMP, prefix)));
  toRemove.push(dir);
  return dir;
}
function newSandbox(label: AblationMode, seed: Readonly<Record<string, string>> = { 'seed.txt': 'seed-content\n' }): Sandbox {
  const sb = createSandbox(seed, label);
  toRemove.push(sb.root);
  return sb;
}

afterEach(() => {
  if (savedRepoEnv === undefined) delete process.env['CODEFORGE_REPO'];
  else process.env['CODEFORGE_REPO'] = savedRepoEnv;
  for (const dir of toRemove.splice(0)) {
    // Only ever remove what this file created strictly inside the OS temp dir.
    if (strictlyUnder(dir, TMP)) rmSync(dir, { recursive: true, force: true });
  }
  // Stray escape leaves (only present if containment failed): remove them too.
  for (const name of readdirSync(TMP)) {
    if (name.includes(ESC_TOKEN)) rmSync(join(TMP, name), { recursive: true, force: true });
  }
});

// ── sentinel ─────────────────────────────────────────────────────────────────────────────────

const SENTINEL_FILES: Readonly<Record<string, string>> = {
  'keep.txt': 'sentinel keep\n',
  'nested/deep.txt': 'sentinel deep\n',
};

function createSentinel(): string {
  const dir = tmpMkdtemp('cf-sentinel-');
  for (const [rel, content] of Object.entries(SENTINEL_FILES)) {
    const abs = join(dir, ...rel.split('/'));
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return dir;
}

/** SHA-256 over every entry (relative path, type, bytes) under `dir`, in sorted order. */
function hashTree(dir: string): string {
  const h = createHash('sha256');
  const walk = (abs: string, rel: string): void => {
    for (const name of readdirSync(abs).sort()) {
      const childAbs = join(abs, name);
      const childRel = rel === '' ? name : `${rel}/${name}`;
      const st = lstatSync(childAbs);
      if (st.isDirectory()) {
        h.update(`D:${childRel}\n`);
        walk(childAbs, childRel);
      } else {
        h.update(`F:${childRel}:${st.size}\n`);
        h.update(readFileSync(childAbs));
      }
    }
  };
  walk(dir, '');
  return h.digest('hex');
}

/** Entries of the OS temp dir that look like an escaped effect of this run. */
function strayTmpEntries(sentinelBase: string): string[] {
  return readdirSync(TMP).filter(
    (name) => name.includes(ESC_TOKEN) || (name !== sentinelBase && name.includes(sentinelBase)),
  );
}

// ── Property 12 generators ───────────────────────────────────────────────────────────────────

type Op =
  | 'writeFile'
  | 'deleteFile'
  | 'moveOut'
  | 'moveIn'
  | 'readFile'
  | 'readFileBytes'
  | 'listDir'
  | 'fileExists'
  | 'dirExists'
  | 'checkPath';

const OPS: readonly Op[] = [
  'writeFile', 'deleteFile', 'moveOut', 'moveIn', 'readFile',
  'readFileBytes', 'listDir', 'fileExists', 'dirExists', 'checkPath',
];

type Shape = 'dotdot' | 'absolute' | 'mixed-dotdot' | 'mixed-absolute';
const SHAPES: readonly Shape[] = ['dotdot', 'absolute', 'mixed-dotdot', 'mixed-absolute'];

/** Leaf (relative to the base dir, '/'-separated) appropriate for the operation; null = the dir itself. */
function genLeaf(rng: Rng, op: Op, base: 'sentinel' | 'tmp', i: number): string | null {
  const unique = `${ESC_TOKEN}-${i}-${int(rng, 0, 1e6)}`;
  switch (op) {
    case 'writeFile':
    case 'moveOut':
      return pick(rng, [unique, `nested/${unique}`, `${unique}-dir/${unique}.txt`]);
    case 'deleteFile':
    case 'moveIn':
    case 'readFile':
    case 'readFileBytes':
    case 'fileExists':
      // Existing sentinel files only; never a pre-existing name directly in the OS temp dir.
      return base === 'sentinel' ? pick(rng, ['keep.txt', 'nested/deep.txt']) : unique;
    case 'listDir':
    case 'dirExists':
      return base === 'sentinel' ? pick(rng, [null, 'nested']) : null;
    case 'checkPath':
      return pick(rng, [null, 'keep.txt', unique]);
  }
}

/** Swap a random subset of the '/' separators for '\'. */
function mixSeparators(rng: Rng, s: string): string {
  let out = '';
  let swapped = false;
  for (const ch of s) {
    if (ch === '/' && bool(rng)) {
      out += '\\';
      swapped = true;
    } else out += ch;
  }
  // Guarantee at least one swap when there is a separator.
  if (!swapped) {
    const idx = out.indexOf('/');
    if (idx >= 0) out = `${out.slice(0, idx)}\\${out.slice(idx + 1)}`;
  }
  return out;
}

/**
 * An escape target for a sandbox directly under TMP, pointing at the sentinel (or at TMP itself).
 * `..` chains first descend `k` levels inside the sandbox then climb `k + 1`, so they land in TMP
 * and never above it.
 */
function genTarget(rng: Rng, shape: Shape, sentinelBase: string, base: 'sentinel' | 'tmp', leaf: string | null): string {
  const tail = [base === 'sentinel' ? sentinelBase : null, leaf].filter((x): x is string => x !== null).join('/');
  const tmpSlash = TMP.replace(/\\/g, '/');
  switch (shape) {
    case 'dotdot':
    case 'mixed-dotdot': {
      const k = int(rng, 0, 3);
      const down = Array.from({ length: k }, (_, j) => pick(rng, ['a', 'b', 'src', `d${j}`, '.'])).map((s) => `${s}/`).join('');
      // `.` segments do not descend: count only real ones when climbing.
      const realDown = down.split('/').filter((s) => s !== '' && s !== '.').length;
      const up = '../'.repeat(realDown + 1);
      const rel = `${down}${up}${tail}`.replace(/\/$/, '');
      if (shape === 'dotdot') return rel;
      // On POSIX a '\' inside the descending part would merge two segments (`a\d1` is one name),
      // so the climb would overshoot TMP. Mix only the `..`/tail part there: that can only make
      // the climb shorter (`..\..` is a filename), never longer.
      return isWin ? mixSeparators(rng, rel) : `${down}${mixSeparators(rng, `${up}${tail}`.replace(/\/$/, ''))}`;
    }
    case 'absolute':
    case 'mixed-absolute': {
      if (shape === 'absolute') {
        const native = tail === '' ? TMP : join(TMP, ...tail.split('/'));
        return bool(rng) ? native : native.replace(/\\/g, '/');
      }
      // Mixed: on POSIX only the separators *inside* the tail are mixed. The separator joining the
      // TMP prefix and the tail stays '/', otherwise `/tmp\x` is one filename directly under '/'.
      if (!isWin) return tail === '' ? tmpSlash : `${tmpSlash}/${mixSeparators(rng, tail)}`;
      const rest = tail === '' ? '' : mixSeparators(rng, `/${tail}`);
      return mixSeparators(rng, `${tmpSlash}${rest.replace(/\\/g, '/')}`);
    }
  }
}

/** Test-side safety guard: a target must resolve (lexically) strictly inside TMP. */
function assertTargetUnderTmp(root: string, target: string): void {
  const abs = resolve(root, target);
  if (!strictlyUnder(abs, TMP) && fold(abs) !== fold(TMP)) {
    throw new Error(`generator bug: target ${JSON.stringify(target)} resolves outside the OS temp dir (${abs})`);
  }
}

function genContent(rng: Rng): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789 \n{}';
  let s = '';
  const len = int(rng, 0, 64);
  for (let j = 0; j < len; j++) s += pick(rng, [...alphabet]);
  return s;
}

const sha256Hex = (s: string): string => createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');

function makeKernel(root: string): NodeWorkspaceManager {
  let n = 0;
  return new NodeWorkspaceManager({
    root,
    now: () => new Date(0).toISOString(),
    nextId: () => `kernel-${++n}`,
  });
}

interface OpOutcome {
  readonly value?: unknown;
  readonly error?: unknown;
}

async function runOp(ws: WorkspaceManager, op: Op, target: string, content: string, i: number): Promise<OpOutcome> {
  try {
    switch (op) {
      case 'writeFile': return { value: await ws.writeFile(target, content, 'sess') };
      case 'deleteFile': return { value: await ws.deleteFile(target, 'sess') };
      case 'moveOut': return { value: await ws.moveFile('seed.txt', target, 'sess') };
      case 'moveIn': return { value: await ws.moveFile(target, `moved-${i}.txt`, 'sess') };
      case 'readFile': return { value: await ws.readFile(target) };
      case 'readFileBytes': return { value: await ws.readFileBytes(target) };
      case 'listDir': return { value: await ws.listDir(target) };
      case 'fileExists': return { value: await ws.fileExists(target) };
      case 'dirExists': return { value: await ws.dirExists(target) };
      case 'checkPath': return { value: await ws.checkPath(target) };
    }
  } catch (error) {
    return { error };
  }
}

function isKernelEscapeError(err: unknown): boolean {
  return err instanceof WorkspaceError && (err.code === 'PATH_ESCAPE' || err.code === 'SYMLINK_ESCAPE');
}

function assertSimulatedChange(value: unknown, kind: ChangeRecord['kind']): void {
  const rec = value as ChangeRecord;
  expect(rec.kind).toBe(kind);
  expect(rec.inScratchZone).toBe(false);
  expect(rec.sessionId).toBe('sess');
}

/** The strict outcome contract for an escaping target (design C6 table). */
function assertEscapeOutcome(mode: AblationMode, op: Op, target: string, out: OpOutcome, root: string): void {
  if (op === 'fileExists' || op === 'dirExists') {
    // Both modes: NodeWorkspaceManager parity (enforce) / simulated `false` (shadow).
    expect(out.error).toBeUndefined();
    expect(out.value).toBe(false);
    return;
  }
  if (mode === 'enforce') {
    expect(out.value).toBeUndefined();
    expect(isKernelEscapeError(out.error), `enforce ${op}(${target}) must throw a Kernel escape error, got ${String(out.error)}`).toBe(true);
    return;
  }
  expect(out.error, `shadow ${op}(${target}) must not throw`).toBeUndefined();
  switch (op) {
    case 'writeFile': assertSimulatedChange(out.value, 'create'); break;
    case 'deleteFile': assertSimulatedChange(out.value, 'delete'); break;
    case 'moveOut':
    case 'moveIn': assertSimulatedChange(out.value, 'rename'); break;
    case 'readFile': expect(out.value).toBe(SHADOW_SIMULATED_READ); break;
    case 'readFileBytes': expect((out.value as Buffer).toString('utf8')).toBe(SHADOW_SIMULATED_READ); break;
    case 'listDir': expect(out.value).toEqual([]); break;
    case 'checkPath': {
      const p = out.value as string;
      expect(p.endsWith(`/${SHADOW_SIMULATED_PATH_SEGMENT}`)).toBe(true);
      expect(existsSync(p)).toBe(false);
      expect(strictlyUnder(resolve(p), root)).toBe(true);
      break;
    }
  }
}

// ── Property 12 ──────────────────────────────────────────────────────────────────────────────

describe('kernel-shadow-ablation containment (design C5/C6)', () => {
  // Feature: kernel-shadow-ablation, Property 12: Containment keeps every effect inside the sandbox
  // **Validates: Requirements 7.1, 7.2, 7.3, 7.4**
  it('Property 12: no generated escape target changes the sentinel or the OS temp dir, in either mode', async () => {
    const sentinel = createSentinel();
    const sentinelBase = basename(sentinel);
    const sentinelHash = hashTree(sentinel);
    let escaping = 0;
    const shapesSeen = new Set<Shape>();
    const opsSeen = new Set<Op>();

    await forAllAsync(0x5a12, 120, async (rng, i) => {
      const op = pick(rng, OPS);
      const shape = pick(rng, SHAPES);
      const base: 'sentinel' | 'tmp' =
        op === 'deleteFile' || op === 'moveIn' ? 'sentinel' : bool(rng, 0.7) ? 'sentinel' : 'tmp';
      const leaf = genLeaf(rng, op, base, i);
      const target = genTarget(rng, shape, sentinelBase, base, leaf);
      const content = genContent(rng);

      for (const mode of ['enforce', 'shadow'] as const) {
        const sandbox = newSandbox(mode);
        assertTargetUnderTmp(sandbox.root, target);
        const isEscape = escapes(sandbox.root, target);
        const ledger = new DecisionLedger();
        ledger.setStep(0, 'organic');
        const ws = new AblationWorkspaceManager(makeKernel(sandbox.root), sandbox, mode, ledger);

        const out = await runOp(ws, op, target, content, i);

        // Containment: the sentinel is byte-identical and nothing named like the target appeared in TMP.
        expect(hashTree(sentinel), `${mode} ${op}(${JSON.stringify(target)}) changed the sentinel`).toBe(sentinelHash);
        expect(strayTmpEntries(sentinelBase), `${mode} ${op}(${JSON.stringify(target)}) left an entry in the OS temp dir`).toEqual([]);

        if (!isEscape) continue; // e.g. a POSIX filename containing '\': a real effect, but inside the sandbox
        escaping++;
        shapesSeen.add(shape);
        opsSeen.add(op);

        assertEscapeOutcome(mode, op, target, out, sandbox.root);
        // A move whose destination escapes never removes its in-sandbox source.
        if (op === 'moveOut') expect(readFileSync(join(sandbox.root, 'seed.txt'), 'utf8')).toBe('seed-content\n');

        const { containment } = ledger.snapshot();
        if (mode === 'shadow') {
          const wsOp = op === 'moveOut' || op === 'moveIn' ? 'moveFile' : op;
          const ev = containment.find((c) => c.op === wsOp && c.target === target);
          expect(ev, `shadow ${op}(${target}) must record a containment event`).toBeDefined();
          if (op === 'writeFile') expect(ev?.sha256).toBe(sha256Hex(content));
        } else {
          // Enforce: a Kernel block records no containment event; only a kernelMiss would.
          for (const c of containment) expect(c.kind).toBe('kernelMiss');
        }
      }
    });

    // The generator must actually exercise escapes, every shape and every operation.
    // (On POSIX a '\' is a filename character, so some mixed `..` targets legitimately stay inside.)
    expect(escaping).toBeGreaterThanOrEqual(120);
    const requiredShapes: readonly Shape[] = isWin ? SHAPES : ['dotdot', 'absolute', 'mixed-absolute'];
    for (const s of requiredShapes) expect(shapesSeen.has(s), `shape ${s} never escaped`).toBe(true);
    expect([...opsSeen].sort()).toEqual([...OPS].sort());
  });

  // ── Property 13 ────────────────────────────────────────────────────────────────────────────

  // Feature: kernel-shadow-ablation, Property 13: Sandbox root guard
  // **Validates: Requirements 6.5**
  it('Property 13: bad roots throw SandboxError before any filesystem access; fresh mkdtemp roots pass', () => {
    const cwd = process.cwd();
    const cwdAncestors: string[] = [];
    for (let d = dirname(cwd); ; d = dirname(d)) {
      cwdAncestors.push(d);
      if (dirname(d) === d) break;
    }
    // A guarded area inside TMP, used as the CODEFORGE_REPO stand-in for the "contains repo" cases.
    const repoArea = tmpMkdtemp('cf-guard-repo-');
    const fakeRepo = join(repoArea, 'repo', 'pkg');
    mkdirSync(fakeRepo, { recursive: true });

    type Gen = (rng: Rng, i: number) => { root: string; repoEnv?: string; exists: boolean };
    const badGens: readonly Gen[] = [
      () => ({ root: cwd, exists: true }),
      () => ({ root: REPO, exists: true }),
      (rng) => ({ root: pick(rng, cwdAncestors), exists: true }),
      () => ({ root: TMP, exists: true }),
      () => ({ root: `${TMP}${sep}`, exists: true }),
      () => ({ root: isWin ? TMP.toUpperCase() : TMP.replace(/\\/g, '/'), exists: true }),
      () => ({ root: dirname(TMP), exists: true }),
      // Prefix trick: a sibling of TMP whose name starts with TMP's name.
      (_rng, i) => ({ root: `${TMP}-${ESC_TOKEN}-${i}`, exists: false }),
      (_rng, i) => ({ root: join(homedir(), `${ESC_TOKEN}-${i}`), exists: false }),
      (_rng, i) => ({ root: join(TMP, '..', `${ESC_TOKEN}-${i}`), exists: false }),
      (rng) => ({ root: pick(rng, [repoArea, join(repoArea, 'repo'), fakeRepo]), repoEnv: fakeRepo, exists: true }),
    ];

    const ledger = new DecisionLedger();
    forAll(0x5a13, 120, (rng, i) => {
      const g = pick(rng, badGens)(rng, i);
      if (g.repoEnv !== undefined) process.env['CODEFORGE_REPO'] = g.repoEnv;
      else if (savedRepoEnv === undefined) delete process.env['CODEFORGE_REPO'];
      else process.env['CODEFORGE_REPO'] = savedRepoEnv;
      try {
        expect(() => assertSandboxRoot(g.root), `root ${g.root}`).toThrow(SandboxError);

        const sandbox: Sandbox = { root: g.root, seed: new Map(), label: 'shadow' };
        const innerWs = new RecordingWorkspace(g.root.replace(/\\/g, '/'), () => g.root);
        for (const mode of ['enforce', 'shadow'] as const) {
          expect(() => new AblationWorkspaceManager(innerWs, sandbox, mode, ledger)).toThrow(SandboxError);
        }
        expect(innerWs.calls).toEqual([]);

        const innerPs = new FakeProcessSupervisor();
        expect(() => new ContainedProcessSupervisor(innerPs, { sandbox, allowedExact: [], ledger })).toThrow(SandboxError);
        expect(innerPs.callCount).toBe(0);

        if (!g.exists) {
          // Safe to exercise the destroy guard only on roots that do not exist.
          expect(() => destroySandbox(sandbox)).toThrow(SandboxError);
          expect(existsSync(g.root)).toBe(false);
        }
      } finally {
        if (savedRepoEnv === undefined) delete process.env['CODEFORGE_REPO'];
        else process.env['CODEFORGE_REPO'] = savedRepoEnv;
      }

      // Fresh mkdtemp roots (and a not-yet-existing child of one) are accepted.
      const fresh = tmpMkdtemp('cf-guard-');
      const root = bool(rng, 0.8) ? fresh : join(fresh, `child-${i}`);
      expect(() => assertSandboxRoot(root)).not.toThrow();
      const sandbox: Sandbox = { root, seed: new Map(), label: 'enforce' };
      const inner = new RecordingWorkspace(root.replace(/\\/g, '/'), () => root);
      expect(() => new AblationWorkspaceManager(inner, sandbox, 'enforce', ledger)).not.toThrow();
      expect(() => new ContainedProcessSupervisor(new FakeProcessSupervisor(), { sandbox, allowedExact: [], ledger })).not.toThrow();
    });

    // createSandbox roots are accepted too.
    const sb = newSandbox('shadow');
    expect(() => assertSandboxRoot(sb.root)).not.toThrow();
    expect(strictlyUnder(sb.root, TMP)).toBe(true);
  });

  // ── Examples ───────────────────────────────────────────────────────────────────────────────

  describe('kernelMiss: the Kernel accepts a path the independent check considers outside', () => {
    for (const mode of ['enforce', 'shadow'] as const) {
      it(`${mode}: contained, recorded as kernelMiss, nothing reaches the inner manager or the sentinel`, async () => {
        const sentinel = createSentinel();
        const before = hashTree(sentinel);
        const sandbox = newSandbox(mode);
        const outside = join(sentinel, 'keep.txt');
        const inner = new RecordingWorkspace(sandbox.root.replace(/\\/g, '/'), () => outside);
        const ledger = new DecisionLedger();
        ledger.setStep(3, 'organic');
        const ws = new AblationWorkspaceManager(inner, sandbox, mode, ledger);

        const escapeRel = `../${basename(sentinel)}/keep.txt`;
        // Case 1: the relpath itself escapes. Case 2: an innocent relpath, but the Kernel's
        // canonical answer points outside (caught via the Kernel-path candidate).
        for (const rel of [escapeRel, 'inside.txt']) {
          const w = await runOp(ws, 'writeFile', rel, 'payload', 0);
          const r = await runOp(ws, 'readFile', rel, '', 0);
          if (mode === 'enforce') {
            for (const o of [w, r]) {
              expect(o.error).toBeInstanceOf(WorkspaceError);
              expect((o.error as WorkspaceError).code).toBe('PATH_ESCAPE');
            }
          } else {
            assertSimulatedChange(w.value, 'create');
            expect(r.value).toBe(SHADOW_SIMULATED_READ);
          }
        }

        const { containment, entries } = ledger.snapshot();
        expect(containment.map((c) => [c.kind, c.op, c.target])).toEqual([
          ['kernelMiss', 'writeFile', escapeRel],
          ['kernelMiss', 'readFile', escapeRel],
          ['kernelMiss', 'writeFile', 'inside.txt'],
          ['kernelMiss', 'readFile', 'inside.txt'],
        ]);
        expect(containment.every((c) => c.step === 3)).toBe(true);
        const writes = containment.filter((c) => c.op === 'writeFile');
        expect(writes.every((c) => c.sha256 === sha256Hex('payload'))).toBe(true);
        // The Kernel said allow: the ledger keeps `allow` (once per step).
        expect(entries.map((e) => [e.point, e.decision])).toEqual([['EP-PATH', 'allow']]);
        // Only checkPath reached the inner manager; no effectful call did.
        expect(inner.calls.every((c) => c === 'checkPath')).toBe(true);
        expect(hashTree(sentinel)).toBe(before);
      });
    }
  });

  describe('ContainedProcessSupervisor (design C9)', () => {
    const spawnOpts = (command: string, args: readonly string[], cwd: string): SpawnOptions => ({
      command, args, cwd, timeoutMs: 1_000,
    });

    it('runs an exact-match command in the sandbox root on the inner supervisor and simulates everything else', async () => {
      const sandbox = newSandbox('enforce');
      const inner = new FakeProcessSupervisor().setOutcome(/^npm$/, { exitCode: 0, stdout: 'real run' });
      const ledger = new DecisionLedger();
      ledger.setStep(1, 'organic');
      const sup = new ContainedProcessSupervisor(inner, { sandbox, allowedExact: ['npm test'], ledger });

      // Exact command + exact cwd (also with '/' separators and a trailing slash) → real.
      const rootVariants = [sandbox.root, `${sandbox.root.replace(/\\/g, '/')}/`];
      if (isWin) rootVariants.push(sandbox.root.toUpperCase());
      for (const cwd of rootVariants) {
        const res = await sup.spawn(spawnOpts('npm', ['test'], cwd));
        expect(res.stdout).toBe('real run');
      }
      expect(inner.callCount).toBe(rootVariants.length);

      // Anything else → simulated, no inner call.
      const simulated: Array<[string, readonly string[], string]> = [
        ['npm', ['test'], join(sandbox.root, 'sub')], // subdirectory cwd
        ['npm', ['test'], dirname(sandbox.root)], // parent cwd
        ['npm', ['run', 'test'], sandbox.root], // different command line
        ['npm', ['test', '--', '--watch'], sandbox.root], // extra args
        ['rm', ['-rf', sandbox.root], sandbox.root],
      ];
      for (const [command, args, cwd] of simulated) {
        const res = await sup.spawn(spawnOpts(command, args, cwd));
        expect(res).toEqual(SHADOW_SIMULATED_SPAWN);
      }
      expect(inner.callCount).toBe(rootVariants.length);

      const { containment } = ledger.snapshot();
      expect(containment).toHaveLength(simulated.length);
      expect(containment.every((c) => c.kind === 'command-simulated' && c.op === 'spawn' && c.step === 1)).toBe(true);
      expect(containment.map((c) => c.target)).toEqual(simulated.map(([c, a]) => [c, ...a].join(' ')));
      expect(existsSync(sandbox.root)).toBe(true);
    });
  });

  describe('kernel-gap-closure: access rejections are not escapes', () => {
    const SEED = { '.git/config': '[core]\n', '.env': 'SECRET=1\n' } as const;

    function accessWs(mode: AblationMode): { ws: AblationWorkspaceManager; ledger: DecisionLedger; sandbox: Sandbox } {
      const sandbox = newSandbox(mode, SEED);
      let n = 0;
      const inner = new NodeWorkspaceManager({
        root: sandbox.root,
        now: () => new Date(0).toISOString(),
        nextId: () => `kernel-${++n}`,
        // Same wiring as arm.ts: the shadow arm's inner manager is open.
        ...(mode === 'shadow' ? { pathAccess: OPEN_PATH_ACCESS_POLICY } : {}),
      });
      const ledger = new DecisionLedger();
      ledger.setStep(0, 'organic');
      return { ws: new AblationWorkspaceManager(inner, sandbox, mode, ledger), ledger, sandbox };
    }

    it('shadow: a write to .git/config lands inside the sandbox only, with no escape-simulated event', async () => {
      const sentinel = createSentinel();
      const before = hashTree(sentinel);
      const { ws, ledger, sandbox } = accessWs('shadow');

      const change = await ws.writeFile('.git/config', 'shadow-write\n', 'sess');
      expect(change.relpath).toBe('.git/config');
      expect(readFileSync(join(sandbox.root, '.git', 'config'), 'utf8')).toBe('shadow-write\n');
      expect(strictlyUnder(join(sandbox.root, '.git', 'config'), TMP)).toBe(true);

      const snap = ledger.snapshot();
      expect(snap.containment.filter((c) => c.kind === 'escape-simulated')).toEqual([]);
      expect(snap.containment).toEqual([]);
      expect(snap.entries.filter((e) => e.reason === 'PROTECTED_PATH')).toHaveLength(1);
      expect(hashTree(sentinel)).toBe(before);
      expect(strayTmpEntries(basename(sentinel))).toEqual([]);
    });

    it('enforce: sensitive and protected rejections leave files untouched and record no containment event', async () => {
      const { ws, ledger, sandbox } = accessWs('enforce');
      await expect(ws.writeFile('.git/config', 'x', 'sess')).rejects.toMatchObject({ code: 'PROTECTED_PATH' });
      await expect(ws.readFile('.env')).rejects.toMatchObject({ code: 'SENSITIVE_PATH' });
      expect(readFileSync(join(sandbox.root, '.git', 'config'), 'utf8')).toBe('[core]\n');
      expect(ledger.snapshot().containment).toEqual([]);
    });
  });

  it('destroySandbox removes the sandbox directory', () => {
    const sb = createSandbox({ 'a/b.txt': 'x', 'c.txt': 'y' }, 'shadow');
    toRemove.push(sb.root);
    expect(strictlyUnder(sb.root, TMP)).toBe(true);
    expect(readFileSync(join(sb.root, 'a', 'b.txt'), 'utf8')).toBe('x');
    expect([...sb.seed.keys()]).toEqual(['a/b.txt', 'c.txt']);
    destroySandbox(sb);
    expect(existsSync(sb.root)).toBe(false);
  });
});

// ── fake inner WorkspaceManager ──────────────────────────────────────────────────────────────

/**
 * Records every call; `checkPath` answers with `canonical()` (it never throws), every other method
 * returns an inert value WITHOUT touching the filesystem.
 */
class RecordingWorkspace implements WorkspaceManager {
  readonly calls: string[] = [];

  constructor(
    readonly root: string,
    private readonly canonical: () => string,
  ) {}

  async checkPath(): Promise<string> {
    this.calls.push('checkPath');
    return this.canonical();
  }
  async readFile(): Promise<string> {
    this.calls.push('readFile');
    return 'inner-read';
  }
  async readFileBytes(): Promise<Buffer> {
    this.calls.push('readFileBytes');
    return Buffer.from('inner-read');
  }
  async listDir(): Promise<readonly DirEntry[]> {
    this.calls.push('listDir');
    return [];
  }
  async fileExists(): Promise<boolean> {
    this.calls.push('fileExists');
    return true;
  }
  async dirExists(): Promise<boolean> {
    this.calls.push('dirExists');
    return true;
  }
  async writeFile(relpath: string, _c: string | Buffer, sessionId: string): Promise<ChangeRecord> {
    this.calls.push('writeFile');
    return this.change('create', relpath, sessionId);
  }
  async deleteFile(relpath: string, sessionId: string): Promise<ChangeRecord> {
    this.calls.push('deleteFile');
    return this.change('delete', relpath, sessionId);
  }
  async moveFile(_from: string, to: string, sessionId: string): Promise<ChangeRecord> {
    this.calls.push('moveFile');
    return this.change('rename', to, sessionId);
  }
  private change(kind: ChangeRecord['kind'], relpath: string, sessionId: string): ChangeRecord {
    return { changeId: 'inner', sessionId, kind, relpath, ownedBy: 'agent', inScratchZone: false, at: new Date(0).toISOString() };
  }
}
