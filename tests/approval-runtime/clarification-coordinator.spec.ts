// Feature: goal-clarification-gate, Property 5: Chấp nhận tối đa một lần cho mỗi request
/*
 * Copyright 2026 DienVu (Dienvu1008)
 * SPDX-License-Identifier: Apache-2.0
 */

// ClarificationCoordinator — at-most-once acceptance per pending request.
// Uses fakes only (no DB, no real clock): sleep resolves on setImmediate, nowMs never advances.
import { describe, it, expect } from 'vitest';
import { ClarificationCoordinator } from '@codeforge/infrastructure';
import {
  mergeClarificationAnswers,
  validateClarificationAnswers,
  type ClarificationAnswers,
} from '@codeforge/agent-core';
import {
  bool,
  genInvalidAnswers,
  genRequest,
  genValidAnswers,
  int,
  mulberry32,
  questionIds,
  type InvalidAnswersKind,
} from '../mission/clarification-generators.js';

interface FakeSessionPort {
  readonly calls: Array<{ id: string; ev: string; ctx?: Record<string, unknown> }>;
  transition(id: string, ev: string, ctx?: Record<string, unknown>): Promise<unknown>;
}

function fakeSessionPort(): FakeSessionPort {
  const calls: FakeSessionPort['calls'] = [];
  return {
    calls,
    transition: async (id, ev, ctx) => {
      calls.push({ id, ev, ...(ctx ? { ctx } : {}) });
      return undefined;
    },
  };
}

/** Sessions reader whose state can be flipped by the test. */
function fakeSessions(initial = 'AWAITING_HUMAN'): { state: string; getById: (id: string) => Promise<{ state: string }> } {
  const reader = {
    state: initial,
    getById: async () => ({ state: reader.state }),
  };
  return reader;
}

const immediateSleep = (): Promise<void> => new Promise((r) => setImmediate(r));

type Call =
  | { readonly valid: true; readonly raw: Record<string, string> }
  | { readonly valid: false; readonly raw: unknown; readonly kind: InvalidAnswersKind; readonly expectedCode: string };

describe('ClarificationCoordinator — Property 5: at most one accepted submission per request', () => {
  /** **Validates: Requirements 5.10, 6.1, 6.3** */
  it('accepts exactly the first valid submit; earlier invalid ones keep the request; later ones get NOT_AWAITING', async () => {
    const SEED = 0xc1a5;
    const RUNS = 150;
    const rng = mulberry32(SEED);
    let sawNoValid = 0;
    let sawValid = 0;

    for (let iter = 0; iter < RUNS; iter++) {
      try {
        const request = genRequest(rng);
        const ids = questionIds(request);
        const n = int(rng, 1, 20);
        // ~1/3 of sequences contain no valid call at all.
        const allowValid = bool(rng, 0.67);
        const calls: Call[] = [];
        for (let k = 0; k < n; k++) {
          if (allowValid && bool(rng, 0.4)) {
            calls.push({ valid: true, raw: genValidAnswers(rng, ids) });
          } else {
            const c = genInvalidAnswers(rng, ids);
            calls.push({ valid: false, raw: c.raw, kind: c.kind, expectedCode: c.expectedCode });
          }
        }

        const session = fakeSessionPort();
        const sessions = fakeSessions();
        const coord = new ClarificationCoordinator({
          sessionService: session,
          sessions,
          pollIntervalMs: 1,
          maxWaitMs: Number.MAX_SAFE_INTEGER,
          nowMs: () => 0,
          sleep: immediateSleep,
        });
        const sessionId = `S-${iter}`;

        // 1. Start waiting (not awaited). 2. Let HUMAN_REQUIRED settle.
        const waiting = coord.awaitAnswers(sessionId, request);
        await Promise.resolve();

        // 3. Synchronous submit sequence.
        const results = calls.map((c) => coord.submit(sessionId, c.raw));

        // 4. Assertions.
        const firstValid = calls.findIndex((c) => c.valid);
        let acceptedAnswers: ClarificationAnswers | undefined;

        results.forEach((res, k) => {
          const call = calls[k]!;
          if (firstValid === -1 || k < firstValid) {
            // Before acceptance: invalid calls are rejected with their validation code.
            expect(call.valid).toBe(false);
            if (call.valid) return;
            expect(res, `call ${k} (${call.kind})`).toEqual(expect.objectContaining({ ok: false, code: call.expectedCode }));
          } else if (k === firstValid) {
            const v = validateClarificationAnswers(request, call.raw);
            expect(v.ok).toBe(true);
            if (!v.ok) return;
            acceptedAnswers = v.answers;
            const merged = mergeClarificationAnswers(request, v.answers);
            expect(res).toEqual({
              ok: true,
              requestId: request.requestId,
              answered: merged.answered.length,
              skipped: merged.skipped.length,
            });
          } else {
            expect(res, `call ${k} after acceptance`).toEqual(expect.objectContaining({ ok: false, code: 'NOT_AWAITING' }));
          }
        });

        const accepted = results.filter((r) => r.ok);
        if (firstValid === -1) {
          sawNoValid++;
          expect(accepted).toHaveLength(0);
          // Nothing accepted → end the wait by cancelling the session.
          sessions.state = 'CANCELLING';
          await expect(waiting).resolves.toEqual({ kind: 'cancelled' });
        } else {
          sawValid++;
          expect(accepted).toHaveLength(1);
          await expect(waiting).resolves.toEqual({ kind: 'answered', answers: acceptedAnswers });
        }
        // The request is gone either way.
        expect(coord.submit(sessionId, calls[0]!.raw)).toEqual(expect.objectContaining({ ok: false, code: 'NOT_AWAITING' }));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`property failed at iteration ${iter} (seed ${SEED}): ${msg}`, { cause: err });
      }
    }

    // Both branches of the property were exercised.
    expect(sawValid).toBeGreaterThan(0);
    expect(sawNoValid).toBeGreaterThan(0);
  });
});

// ─── Unit tests: timing & state transitions (task 4.3) ───────────────────────
// Requirements 3.1, 3.2, 3.4, 3.5, 3.6, 6.2, 9.4

describe('ClarificationCoordinator — timing and session transitions', () => {
  const SID = 'S';
  /** Fixed single-question request (q1). */
  const request = genRequest(mulberry32(42), 1, 1);
  const VALID = { q1: 'yes' };

  /** Controllable clock + sleep that counts calls (and can advance the clock). */
  function harness(opts: { maxWaitMs?: number; advancePerSleep?: number } = {}) {
    const clock = { now: 0, sleeps: 0 };
    const session = fakeSessionPort();
    const sessions = fakeSessions();
    const coord = new ClarificationCoordinator({
      sessionService: session,
      sessions,
      pollIntervalMs: 1,
      maxWaitMs: opts.maxWaitMs ?? Number.MAX_SAFE_INTEGER,
      nowMs: () => clock.now,
      sleep: () => {
        clock.sleeps++;
        clock.now += opts.advancePerSleep ?? 0;
        return immediateSleep();
      },
    });
    return { clock, session, sessions, coord };
  }

  const ticks = async (n: number): Promise<void> => {
    for (let i = 0; i < n; i++) await immediateSleep();
  };
  const evs = (s: FakeSessionPort): string[] => s.calls.map((c) => c.ev);

  it('calls HUMAN_REQUIRED first, before any submit is accepted (3.1)', async () => {
    const { session, coord } = harness();
    const waiting = coord.awaitAnswers(SID, request);
    // transition is invoked synchronously, before the wait loop starts.
    expect(session.calls[0]).toEqual({ id: SID, ev: 'HUMAN_REQUIRED' });
    expect(session.calls).toHaveLength(1);

    const res = coord.submit(SID, VALID);
    expect(res.ok).toBe(true);
    await waiting;
    expect(evs(session).indexOf('HUMAN_REQUIRED')).toBe(0);
  });

  it('calls HUMAN_DECIDED {humanDecisionRecorded:true} after an answered submit (3.2)', async () => {
    const { session, coord } = harness();
    const waiting = coord.awaitAnswers(SID, request);
    await ticks(2);
    expect(coord.submit(SID, VALID)).toEqual(expect.objectContaining({ ok: true }));
    await expect(waiting).resolves.toEqual({ kind: 'answered', answers: { q1: 'yes' } });
    expect(session.calls).toEqual([
      { id: SID, ev: 'HUMAN_REQUIRED' },
      { id: SID, ev: 'HUMAN_DECIDED', ctx: { humanDecisionRecorded: true } },
    ]);
  });

  it('times out once the fake clock passes maxWaitMs and still calls HUMAN_DECIDED (3.4)', async () => {
    const { session, coord, clock } = harness({ maxWaitMs: 1000, advancePerSleep: 600 });
    await expect(coord.awaitAnswers(SID, request)).resolves.toEqual({ kind: 'timeout' });
    expect(clock.now).toBeGreaterThanOrEqual(1000);
    expect(clock.sleeps).toBe(2);
    expect(session.calls).toEqual([
      { id: SID, ev: 'HUMAN_REQUIRED' },
      { id: SID, ev: 'HUMAN_DECIDED', ctx: { humanDecisionRecorded: true } },
    ]);
    expect(coord.submit(SID, VALID)).toEqual(expect.objectContaining({ ok: false, code: 'NOT_AWAITING' }));
  });

  it('returns cancelled within two polls when state flips to CANCELLING, without HUMAN_DECIDED (3.5)', async () => {
    const { session, sessions, coord, clock } = harness();
    const waiting = coord.awaitAnswers(SID, request);
    await ticks(3);
    const sleepsAtFlip = clock.sleeps;
    sessions.state = 'CANCELLING';
    await expect(waiting).resolves.toEqual({ kind: 'cancelled' });
    expect(clock.sleeps - sleepsAtFlip).toBeLessThanOrEqual(2);
    expect(evs(session)).not.toContain('HUMAN_DECIDED');
    expect(coord.submit(SID, VALID)).toEqual(expect.objectContaining({ ok: false, code: 'NOT_AWAITING' }));
  });

  it('returns cancelled and drops the entry when HUMAN_REQUIRED throws and state is not AWAITING_HUMAN', async () => {
    const session = fakeSessionPort();
    const sessions = fakeSessions('RUNNING');
    const failing: FakeSessionPort = {
      calls: session.calls,
      transition: async (id, ev, ctx) => {
        await session.transition(id, ev, ctx);
        if (ev === 'HUMAN_REQUIRED') throw new Error('illegal transition');
        return undefined;
      },
    };
    const c = new ClarificationCoordinator({
      sessionService: failing,
      sessions,
      pollIntervalMs: 1,
      nowMs: () => 0,
      sleep: immediateSleep,
    });
    await expect(c.awaitAnswers(SID, request)).resolves.toEqual({ kind: 'cancelled' });
    expect(evs(session)).toEqual(['HUMAN_REQUIRED']);
    expect(c.submit(SID, VALID)).toEqual(expect.objectContaining({ ok: false, code: 'NOT_AWAITING' }));
  });

  it('keeps waiting when HUMAN_REQUIRED throws but state is already AWAITING_HUMAN', async () => {
    const session = fakeSessionPort();
    const sessions = fakeSessions('AWAITING_HUMAN');
    const failing: FakeSessionPort = {
      calls: session.calls,
      transition: async (id, ev, ctx) => {
        await session.transition(id, ev, ctx);
        if (ev === 'HUMAN_REQUIRED') throw new Error('already awaiting');
        return undefined;
      },
    };
    const c = new ClarificationCoordinator({
      sessionService: failing,
      sessions,
      pollIntervalMs: 1,
      nowMs: () => 0,
      sleep: immediateSleep,
    });
    const waiting = c.awaitAnswers(SID, request);
    await ticks(3);
    expect(c.submit(SID, VALID)).toEqual(expect.objectContaining({ ok: true }));
    await expect(waiting).resolves.toEqual({ kind: 'answered', answers: { q1: 'yes' } });
    expect(session.calls[1]).toEqual({ id: SID, ev: 'HUMAN_DECIDED', ctx: { humanDecisionRecorded: true } });
  });

  it('two back-to-back submits without await: first ok, second NOT_AWAITING (6.2)', async () => {
    const { coord } = harness();
    const waiting = coord.awaitAnswers(SID, request);
    const first = coord.submit(SID, VALID);
    const second = coord.submit(SID, { q1: 'no' });
    expect(first).toEqual({ ok: true, requestId: request.requestId, answered: 1, skipped: 0 });
    expect(second).toEqual(expect.objectContaining({ ok: false, code: 'NOT_AWAITING' }));
    await expect(waiting).resolves.toEqual({ kind: 'answered', answers: { q1: 'yes' } });
  });

  it('a fresh coordinator (simulated restart) has no pending entry → NOT_AWAITING (9.4)', async () => {
    const before = harness();
    const waiting = before.coord.awaitAnswers(SID, request);
    await ticks(1);

    const after = harness();
    expect(after.coord.submit(SID, VALID)).toEqual(expect.objectContaining({ ok: false, code: 'NOT_AWAITING' }));

    // Clean up the old waiter.
    before.sessions.state = 'CANCELLING';
    await expect(waiting).resolves.toEqual({ kind: 'cancelled' });
  });

  it('an invalid submit keeps the entry; a later valid submit succeeds', async () => {
    const { coord } = harness();
    const waiting = coord.awaitAnswers(SID, request);
    expect(coord.submit(SID, {})).toEqual(expect.objectContaining({ ok: false, code: 'EMPTY_ANSWERS' }));
    expect(coord.submit(SID, { q1: 42 })).toEqual(expect.objectContaining({ ok: false, code: 'NON_STRING_ANSWER' }));
    await ticks(2);
    expect(coord.submit(SID, VALID)).toEqual(expect.objectContaining({ ok: true }));
    await expect(waiting).resolves.toEqual({ kind: 'answered', answers: { q1: 'yes' } });
  });

  it('never rejects when the sessions reader throws (treated as cancelled) (3.6)', async () => {
    const session = fakeSessionPort();
    const c = new ClarificationCoordinator({
      sessionService: session,
      sessions: { getById: async () => { throw new Error('db down'); } },
      pollIntervalMs: 1,
      nowMs: () => 0,
      sleep: immediateSleep,
    });
    await expect(c.awaitAnswers(SID, request)).resolves.toEqual({ kind: 'cancelled' });
    expect(evs(session)).not.toContain('HUMAN_DECIDED');
    expect(c.submit(SID, VALID)).toEqual(expect.objectContaining({ ok: false, code: 'NOT_AWAITING' }));
  });
});
