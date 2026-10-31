// Feature: plan-options, Property 3: Tối đa một lựa chọn được chấp nhận
/*
 * Copyright 2026 DienVu (Dienvu1008)
 * SPDX-License-Identifier: Apache-2.0
 */

// PlanChoiceCoordinator — at-most-once acceptance + session transitions (shared HumanDecisionWaiter).
// **Validates: Requirements 4.2, 4.5, 4.6, 5.8, 5.9**
import { describe, it, expect } from 'vitest';
import { PlanChoiceCoordinator } from '@codeforge/infrastructure';
import { buildPlanOptionsRequest, validatePlanChoice, type PlanOption } from '@codeforge/agent-core';
import { mulberry32, int, bool, pick } from '../mission/clarification-generators.js';

const OPTIONS: readonly PlanOption[] = [
  { id: 'o1', title: 'A', summary: 'a', pros: ['p'], cons: ['c'], recommended: false },
  { id: 'o2', title: 'B', summary: 'b', pros: ['p'], cons: ['c'], recommended: true },
  { id: 'o3', title: 'C', summary: 'c', pros: ['p'], cons: ['c'], recommended: false },
];
const REQ = buildPlanOptionsRequest('R', 'M', 'G', OPTIONS);

function harness(opts: { maxWaitMs?: number; advancePerSleep?: number; initial?: string } = {}) {
  const calls: { ev: string; ctx?: Record<string, unknown> }[] = [];
  const reader = { state: opts.initial ?? 'AWAITING_HUMAN', getById: async () => ({ state: reader.state }) };
  const clock = { now: 0, sleeps: 0 };
  const coord = new PlanChoiceCoordinator({
    sessionService: { transition: async (_id: string, ev: string, ctx?: Record<string, unknown>) => { calls.push({ ev, ...(ctx ? { ctx } : {}) }); return undefined; } },
    sessions: reader,
    pollIntervalMs: 1,
    maxWaitMs: opts.maxWaitMs ?? Number.MAX_SAFE_INTEGER,
    nowMs: () => clock.now,
    sleep: () => { clock.sleeps++; clock.now += opts.advancePerSleep ?? 0; return new Promise((r) => setImmediate(r)); },
  });
  return { coord, calls, reader, clock };
}

const genBody = (rng: () => number): unknown => {
  const r = rng();
  if (r < 0.15) return { useRecommended: true };
  if (r < 0.45) return { optionId: pick(rng, ['o1', 'o2', 'o3']) };
  return pick<unknown>(rng, [{}, null, { optionId: 'o9' }, { optionId: 7 }, { useRecommended: 'yes' }, 'o1', { optionId: '' }]);
};

describe('Property 3: at most one accepted choice per request', () => {
  it('only the first valid submit is accepted; earlier invalid ones keep the request; later ones get NOT_AWAITING', async () => {
    const rng = mulberry32(0x91075);
    for (let iter = 0; iter < 150; iter++) {
      const { coord, reader } = harness();
      const bodies = Array.from({ length: int(rng, 1, 15) }, () => genBody(rng));
      const waiting = coord.awaitChoice('S', REQ);
      const results = bodies.map((b) => coord.submit('S', b));
      const firstValid = bodies.findIndex((b) => validatePlanChoice(REQ, b).ok);
      results.forEach((res, k) => {
        if (firstValid === -1 || k < firstValid) {
          expect(res.ok).toBe(false);
          if (!res.ok) expect(res.code).toBe((validatePlanChoice(REQ, bodies[k]) as { code: string }).code);
        } else if (k === firstValid) {
          const v = validatePlanChoice(REQ, bodies[k]) as { optionId: string; source: string };
          expect(res).toEqual({ ok: true, requestId: 'R', optionId: v.optionId, source: v.source });
        } else {
          expect(res).toEqual({ ok: false, code: 'NOT_AWAITING', message: 'session not awaiting plan choice' });
        }
      });
      if (firstValid === -1) {
        reader.state = 'CANCELLING';
        await expect(waiting).resolves.toEqual({ kind: 'cancelled' });
      } else {
        const v = validatePlanChoice(REQ, bodies[firstValid]) as { optionId: string; source: 'user' | 'default' };
        await expect(waiting).resolves.toEqual({ kind: 'chosen', optionId: v.optionId, source: v.source });
      }
      if (bool(rng)) expect(coord.submit('S', { optionId: 'o1' }).ok).toBe(false);
    }
  });
});

describe('PlanChoiceCoordinator — transitions and timing', () => {
  it('HUMAN_REQUIRED before waiting, HUMAN_DECIDED {humanDecisionRecorded} after a choice', async () => {
    const { coord, calls } = harness();
    const waiting = coord.awaitChoice('S', REQ);
    expect(calls[0]).toEqual({ ev: 'HUMAN_REQUIRED' });
    expect(coord.submit('S', { optionId: 'o3' })).toEqual({ ok: true, requestId: 'R', optionId: 'o3', source: 'user' });
    await expect(waiting).resolves.toEqual({ kind: 'chosen', optionId: 'o3', source: 'user' });
    expect(calls).toEqual([{ ev: 'HUMAN_REQUIRED' }, { ev: 'HUMAN_DECIDED', ctx: { humanDecisionRecorded: true } }]);
  });

  it('times out after maxWaitMs and still resumes the session', async () => {
    const { coord, calls } = harness({ maxWaitMs: 1000, advancePerSleep: 600 });
    await expect(coord.awaitChoice('S', REQ)).resolves.toEqual({ kind: 'timeout' });
    expect(calls.at(-1)).toEqual({ ev: 'HUMAN_DECIDED', ctx: { humanDecisionRecorded: true } });
  });

  it('cancel ends the wait without HUMAN_DECIDED', async () => {
    const { coord, calls, reader } = harness();
    const waiting = coord.awaitChoice('S', REQ);
    await new Promise((r) => setImmediate(r));
    reader.state = 'CANCELLING';
    await expect(waiting).resolves.toEqual({ kind: 'cancelled' });
    expect(calls.map((c) => c.ev)).not.toContain('HUMAN_DECIDED');
  });

  it('a session already AWAITING_HUMAN (resume) keeps waiting when HUMAN_REQUIRED fails', async () => {
    const calls: string[] = [];
    const coord = new PlanChoiceCoordinator({
      sessionService: { transition: async (_id: string, ev: string) => { calls.push(ev); if (ev === 'HUMAN_REQUIRED') throw new Error('invalid'); return undefined; } },
      sessions: { getById: async () => ({ state: 'AWAITING_HUMAN' }) },
      pollIntervalMs: 1, sleep: () => new Promise((r) => setImmediate(r)),
    });
    const waiting = coord.awaitChoice('S', REQ);
    await new Promise((r) => setImmediate(r));
    expect(coord.submit('S', { useRecommended: true })).toEqual({ ok: true, requestId: 'R', optionId: 'o2', source: 'default' });
    await expect(waiting).resolves.toEqual({ kind: 'chosen', optionId: 'o2', source: 'default' });
    expect(calls).toEqual(['HUMAN_REQUIRED', 'HUMAN_DECIDED']);
  });

  it('no pending request → NOT_AWAITING (e.g. after a restart)', () => {
    expect(harness().coord.submit('S', { optionId: 'o1' })).toEqual({ ok: false, code: 'NOT_AWAITING', message: 'session not awaiting plan choice' });
  });
});