/*
 * Copyright 2026 DienVu (Dienvu1008)
 * SPDX-License-Identifier: Apache-2.0
 */

// Sandbox (design C5) — the throwaway directory each arm runs in (Requirement 7.1), plus the
// containment check that is deliberately INDEPENDENT from the Kernel's `canonicalizePath`
// (Requirement 7.3): resolve → realpath of the nearest existing ancestor → prefix check against the
// sandbox root, case-folded on win32.
//
// `assertSandboxRoot` is the guard every `Ablation*` constructor taking a root calls first
// (Requirement 6.5): a root outside the OS temp dir, or one that is / contains the cwd or the repo,
// is refused before anything is written there. It only performs read-only realpath lookups.
import { lstatSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { createIsolatedWorkspace, destroyIsolatedWorkspace } from '@codeforge/infrastructure';

export interface Sandbox {
  /** Canonical (realpath) absolute root, strictly under `realpath(os.tmpdir())`. */
  readonly root: string;
  /** Seed files written at creation: '/'-separated relative path → content. */
  readonly seed: ReadonlyMap<string, string>;
  readonly label: 'enforce' | 'shadow';
}

export type SandboxErrorCode =
  | 'OUTSIDE_TMPDIR'
  | 'IS_TMPDIR'
  | 'CONTAINS_CWD'
  | 'CONTAINS_REPO'
  | 'UNRESOLVABLE';

export class SandboxError extends Error {
  constructor(
    readonly code: SandboxErrorCode,
    readonly root: string,
    message: string,
  ) {
    super(message);
    this.name = 'SandboxError';
  }
}

const isWin = process.platform === 'win32';

function fold(p: string): string {
  return isWin ? p.toLowerCase() : p;
}

/** `child` is `parent` itself or lies under `parent/` (both canonical). */
function isSameOrUnder(child: string, parent: string): boolean {
  const c = fold(child);
  const p = fold(parent);
  if (c === p) return true;
  const prefix = p.endsWith(sep) ? p : p + sep;
  return c.startsWith(prefix);
}

/**
 * Canonical form of an absolute path: realpath of the nearest existing ancestor joined with the
 * not-yet-existing remainder. Returns `undefined` when a component exists but cannot be resolved
 * (e.g. a dangling symlink) — its target is unknown, so callers must treat it as unsafe.
 */
function canonicalize(absPath: string): string | undefined {
  let current = resolve(absPath);
  const rest: string[] = [];
  for (;;) {
    try {
      const real = realpathSync.native(current);
      return rest.length === 0 ? real : join(real, ...rest.reverse());
    } catch {
      // Exists but unresolvable (dangling / looping symlink, permission) → unsafe.
      if (pathExistsNoFollow(current)) return undefined;
      const parent = dirname(current);
      if (parent === current) return resolve(absPath); // nothing exists, not even the drive root
      rest.push(basename(current));
      current = parent;
    }
  }
}

function pathExistsNoFollow(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Throw `SandboxError` unless `root` is strictly inside `realpath(os.tmpdir())` and neither equals
 * nor contains `process.cwd()` or the repository root (`CODEFORGE_REPO`, when set).
 */
export function assertSandboxRoot(root: string): void {
  const tmp = canonicalize(tmpdir());
  const canon = canonicalize(root);
  if (tmp === undefined || canon === undefined) {
    throw new SandboxError('UNRESOLVABLE', root, `sandbox root cannot be resolved: ${root}`);
  }
  if (fold(canon) === fold(tmp)) {
    throw new SandboxError('IS_TMPDIR', root, `sandbox root must be strictly inside the OS temp dir, not the temp dir itself: ${root}`);
  }
  if (!isSameOrUnder(canon, tmp)) {
    throw new SandboxError('OUTSIDE_TMPDIR', root, `sandbox root is outside the OS temp dir (${tmp}): ${root}`);
  }
  const cwd = canonicalize(process.cwd()) ?? resolve(process.cwd());
  if (isSameOrUnder(cwd, canon)) {
    throw new SandboxError('CONTAINS_CWD', root, `sandbox root equals or contains the current working directory: ${root}`);
  }
  const repoEnv = process.env['CODEFORGE_REPO'];
  if (repoEnv !== undefined && repoEnv.trim() !== '') {
    const repo = canonicalize(repoEnv) ?? resolve(repoEnv);
    if (isSameOrUnder(repo, canon)) {
      throw new SandboxError('CONTAINS_REPO', root, `sandbox root equals or contains the repository root: ${root}`);
    }
  }
}

/**
 * Create a fresh sandbox (mkdtemp under `os.tmpdir()`, prefix `cf-bench-`) seeded with
 * `seedFiles`, then verify its root. The returned root is canonical (realpath), so the Kernel and
 * the containment check see the same path even where the temp dir is a symlink (macOS).
 */
export function createSandbox(seedFiles: Readonly<Record<string, string>>, label: 'enforce' | 'shadow'): Sandbox {
  const handle = createIsolatedWorkspace(seedFiles);
  const root = realpathSync.native(handle.root);
  assertSandboxRoot(root);
  const seed = new Map<string, string>();
  for (const rel of Object.keys(seedFiles).sort()) {
    seed.set(rel.split('\\').join('/'), seedFiles[rel] ?? '');
  }
  return { root, seed, label };
}

/**
 * Containment check: `true` iff `p` (absolute, or relative to the sandbox root) resolves — through
 * the realpath of its nearest existing ancestor — to the sandbox root or a path under it.
 */
export function isInsideSandbox(sandbox: Sandbox, p: string): boolean {
  const root = canonicalize(sandbox.root);
  const target = canonicalize(resolve(sandbox.root, p));
  if (root === undefined || target === undefined) return false;
  return isSameOrUnder(target, root);
}

/** Best-effort `rm -rf` of the sandbox. Refuses (throws `SandboxError`) on a root that fails the guard. */
export function destroySandbox(sandbox: Sandbox): void {
  assertSandboxRoot(sandbox.root);
  destroyIsolatedWorkspace({ root: sandbox.root, seededSnapshot: new Map() });
}
