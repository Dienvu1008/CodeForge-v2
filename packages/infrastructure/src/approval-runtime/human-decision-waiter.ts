/*
 * Copyright 2026 DienVu (Dienvu1008)
 * SPDX-License-Identifier: Apache-2.0
 */

// HumanDecisionWaiter — the shared "wait for a human decision inside the run" core used by the
// goal clarification gate (Phase 1) and plan options (Phase 2).
//
//   1. register the pending request (in-process waiter) BEFORE the session becomes visible as waiting,
//   2. drive the session to AWAITING_HUMAN (SessionService — the single authority, HUMAN_REQUIRED),
//   3. wait until submit() delivers a valid answer, the session leaves AWAITING_HUMAN (→ 'cancelled'),
//      or the wait budget expires (→ 'timeout'),
//   4. return the session to RUNNING (HUMAN_DECIDED, SS-007 humanDecisionRecorded) for answered/timeout.
//
// submit() is SYNCHRONOUS: check-and-remove happens in one tick, so at most one valid answer is
// accepted per request. It never writes events (MissionIntelligence is the single emitter, OB-009).
// A session already in AWAITING_HUMAN (resumed after a restart) keeps waiting: the failed
// HUMAN_REQUIRED transition is tolerated when the state read back is AWAITING_HUMAN.
import type { SessionTransitionPort } from './approval-coordinator.js';

/** Minimal read port over the session store (just the state we poll). */
export interface SessionStateReader {
  getById(sessionId: string): Promise<{ readonly state: string } | null>;
}

export interface HumanDecisionWaiterOptions {
  readonly sessionService: SessionTransitionPort;
  readonly sessions: SessionStateReader;
  /** Poll interval (ms) while waiting. Default 300. */
  readonly pollIntervalMs?: number;
  /** Max time (ms) to wait before 'timeout'. Default 3,600,000 (1h). */
  readonly maxWaitMs?: number;
  readonly nowMs?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export type HumanDecisionOutcome<TAnswer> =
  | { readonly kind: 'answered'; readonly answer: TAnswer }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'cancelled' };

export type HumanDecisionSubmit<TRequest, TAnswer, E> =
  | { readonly ok: true; readonly request: TRequest; readonly answer: TAnswer }
  | { readonly ok: false; readonly notAwaiting: true }
  | { readonly ok: false; readonly notAwaiting: false; readonly error: E };

interface PendingEntry<TRequest, TAnswer> {
  readonly request: TRequest;
  readonly resolve: (answer: TAnswer) => void;
}

const AWAITING_HUMAN = 'AWAITING_HUMAN';

export class HumanDecisionWaiter<TRequest, TAnswer> {
  private readonly pollIntervalMs: number;
  private readonly maxWaitMs: number;
  private readonly nowMs: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly pending = new Map<string, PendingEntry<TRequest, TAnswer>>();

  constructor(private readonly opts: HumanDecisionWaiterOptions) {
    this.pollIntervalMs = opts.pollIntervalMs ?? 300;
    this.maxWaitMs = opts.maxWaitMs ?? 3_600_000;
    this.nowMs = opts.nowMs ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** Wait for a decision on `request`. Never throws. */
  async wait(sessionId: string, request: TRequest): Promise<HumanDecisionOutcome<TAnswer>> {
    let resolveAnswered!: (answer: TAnswer) => void;
    const answered = new Promise<TAnswer>((r) => { resolveAnswered = r; });
    const entry: PendingEntry<TRequest, TAnswer> = { request, resolve: resolveAnswered };
    this.pending.set(sessionId, entry);

    let outcome: HumanDecisionOutcome<TAnswer> = { kind: 'cancelled' };
    try {
      try {
        await this.opts.sessionService.transition(sessionId, 'HUMAN_REQUIRED');
      } catch {
        if ((await this.readState(sessionId)) !== AWAITING_HUMAN) {
          outcome = { kind: 'cancelled' };
          return outcome;
        }
      }
      const deadline = this.nowMs() + this.maxWaitMs;
      for (;;) {
        const got = await Promise.race([
          answered.then((answer) => ({ answer })),
          this.sleep(this.pollIntervalMs).then(() => null),
        ]);
        if (got) { outcome = { kind: 'answered', answer: got.answer }; break; }
        if ((await this.readState(sessionId)) !== AWAITING_HUMAN) { outcome = { kind: 'cancelled' }; break; }
        if (this.nowMs() >= deadline) { outcome = { kind: 'timeout' }; break; }
      }
      return outcome;
    } catch {
      outcome = { kind: 'cancelled' };
      return outcome;
    } finally {
      if (this.pending.get(sessionId) === entry) this.pending.delete(sessionId);
      if (outcome.kind !== 'cancelled') {
        try {
          await this.opts.sessionService.transition(sessionId, 'HUMAN_DECIDED', { humanDecisionRecorded: true });
        } catch {
          // Session not resumable (cancelled/aborted meanwhile) — best-effort.
        }
      }
    }
  }

  /**
   * Synchronous check-and-remove: `validate` runs against the pending request; a rejected answer
   * keeps the request pending, an accepted one removes it and wakes the waiter.
   */
  submit<E>(
    sessionId: string,
    validate: (request: TRequest) => { readonly ok: true; readonly answer: TAnswer } | { readonly ok: false; readonly error: E },
  ): HumanDecisionSubmit<TRequest, TAnswer, E> {
    const entry = this.pending.get(sessionId);
    if (!entry) return { ok: false, notAwaiting: true };
    const v = validate(entry.request);
    if (!v.ok) return { ok: false, notAwaiting: false, error: v.error };
    this.pending.delete(sessionId);
    entry.resolve(v.answer);
    return { ok: true, request: entry.request, answer: v.answer };
  }

  private async readState(sessionId: string): Promise<string | undefined> {
    try {
      return (await this.opts.sessions.getById(sessionId))?.state;
    } catch {
      return undefined;
    }
  }
}