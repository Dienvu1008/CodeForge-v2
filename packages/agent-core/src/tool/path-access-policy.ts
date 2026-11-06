/*
 * Copyright 2026 DienVu (Dienvu1008)
 * SPDX-License-Identifier: Apache-2.0
 */

// Path_Access_Policy — kernel-gap-closure design C1 (D-C sensitive files, D-D protected VCS metadata).
//
// Pure: no I/O, no `node:` imports, no clock/random/env. Enforced by NodeWorkspaceManager
// (infrastructure); this module only answers "is this workspace-relative path allowed?".
//
//   SE-012: sensitive files (secrets) cannot be read or written by the agent.
//   WS-011: VCS metadata (.git/.hg/.svn) cannot be written by the agent (reads stay open).
//
// Matching is case-insensitive on every platform (NTFS/APFS are case-insensitive and a
// platform-independent function gives the same verdict everywhere).

/** 'write' covers create, modify, delete and either endpoint of a move. */
export type PathAccess = 'read' | 'write';
export type PathAccessCode = 'SENSITIVE_PATH' | 'PROTECTED_PATH';

export type PathAccessVerdict =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly code: PathAccessCode; readonly rule: string };

export interface PathAccessPolicy {
  /** A path under any of these directories is sensitive (e.g. `.ssh`). */
  readonly sensitiveDirs: readonly string[];
  /** Exact sensitive basenames. */
  readonly sensitiveBasenames: readonly string[];
  /** Sensitive basename prefixes (`.env.`, `id_rsa`, ...). */
  readonly sensitiveBasenamePrefixes: readonly string[];
  /** Sensitive basename extensions (with leading dot). */
  readonly sensitiveExtensions: readonly string[];
  /** Basenames that are never sensitive (placeholders). */
  readonly sensitiveExemptBasenames: readonly string[];
  /** Basename suffixes that are never sensitive (public key halves). */
  readonly publicSuffixes: readonly string[];
  /** Directory names whose subtree is write-protected. */
  readonly protectedDirs: readonly string[];
}

export const DEFAULT_PATH_ACCESS_POLICY: PathAccessPolicy = Object.freeze({
  sensitiveDirs: Object.freeze(['.ssh']),
  sensitiveBasenames: Object.freeze(['.env', '.npmrc', '.pypirc', '.netrc', 'credentials']),
  sensitiveBasenamePrefixes: Object.freeze(['.env.', 'id_rsa', 'id_ed25519', 'id_ecdsa', 'id_dsa']),
  sensitiveExtensions: Object.freeze(['.pem', '.key', '.p12', '.pfx']),
  sensitiveExemptBasenames: Object.freeze(['.env.example', '.env.sample', '.env.template']),
  publicSuffixes: Object.freeze(['.pub']),
  protectedDirs: Object.freeze(['.git', '.hg', '.svn']),
});

/** No rules at all. Only for the measurement shadow arm and tests that need an open manager. */
export const OPEN_PATH_ACCESS_POLICY: PathAccessPolicy = Object.freeze({
  sensitiveDirs: Object.freeze([]),
  sensitiveBasenames: Object.freeze([]),
  sensitiveBasenamePrefixes: Object.freeze([]),
  sensitiveExtensions: Object.freeze([]),
  sensitiveExemptBasenames: Object.freeze([]),
  publicSuffixes: Object.freeze([]),
  protectedDirs: Object.freeze([]),
});

/**
 * Lowercased path segments. `\` becomes `/`, empty and `.` segments are dropped, `..` is resolved
 * lexically (never rises above the start), an NTFS `:stream` suffix and trailing dots/spaces are removed.
 */
export function normalizeSegments(relpath: string): readonly string[] {
  const out: string[] = [];
  for (const raw of relpath.replace(/\\/g, '/').split('/')) {
    const colon = raw.indexOf(':');
    const noStream = colon >= 0 ? raw.slice(0, colon) : raw;
    if (noStream === '.') continue;
    if (noStream === '..') {
      out.pop();
      continue;
    }
    const seg = noStream.replace(/[. ]+$/, '').toLowerCase();
    if (seg === '') continue;
    out.push(seg);
  }
  return out;
}

function sensitiveRule(policy: PathAccessPolicy, segments: readonly string[]): string | undefined {
  const base = segments[segments.length - 1];
  if (base === undefined) return undefined;
  if (policy.sensitiveExemptBasenames.includes(base)) return undefined;
  if (policy.publicSuffixes.some((s) => base.endsWith(s))) return undefined;
  const dirs = segments.slice(0, -1);
  for (const d of policy.sensitiveDirs) {
    if (dirs.includes(d)) return `sensitive:${d}/`;
  }
  if (policy.sensitiveBasenames.includes(base)) return `sensitive:${base}`;
  for (const p of policy.sensitiveBasenamePrefixes) {
    if (base.startsWith(p)) return `sensitive:${p}*`;
  }
  for (const e of policy.sensitiveExtensions) {
    if (base.endsWith(e)) return `sensitive:*${e}`;
  }
  return undefined;
}

/**
 * Verdict for `access` to `relpath` (workspace-relative). Order: sensitive rules (both accesses),
 * then protected directories (write only). The first denying rule wins.
 */
export function evaluatePathAccess(
  policy: PathAccessPolicy,
  access: PathAccess,
  relpath: string,
): PathAccessVerdict {
  const segments = normalizeSegments(relpath);
  const sensitive = sensitiveRule(policy, segments);
  if (sensitive !== undefined) {
    return { allowed: false, code: 'SENSITIVE_PATH', rule: sensitive };
  }
  if (access === 'write') {
    for (const d of policy.protectedDirs) {
      if (segments.includes(d)) return { allowed: false, code: 'PROTECTED_PATH', rule: `protected:${d}` };
    }
  }
  return { allowed: true };
}

// ── Test-like paths (shared by the test baseline and the risk classifier) ──────────────────────

export const TEST_LIKE_DIR_SEGMENTS: readonly string[] = Object.freeze(['test', 'tests', '__tests__', 'spec']);

/** Basename `test.*`, `*.test.*`, `*.spec.*`, `test_*`, `*_test.*`, or a directory in TEST_LIKE_DIR_SEGMENTS. */
export function isTestLikePath(relpath: string): boolean {
  const segments = normalizeSegments(relpath);
  const base = segments[segments.length - 1];
  if (base === undefined) return false;
  if (segments.slice(0, -1).some((s) => TEST_LIKE_DIR_SEGMENTS.includes(s))) return true;
  return (
    base.startsWith('test.') ||
    base.startsWith('test_') ||
    base.includes('.test.') ||
    base.includes('.spec.') ||
    base.includes('_test.')
  );
}
