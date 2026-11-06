/*
 * Copyright 2026 DienVu (Dienvu1008)
 * SPDX-License-Identifier: Apache-2.0
 */

// kernel-gap-closure R6, R7, R10 — pure Path_Access_Policy (design C1, D-C / D-D;
// Properties 9, 10, 11 (pure part), 16 (policy part)).
//
// TEST-FIRST: `packages/agent-core/src/tool/path-access-policy.ts` does not exist yet (task 3.1),
// so this file fails to load until then.
//
// The reference rules below are literal lists written independently of the production code.
//
// Validates: Requirements 6.1, 6.3, 6.4, 6.5, 6.9, 7.1, 7.2, 7.3, 10.2
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_PATH_ACCESS_POLICY,
  OPEN_PATH_ACCESS_POLICY,
  evaluatePathAccess,
  isTestLikePath,
  normalizeSegments,
  TEST_LIKE_DIR_SEGMENTS,
  type PathAccess,
} from '@codeforge/agent-core';
import { bool, forAll, int, pick, randomCase, type Rng } from './gap-closure-generators.js';

const RUNS = 150;
const ACCESSES: readonly PathAccess[] = ['read', 'write'];

// ── independent reference for the sensitive rules (operates on clean lowercase segments) ─────
function refSensitive(segments: readonly string[]): boolean {
  const base = segments[segments.length - 1] ?? '';
  const dirs = segments.slice(0, -1);
  if (['.env.example', '.env.sample', '.env.template'].includes(base)) return false;
  if (base.endsWith('.pub')) return false;
  if (dirs.includes('.ssh')) return true;
  if (['.env', '.npmrc', '.pypirc', '.netrc', 'credentials'].includes(base)) return true;
  for (const p of ['.env.', 'id_rsa', 'id_ed25519', 'id_ecdsa', 'id_dsa']) {
    if (base.startsWith(p)) return true;
  }
  for (const e of ['.pem', '.key', '.p12', '.pfx']) {
    if (base.endsWith(e)) return true;
  }
  return false;
}

// ── generators ───────────────────────────────────────────────────────────────────────────────
const SAFE_DIRS = ['src', 'config', 'certs', 'lib', 'a', 'deploy', 'secrets', '.github', 'workflows', 'my.dir'];
const BASENAMES = [
  // sensitive
  '.env', '.env.local', '.env.production', '.env.x', 'server.pem', 'server.key', 'a.p12', 'b.pfx',
  'id_rsa', 'id_rsa_backup', 'id_ed25519', 'id_ecdsa', 'id_dsa', '.npmrc', '.pypirc', '.netrc',
  'credentials',
  // not sensitive
  '.env.example', '.env.sample', '.env.template', 'id_rsa.pub', 'id_ed25519.pub', 'server.pem.pub',
  'environment.ts', 'env.js', 'env.d.ts', 'monkey.pem.md', 'credentials.ts', 'keyboard.ts', 'key.ts',
  'ci.yml', 'README.md', 'pem', 'key', '.envrc', 'mykey', 'credential',
];

function cleanSegments(rng: Rng): string[] {
  const depth = int(rng, 0, 3);
  const out: string[] = [];
  for (let i = 0; i < depth; i++) out.push(bool(rng, 0.15) ? '.ssh' : pick(rng, SAFE_DIRS));
  out.push(pick(rng, BASENAMES));
  return out;
}

/** Decorates one segment: case, trailing dots/spaces, NTFS stream suffix. */
function decorate(rng: Rng, seg: string): string {
  let s = bool(rng) ? randomCase(rng, seg) : seg;
  if (bool(rng, 0.3)) s += '.'.repeat(int(rng, 1, 3));
  if (bool(rng, 0.2)) s += ' '.repeat(int(rng, 1, 2));
  if (bool(rng, 0.2)) s += ':$DATA';
  else if (bool(rng, 0.1)) s += ':stream';
  return s;
}

function join(rng: Rng, segs: readonly string[]): string {
  const sep = (): string => (bool(rng) ? '/' : '\\');
  let out = '';
  segs.forEach((s, i) => {
    out += i === 0 ? s : sep() + s;
  });
  return out;
}

const deny = (p: string, access: PathAccess = 'read') =>
  evaluatePathAccess(DEFAULT_PATH_ACCESS_POLICY, access, p);

describe('Path_Access_Policy — sensitive paths', () => {
  it(
    // Feature: kernel-gap-closure, Property 9: Sensitive-path verdicts match the reference list
    'Property 9: Sensitive-path verdicts match the reference list',
    () => {
      forAll(9001, RUNS, (rng) => {
        const clean = cleanSegments(rng);
        const path = join(rng, clean.map((s) => decorate(rng, s)));
        const expected = refSensitive(clean.map((s) => s.toLowerCase()));
        for (const access of ACCESSES) {
          const v = deny(path, access);
          if (expected) {
            expect(v.allowed, `${JSON.stringify(path)} ${access}`).toBe(false);
            if (!v.allowed) expect(v.code).toBe('SENSITIVE_PATH');
          } else {
            expect(v.allowed, `${JSON.stringify(path)} ${access}`).toBe(true);
          }
        }
      });
    },
  );

  it('flags the positive example list for read and write', () => {
    const positives = [
      '.env', '.env.local', 'config/.env.local', 'server.pem', 'certs\\server.KEY', 'id_rsa',
      '.ssh/known_hosts', '.aws/credentials', '.npmrc', '.env.', '.ENV', 'a/b/.ENV.Production',
      'id_ed25519', 'x.p12', 'y.pfx', '.pypirc', '.netrc', '.env:stream',
    ];
    for (const p of positives) {
      for (const access of ACCESSES) {
        const v = deny(p, access);
        expect(v.allowed, `${p} ${access}`).toBe(false);
        if (!v.allowed) {
          expect(v.code).toBe('SENSITIVE_PATH');
          expect(v.rule.length).toBeGreaterThan(0);
        }
      }
    }
  });

  it('allows the negative example list', () => {
    const negatives = [
      '.env.example', '.env.sample', '.env.template', 'environment.ts', 'src/env.js', 'env.d.ts',
      'monkey.pem.md', 'credentials.ts', 'keyboard.ts', 'id_rsa.pub', '.ssh/id_rsa.pub',
      '.github/workflows/ci.yml', 'README.md', '',
    ];
    for (const p of negatives) {
      for (const access of ACCESSES) expect(deny(p, access).allowed, `${p} ${access}`).toBe(true);
    }
  });

  it('OPEN_PATH_ACCESS_POLICY allows everything', () => {
    for (const p of ['.env', 'server.pem', '.ssh/id_rsa', '.git/config', 'a/.git/HEAD']) {
      for (const access of ACCESSES) {
        expect(evaluatePathAccess(OPEN_PATH_ACCESS_POLICY, access, p)).toEqual({ allowed: true });
      }
    }
  });
});

describe('Path_Access_Policy — normalisation', () => {
  it('normalizeSegments lowercases, drops ".", resolves "..", strips streams and trailing dots/spaces', () => {
    expect(normalizeSegments('.\\A//B/./C.. /.ENV:stream')).toEqual(['a', 'b', 'c', '.env']);
    expect(normalizeSegments('a/b/../c')).toEqual(['a', 'c']);
  });

  it(
    // Feature: kernel-gap-closure, Property 10: Verdicts are invariant under path normalisation
    'Property 10: Verdicts are invariant under path normalisation',
    () => {
      forAll(1001, RUNS, (rng) => {
        const clean = cleanSegments(rng);
        if (bool(rng, 0.3)) clean.unshift(pick(rng, ['.git', '.hg', '.svn']));
        const original = clean.join('/');

        const rewrites: string[] = [
          randomCase(rng, original),
          original.replace(/\//g, '\\'),
          `./${original}`,
          original.replace(/\//g, '//'),
          clean.map((s) => s + '.'.repeat(int(rng, 1, 3)) + ' '.repeat(int(rng, 0, 2))).join('/'),
        ];
        for (const access of ACCESSES) {
          const base = deny(original, access);
          for (const rw of rewrites) {
            const v = deny(rw, access);
            expect(v.allowed, `${JSON.stringify(rw)} vs ${original} (${access})`).toBe(base.allowed);
            if (!base.allowed && !v.allowed) expect(v.code).toBe(base.code);
          }
        }
      });
    },
  );
});

describe('Path_Access_Policy — protected VCS metadata', () => {
  const NEVER_PROTECTED = ['.github', '.gitignore', '.gitattributes', '.gitmodules', '.gitkeep', '.gitlab-ci.yml'];

  it(
    // Feature: kernel-gap-closure, Property 11: Protected VCS metadata is write-protected and read-open
    'Property 11 (pure part): Protected VCS metadata is write-protected and read-open',
    () => {
      forAll(1101, RUNS, (rng) => {
        const vcs = pick(rng, ['.git', '.hg', '.svn']);
        const before = Array.from({ length: int(rng, 0, 3) }, () => pick(rng, ['src', 'a', 'lib', 'sub']));
        const after = Array.from({ length: int(rng, 0, 3) }, () => pick(rng, ['objects', 'hooks', 'x.txt', 'config']));
        const path = join(rng, [...before, decorate(rng, vcs), ...after]);
        // keep the tail from being sensitive so the code under test is unambiguous
        expect(deny(path, 'read').allowed, `${path} read`).toBe(true);
        const w = deny(path, 'write');
        expect(w.allowed, `${path} write`).toBe(false);
        if (!w.allowed) expect(w.code).toBe('PROTECTED_PATH');

        const safe = join(rng, [...before, pick(rng, NEVER_PROTECTED), ...(bool(rng) ? ['x.yml'] : [])]);
        for (const access of ACCESSES) expect(deny(safe, access).allowed, `${safe} ${access}`).toBe(true);
      });
    },
  );

  it('examples: .git/HEAD, a/.hg/store, .svn write-protected; read open; look-alikes never protected', () => {
    for (const p of ['.git/HEAD', 'a/.hg/store', '.svn/entries', 'x\\.GIT\\config', '.git']) {
      expect(deny(p, 'read').allowed, p).toBe(true);
      const w = deny(p, 'write');
      expect(w.allowed, p).toBe(false);
      if (!w.allowed) expect(w.code).toBe('PROTECTED_PATH');
    }
    for (const p of ['.github/workflows/ci.yml', '.gitignore', '.gitattributes', '.gitmodules', '.gitkeep', '.gitlab-ci.yml']) {
      for (const access of ACCESSES) expect(deny(p, access).allowed, `${p} ${access}`).toBe(true);
    }
  });
});

describe('Path_Access_Policy — test-like paths', () => {
  it('TEST_LIKE_DIR_SEGMENTS lists the four directory names', () => {
    expect([...TEST_LIKE_DIR_SEGMENTS].sort()).toEqual(['__tests__', 'spec', 'test', 'tests']);
  });

  it('isTestLikePath table', () => {
    for (const p of ['test.js', 'a.test.ts', 'b.spec.js', 'test_x.py', 'x_test.go', 'tests/a.js', 'src/__tests__/a.js', 'spec/a.rb']) {
      expect(isTestLikePath(p), p).toBe(true);
    }
    for (const p of ['latest.js', 'contest.ts', 'src/protest/a.js']) {
      expect(isTestLikePath(p), p).toBe(false);
    }
  });
});

describe('Path_Access_Policy — determinism', () => {
  it(
    // Feature: kernel-gap-closure, Property 16: Classification and access functions are deterministic
    'Property 16 (policy part): evaluatePathAccess, normalizeSegments and isTestLikePath are deterministic',
    () => {
      forAll(1601, RUNS, (rng) => {
        const clean = cleanSegments(rng);
        if (bool(rng, 0.3)) clean.unshift(pick(rng, ['.git', 'tests', 'src']));
        const path = join(rng, clean.map((s) => decorate(rng, s)));
        for (const access of ACCESSES) {
          expect(deny(path, access)).toEqual(deny(path, access));
        }
        expect(normalizeSegments(path)).toEqual(normalizeSegments(path));
        expect(isTestLikePath(path)).toBe(isTestLikePath(path));
      });
    },
  );
});
