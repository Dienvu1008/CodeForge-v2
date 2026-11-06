/*
 * Copyright 2026 DienVu (Dienvu1008)
 * SPDX-License-Identifier: Apache-2.0
 */

// kernel-gap-closure task 1.4 — TEST-FIRST against design C3/C4.
// `resolveToolRiskClass`, `TestBaseline`, `RiskContext` (tool/risk-classification.ts, task 3.3) and the
// v2 `buildToolPolicy` (task 3.4) do not exist yet: this spec is EXPECTED TO FAIL until then.

import { describe, it, expect } from 'vitest';
import {
  buildToolPolicy,
  determineAction,
  resolveToolRiskClass,
  type AutonomyLevel,
  type RiskClass,
  type RiskContext,
  type TestBaseline,
} from '@codeforge/agent-core';
import { bool, forAll, int, pathOf, pick, pathSegment, type Rng } from './gap-closure-generators.js';

const RUNS = 150;
const LEVELS: readonly AutonomyLevel[] = ['full', 'edits', 'readonly'];

function baselineOf(paths: Iterable<string>): TestBaseline {
  const set = new Set(paths);
  return { isBaselineTest: (p: string) => set.has(p) };
}

// ── Property 6 ────────────────────────────────────────────────────────────────────────────────
describe('Property 6: DESTRUCTIVE and NETWORK always require approval', () => {
  // Feature: kernel-gap-closure, Property 6: DESTRUCTIVE and NETWORK always require approval
  // **Validates: Requirements 2.7, 4.4, 4.5**
  it('requires approval for DESTRUCTIVE and NETWORK at every level for arbitrary tool names', () => {
    forAll(0x6001, RUNS, (rng) => {
      const level = pick(rng, LEVELS);
      const toolName = bool(rng, 0.2) ? '*' : pathSegment(rng, 12) + (bool(rng) ? '_file' : '');
      const policy = buildToolPolicy(level);
      expect(determineAction(toolName, 'DESTRUCTIVE', policy)).toBe('require_approval');
      expect(determineAction(toolName, 'NETWORK', policy)).toBe('require_approval');
    });
  });

  it('carries policyId autonomy-<level>-v2 and version 2 at every level', () => {
    for (const level of LEVELS) {
      const policy = buildToolPolicy(level);
      expect(policy.policyId).toBe(`autonomy-${level}-v2`);
      expect(policy.version).toBe(2);
    }
  });

  it('keeps PACKAGE_INSTALL and SYSTEM actions unchanged (allow under full, ask otherwise)', () => {
    forAll(0x6002, RUNS, (rng) => {
      const level = pick(rng, LEVELS);
      const toolName = pathSegment(rng, 10);
      const expected = level === 'full' ? 'allow' : 'require_approval';
      for (const risk of ['PACKAGE_INSTALL', 'SYSTEM'] as const) {
        expect(determineAction(toolName, risk, buildToolPolicy(level))).toBe(expected);
      }
    });
  });
});

// ── Property 14 ───────────────────────────────────────────────────────────────────────────────

const TEST_DIRS = ['test', 'tests', '__tests__', 'spec'];
const TEST_NAMES = ['a.test.ts', 'b.spec.js', 'test_c.py', 'd_test.go', 'test.js'];

function testLikePath(rng: Rng): string {
  return bool(rng, 0.5)
    ? `${pick(rng, TEST_DIRS)}/${pathSegment(rng)}.ts`
    : `${bool(rng) ? `${pathOf(rng, '/', int(rng, 0, 2))}/` : ''}${pick(rng, TEST_NAMES)}`.replace(/^\//, '');
}

function ordinaryPath(rng: Rng): string {
  return `src/${pathOf(rng, '/', int(rng, 1, 2))}.ts`;
}

/** Independent reference model of the C3 table (does not call the production code). */
const MUTATORS = ['mv', 'move', 'cp', 'copy', 'tee', 'dd', 'touch'];
function referenceClass(
  tool: string,
  args: { path?: string; to?: string; command?: string; argv?: string[] },
  inBaseline: (p: string) => boolean,
): RiskClass {
  switch (tool) {
    case 'write_file':
    case 'edit_file':
      return args.path !== undefined && inBaseline(args.path) ? 'DESTRUCTIVE' : 'MODIFY_WORKSPACE';
    case 'delete_file':
      return 'DESTRUCTIVE';
    case 'move_file':
      return (args.path !== undefined && inBaseline(args.path)) ||
        (args.to !== undefined && inBaseline(args.to))
        ? 'DESTRUCTIVE'
        : 'SYSTEM';
    case 'run_command': {
      const name = args.command as string;
      if (name === 'dd') return 'DESTRUCTIVE'; // dd is DESTRUCTIVE by name (Req 2.1)
      const hit = MUTATORS.includes(name) && (args.argv ?? []).some((a) => inBaseline(a));
      return hit ? 'DESTRUCTIVE' : 'SYSTEM';
    }
    default:
      return 'SYSTEM';
  }
}

interface Case {
  readonly tool: string;
  readonly toolArgs: Record<string, unknown>;
  readonly ref: Parameters<typeof referenceClass>[1];
}

function genCase(rng: Rng, pool: readonly string[]): Case {
  const anyPath = (): string => (pool.length > 0 && bool(rng, 0.6) ? pick(rng, pool) : bool(rng) ? testLikePath(rng) : ordinaryPath(rng));
  const tool = pick(rng, ['write_file', 'edit_file', 'delete_file', 'move_file', 'run_command']);
  if (tool === 'move_file') {
    const path = anyPath();
    const to = anyPath();
    return { tool, toolArgs: { path, to }, ref: { path, to } };
  }
  if (tool === 'run_command') {
    const command = pick(rng, [...MUTATORS, 'cat', 'ls', 'node']);
    const argv: string[] = [];
    if (bool(rng, 0.3)) argv.push('-f');
    const n = int(rng, 1, 2);
    for (let i = 0; i < n; i++) argv.push(anyPath());
    return { tool, toolArgs: { command, args: argv }, ref: { command, argv } };
  }
  const path = anyPath();
  return { tool, toolArgs: { path, content: 'x' }, ref: { path } };
}

describe('Property 14: Risk class follows the test-baseline reference model', () => {
  // Feature: kernel-gap-closure, Property 14: Risk class follows the test-baseline reference model
  // **Validates: Requirements 9.2, 9.3, 9.4, 9.5**
  it('matches the reference model for any baseline, tool and target', () => {
    forAll(0x1401, RUNS, (rng) => {
      const baselinePaths: string[] = [];
      const count = int(rng, 0, 6);
      for (let i = 0; i < count; i++) baselinePaths.push(testLikePath(rng));
      const baseline = baselineOf(baselinePaths);
      const c = genCase(rng, baselinePaths);
      const actual = resolveToolRiskClass(c.tool, c.toolArgs, { testBaseline: baseline });
      expect(actual).toBe(referenceClass(c.tool, c.ref, (p) => baseline.isBaselineTest(p)));
    });
  });

  it('keeps a write_file to a test-like path outside the baseline MODIFY_WORKSPACE', () => {
    forAll(0x1402, RUNS, (rng) => {
      const baselinePaths = [testLikePath(rng), testLikePath(rng)];
      let fresh = testLikePath(rng);
      while (baselinePaths.includes(fresh)) fresh = `${fresh}.new`;
      const ctx: RiskContext = { testBaseline: baselineOf(baselinePaths) };
      expect(resolveToolRiskClass('write_file', { path: fresh, content: '' }, ctx)).toBe('MODIFY_WORKSPACE');
    });
  });

  it('treats a missing baseline exactly like an empty baseline', () => {
    forAll(0x1403, RUNS, (rng) => {
      const c = genCase(rng, []);
      const none = resolveToolRiskClass(c.tool, c.toolArgs);
      expect(resolveToolRiskClass(c.tool, c.toolArgs, {})).toBe(none);
      expect(resolveToolRiskClass(c.tool, c.toolArgs, { testBaseline: baselineOf([]) })).toBe(none);
      expect(none).toBe(referenceClass(c.tool, c.ref, () => false));
    });
  });
});

// ── Property 16 (risk part) ───────────────────────────────────────────────────────────────────
describe('Property 16 (risk part): resolveToolRiskClass is deterministic', () => {
  // Feature: kernel-gap-closure, Property 16: Classification and access functions are deterministic
  // **Validates: Requirements 10.2**
  it('returns the same class on repeated calls', () => {
    forAll(0x1601, RUNS, (rng) => {
      const pool = [testLikePath(rng), testLikePath(rng)];
      const c = genCase(rng, pool);
      const ctx: RiskContext | undefined = bool(rng) ? { testBaseline: baselineOf(pool) } : undefined;
      const first = resolveToolRiskClass(c.tool, c.toolArgs, ctx);
      const second = resolveToolRiskClass(c.tool, c.toolArgs, ctx);
      expect(second).toEqual(first);
    });
  });
});

// ── Examples ──────────────────────────────────────────────────────────────────────────────────
describe('resolveToolRiskClass examples (design C3 table)', () => {
  const table: ReadonlyArray<readonly [string, Record<string, unknown>, RiskClass]> = [
    ['read_file', { path: 'a.ts' }, 'READ_ONLY'],
    ['list_dir', { path: '.' }, 'READ_ONLY'],
    ['grep', { pattern: 'x' }, 'READ_ONLY'],
    ['glob', { pattern: '*.ts' }, 'READ_ONLY'],
    ['git_status', {}, 'READ_ONLY'],
    ['git_diff', {}, 'READ_ONLY'],
    ['git_log', {}, 'READ_ONLY'],
    ['write_file', { path: 'src/a.ts', content: '' }, 'MODIFY_WORKSPACE'],
    ['edit_file', { path: 'src/a.ts' }, 'MODIFY_WORKSPACE'],
    ['git_add', { paths: ['a.ts'] }, 'MODIFY_WORKSPACE'],
    ['git_commit', { message: 'm' }, 'MODIFY_WORKSPACE'],
    ['delete_file', { path: 'src/a.ts' }, 'DESTRUCTIVE'],
    ['move_file', { path: 'src/a.ts', to: 'src/b.ts' }, 'SYSTEM'],
    ['some_unknown_tool', { path: 'x' }, 'SYSTEM'],
  ];

  for (const [tool, args, expected] of table) {
    it(`${tool} -> ${expected}`, () => {
      expect(resolveToolRiskClass(tool, args)).toBe(expected);
    });
  }

  it('run_command with args that is not an array does not throw', () => {
    for (const bad of ['rm -rf dist', 42, null, undefined, { a: 1 }, true]) {
      expect(() => resolveToolRiskClass('run_command', { command: 'ls', args: bad })).not.toThrow();
    }
    expect(() => resolveToolRiskClass('run_command', {})).not.toThrow();
  });

  it('run_command rm -rf dist is DESTRUCTIVE', () => {
    expect(resolveToolRiskClass('run_command', { command: 'rm', args: ['-rf', 'dist'] })).toBe('DESTRUCTIVE');
  });

  it('run_command curl is NETWORK', () => {
    expect(resolveToolRiskClass('run_command', { command: 'curl', args: ['https://example.com'] })).toBe('NETWORK');
  });

  it('run_command npm test stays SYSTEM', () => {
    expect(resolveToolRiskClass('run_command', { command: 'npm', args: ['test'] })).toBe('SYSTEM');
  });
});
