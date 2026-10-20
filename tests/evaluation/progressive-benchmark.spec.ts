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

  it('covers multiple languages (not just JS/TS) via the PG-D/R/G families', () => {
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = result.value.tasks.map((t) => t.id);
    // Dart, Rust and Go families added in P12.26 (Lát 3).
    expect(ids.some((id) => id.startsWith('PG-D'))).toBe(true);
    expect(ids.some((id) => id.startsWith('PG-R'))).toBe(true);
    expect(ids.some((id) => id.startsWith('PG-G'))).toBe(true);
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
    for (const prefix of ['PG-D', 'PG-R', 'PG-G']) {
      const ranks = result.value.tasks
        .filter((t) => t.id.startsWith(prefix))
        .map((t) => RANK[t.difficulty]);
      for (let i = 1; i < ranks.length; i++) {
        expect(ranks[i], `${prefix} family must be non-decreasing in difficulty`).toBeGreaterThanOrEqual(ranks[i - 1]!);
      }
    }
  });
});
