// Progressive benchmark dataset guard (Tier A). CI-safe: validates the difficulty-graded dataset
// loads, is well-formed, and is difficulty-ordered. It does NOT run a model (that is the manual
// scripts/run-progressive.mjs capability-curve tool) — this just stops the dataset from rotting.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateBenchmark, type BenchmarkDifficulty } from '@codeforge/agent-core';

const PATH = join(__dirname, '..', '..', 'benchmarks', 'codeforge-progressive', 'benchmark.json');
const RANK: Record<BenchmarkDifficulty, number> = { TRIVIAL: 0, EASY: 1, MEDIUM: 2, HARD: 3, EXPERT: 4 };

describe('codeforge-progressive dataset', () => {
  const raw = JSON.parse(readFileSync(PATH, 'utf8'));
  const result = validateBenchmark(raw);

  it('validates without errors', () => {
    if (!result.ok) console.log(JSON.stringify(result.errors, null, 2));
    expect(result.ok).toBe(true);
  });

  it('has at least 12 difficulty-graded tasks spanning TRIVIAL→EXPERT', () => {
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const tasks = result.value.tasks;
    expect(tasks.length).toBeGreaterThanOrEqual(12);
    const diffs = new Set(tasks.map((t) => t.difficulty));
    expect(diffs.has('TRIVIAL')).toBe(true);
    expect(diffs.has('HARD')).toBe(true);
    expect(diffs.has('EXPERT')).toBe(true);
  });

  it('covers multiple languages (not just JS/TS) via the per-language families', () => {
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = result.value.tasks.map((t) => t.id);
    // Dart/Rust/Go (P12.26) + Python/C++/MQL5 (P12.27).
    for (const prefix of ['PG-D', 'PG-R', 'PG-G', 'PG-P', 'PG-C', 'PG-M']) {
      expect(ids.some((id) => id.startsWith(prefix)), `${prefix} family present`).toBe(true);
    }
  });

  it('covers diverse categories including security, performance and documentation (P12.31)', () => {
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const cats = new Set(result.value.tasks.map((t) => t.category));
    expect(cats.has('SECURITY'), 'SECURITY category present').toBe(true);
    expect(cats.has('PERFORMANCE'), 'PERFORMANCE category present').toBe(true);
    expect(cats.has('DOCUMENTATION'), 'DOCUMENTATION category present').toBe(true);
    expect(cats.has('TESTING'), 'TESTING category present').toBe(true);
    expect(cats.has('ARCHITECTURE'), 'ARCHITECTURE category present').toBe(true);
  });

  it('every task has a deterministic command/build check (external verdict authority)', () => {
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const t of result.value.tasks) {
      const hasExec = t.verification.some((c) => c.kind === 'command' || c.kind === 'build' || c.kind === 'no_regression');
      expect(hasExec, `${t.id} must have a command/build check`).toBe(true);
    }
  });

  it('task ids are unique', () => {
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = result.value.tasks.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('the JS capability curve (PG-NN) is broadly ordered by non-decreasing difficulty', () => {
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The dataset now spans two axes: the original JS capability curve (PG-01..PG-12) AND
    // per-language families (PG-D/R/G) that each start easy. The "readable curve" invariant
    // applies to the JS family — assert ordering there, not across the whole mixed list.
    const ranks = result.value.tasks
      .filter((t) => /^PG-\d+$/.test(t.id))
      .map((t) => RANK[t.difficulty]);
    const half = Math.floor(ranks.length / 2);
    const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    expect(avg(ranks.slice(half))).toBeGreaterThan(avg(ranks.slice(0, half)));
  });

  it('each per-language family is itself ordered easy→harder', () => {
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Use exact patterns to avoid prefix collisions (e.g. PG-D matches PG-DEP1, PG-D1, PG-DOC1).
    const families: Array<{ label: string; pattern: RegExp }> = [
      { label: 'PG-D (Dart)',   pattern: /^PG-D\d+$/ },
      { label: 'PG-R (Rust)',   pattern: /^PG-R\d+$/ },
      { label: 'PG-G (Go)',     pattern: /^PG-G\d+$/ },
      { label: 'PG-P (Python)', pattern: /^PG-P\d+$/ },
      { label: 'PG-C (C++)',    pattern: /^PG-C\d+$/ },
      { label: 'PG-M (MQL5)',   pattern: /^PG-M\d+$/ },
      // PG-TS cases are all MEDIUM — trivially non-decreasing.
      { label: 'PG-TS (TS)',    pattern: /^PG-TS\d+$/ },
      // PG-Y is a flat thematic set (not a difficulty curve) — skip ordering for it.
    ];
    for (const { label, pattern } of families) {
      const ranks = result.value.tasks
        .filter((t) => pattern.test(t.id))
        .map((t) => RANK[t.difficulty]);
      for (let i = 1; i < ranks.length; i++) {
        expect(ranks[i], `${label} family must be non-decreasing in difficulty`).toBeGreaterThanOrEqual(ranks[i - 1]!);
      }
    }
  });
});
