// Feature: session-resume, Property 1: Phân loại toàn phần và đúng lý do
// Feature: session-resume, Property 2: Tối đa một resume
/*
 * Copyright 2026 DienVu (Dienvu1008)
 * SPDX-License-Identifier: Apache-2.0
 */

// Startup recovery — pure orphan classification (classifyOrphan / planRecovery).
// **Validates: Requirements 2.3, 3.2, 4.2, 7.2**
import { describe, it, expect } from 'vitest';
import {
  classifyOrphan,
  planRecovery,
  SUPERSEDED_REASON,
  buildClarificationRequest,
  type OrphanSnapshot,
  type SessionState,
} from '@codeforge/agent-core';
// Tiny seeded PRNG (tests/session is type-checked by tests/tsconfig; keep it self-contained).
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
const int = (rng: Rng, min: number, max: number): number => min + Math.floor(rng() * (max - min + 1));
const bool = (rng: Rng, p = 0.5): boolean => rng() < p;
const pick = <T>(rng: Rng, xs: readonly T[]): T => xs[int(rng, 0, xs.length - 1)] as T;
function forAll(seed: number, runs: number, body: (rng: Rng, i: number) => void): void {
  const rng = mulberry32(seed);
  for (let i = 0; i < runs; i++) {
    try { body(rng, i); } catch (err) {
      throw new Error(`property failed at iteration ${i} (seed ${seed}): ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }
  }
}

/** The snapshot without an open clarification (exactOptionalPropertyTypes-safe). */
function withoutClarification(o: OrphanSnapshot): OrphanSnapshot {
  const { openClarification: _drop, ...rest } = o;
  return rest;
}

const STATES: readonly SessionState[] = ['CREATED', 'INITIALIZING', 'RUNNING', 'AWAITING_HUMAN', 'PAUSED', 'CANCELLING'];
const REQUEST = buildClarificationRequest('REQ', 'M', 'G', ['What is the input?']);

function snap(over: Partial<OrphanSnapshot> & { state?: SessionState; createdAt?: string; sessionId?: string } = {}): OrphanSnapshot {
  const { state = 'AWAITING_HUMAN', createdAt = '2026-01-01T00:00:00.000Z', sessionId = 'S', ...rest } = over;
  return {
    session: {
      sessionId, state, createdAt,
      metadata: { hostname: 'h', processId: 42, ollamaEndpoint: 'e', ollamaModels: { planner: 'p', critic: 'c', executor: 'e', analyzer: 'a' } },
    },
    openClarification: { missionId: 'M', request: REQUEST },
    graphIsSeedOnly: true,
    goalPersisted: true,
    pendingToolApproval: false,
    ...rest,
  };
}

function genSnapshot(rng: Rng, i: number): OrphanSnapshot {
  const s = snap({
    sessionId: `S-${i}`,
    state: bool(rng, 0.6) ? 'AWAITING_HUMAN' : pick(rng, STATES),
    createdAt: `2026-01-${String(int(rng, 1, 28)).padStart(2, '0')}T00:00:${String(int(rng, 0, 59)).padStart(2, '0')}.000Z`,
    graphIsSeedOnly: bool(rng, 0.8),
    goalPersisted: bool(rng, 0.8),
    pendingToolApproval: bool(rng, 0.15),
  });
  return bool(rng, 0.8) ? s : withoutClarification(s);
}

/** Reference: the first violated condition in the design C4 order. */
function expectedReason(o: OrphanSnapshot, clarifyEnabled: boolean): string | null {
  if (o.session.state !== 'AWAITING_HUMAN') return 'state';
  if (o.pendingToolApproval) return 'runtime restarted while awaiting tool approval';
  if (o.openClarification === undefined) return 'runtime restarted while awaiting a human decision';
  if (!o.graphIsSeedOnly) return 'runtime restarted after planning had started';
  if (!o.goalPersisted) return 'goal was not persisted (session predates resume support)';
  if (!clarifyEnabled) return 'clarification gate is disabled on this runtime (--clarify off)';
  return null;
}

describe('Property 1: classifyOrphan is total and picks the first violated reason', () => {
  it('resume iff every condition holds; otherwise the first failing reason', () => {
    forAll(0x5e5e01, 400, (rng, i) => {
      const o = genSnapshot(rng, i);
      const clarifyEnabled = bool(rng, 0.7);
      const d = classifyOrphan(o, { clarifyEnabled });
      const exp = expectedReason(o, clarifyEnabled);
      if (exp === null) {
        expect(d).toEqual({ kind: 'resume' });
      } else {
        expect(d.kind).toBe('abort');
        if (d.kind !== 'abort') return;
        if (exp === 'state') expect(d.reason).toMatch(/^runtime restarted (during|while)/);
        else expect(d.reason).toBe(exp);
      }
    });
  });
});

describe('Property 2: planRecovery resumes at most one (the newest resumable)', () => {
  it('one decision per snapshot, ≤ 1 resume, and it is the newest resumable one', () => {
    forAll(0x5e5e02, 300, (rng) => {
      const n = int(rng, 0, 6);
      const orphans = Array.from({ length: n }, (_, i) => genSnapshot(rng, i));
      const opts = { clarifyEnabled: bool(rng, 0.8) };
      const plan = planRecovery(orphans, opts);

      expect(plan).toHaveLength(n);
      plan.forEach((p, i) => expect(p.snapshot).toBe(orphans[i]));
      const resumes = plan.filter((p) => p.decision.kind === 'resume');
      expect(resumes.length).toBeLessThanOrEqual(1);

      const resumable = orphans.filter((o) => classifyOrphan(o, opts).kind === 'resume');
      if (resumable.length === 0) {
        expect(resumes).toHaveLength(0);
      } else {
        expect(resumes).toHaveLength(1);
        const newest = resumable.reduce((a, b) => (b.session.createdAt >= a.session.createdAt ? b : a));
        expect(resumes[0]!.snapshot.session.createdAt).toBe(newest.session.createdAt);
        // Every other resumable one is demoted with the superseded reason.
        for (const p of plan) {
          if (p.decision.kind === 'abort' && classifyOrphan(p.snapshot, opts).kind === 'resume') {
            expect(p.decision.reason).toBe(SUPERSEDED_REASON);
          }
        }
      }
    });
  });
});

describe('classifyOrphan — one example per design C4 row', () => {
  const on = { clarifyEnabled: true };
  it.each([
    ['RUNNING', snap({ state: 'RUNNING' }), 'runtime restarted during execution'],
    ['PAUSED', snap({ state: 'PAUSED' }), 'runtime restarted while paused'],
    ['CANCELLING', snap({ state: 'CANCELLING' }), 'runtime restarted while cancelling'],
    ['INITIALIZING', snap({ state: 'INITIALIZING' }), 'runtime restarted while the session was starting'],
    ['tool approval', snap({ pendingToolApproval: true }), 'runtime restarted while awaiting tool approval'],
    ['no open clarification', withoutClarification(snap()), 'runtime restarted while awaiting a human decision'],
    ['planning started', snap({ graphIsSeedOnly: false }), 'runtime restarted after planning had started'],
    ['goal not persisted', snap({ goalPersisted: false }), 'goal was not persisted (session predates resume support)'],
  ] as const)('%s → abort', (_label, o, reason) => {
    expect(classifyOrphan(o, on)).toEqual({ kind: 'abort', reason });
  });
  it('--clarify off → abort', () => {
    expect(classifyOrphan(snap(), { clarifyEnabled: false })).toEqual({
      kind: 'abort', reason: 'clarification gate is disabled on this runtime (--clarify off)',
    });
  });
  it('all conditions hold → resume', () => {
    expect(classifyOrphan(snap(), on)).toEqual({ kind: 'resume' });
  });
});