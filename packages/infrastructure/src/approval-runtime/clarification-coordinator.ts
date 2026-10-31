/*
 * Copyright 2026 DienVu (Dienvu1008)
 * SPDX-License-Identifier: Apache-2.0
 */

// ClarificationCoordinator — the human-in-the-loop bridge for goal clarification.
//
// When MissionIntelligence finds a goal UNKNOWN (and --clarify on), it asks this
// coordinator to wait for the user's answers. The coordinator:
//   1. registers the pending request (in-process waiter),
//   2. drives the session to AWAITING_HUMAN (SessionService — the single authority),
//   3. waits until POST /clarification → submit() delivers valid answers, the session
//      leaves AWAITING_HUMAN (cancel → 'cancelled'), or the wait budget expires ('timeout'),
//   4. returns the session to RUNNING (HUMAN_DECIDED, SS-007 humanDecisionRecorded)
//      for 'answered' / 'timeout'.
//
// submit() is SYNCHRONOUS: check-and-remove happens in one tick, so at most one valid
// answer set is accepted per request (a second POST gets NOT_AWAITING → 409).
// It never writes events — MissionIntelligence is the single emitter (OB-009).
import {
  mergeClarificationAnswers,
  validateClarificationAnswers,
  type AnswerValidationCode,
  type ClarificationAnswers,
  type ClarificationGate,
  type ClarificationOutcome,
  type ClarificationRequest,
} from '@codeforge/agent-core';
import type { SessionTransitionPort } from './approval-coordinator.js';

/** Minimal read port over the session store (just the state we poll). */
export interface SessionStateReader {
  getById(sessionId: string): Promise<{ readonly state: string } | null>;
}

export interface ClarificationCoordinatorOptions {
  readonly sessionService: SessionTransitionPort;
  readonly sessions: SessionStateReader;
  /** Poll interval (ms) while awaiting answers. Default 300. */
  readonly pollIntervalMs?: number;
  /** Max time (ms) to wait for answers before 'timeout'. Default 3,600,000 (1h). */
  readonly maxWaitMs?: number;
  readonly nowMs?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export type SubmitClarificationResult =
  | { readonly ok: true; readonly requestId: string; readonly answered: number; readonly skipped: number }
  | { readonly ok: false; readonly code: 'NOT_AWAITING' | AnswerValidationCode; readonly message: string };

interface PendingEntry {
  readonly request: ClarificationRequest;
  readonly resolve: (answers: ClarificationAnswers) => void;
}

const AWAITING_HUMAN = 'AWAITING_HUMAN';

export class ClarificationCoordinator implements ClarificationGate {
  private readonly pollIntervalMs: number;
  private readonly maxWaitMs: number;
  private readonly nowMs: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly pending = new Map<string, PendingEntry>();

  constructor(private readonly opts: ClarificationCoordinatorOptions) {
    this.pollIntervalMs = opts.pollIntervalMs ?? 300;
    this.maxWaitMs = opts.maxWaitMs ?? 3_600_000;
    this.nowMs = opts.nowMs ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async awaitAnswers(sessionId: string, request: ClarificationRequest): Promise<ClarificationOutcome> {
    // 1. Register the waiter BEFORE the session becomes visible as AWAITING_HUMAN,
    //    so a fast client submit can never race ahead of registration.
    let resolveAnswered!: (answers: ClarificationAnswers) => void;
    const answered = new Promise<ClarificationAnswers>((r) => { resolveAnswered = r; });
    const entry: PendingEntry = { request, resolve: resolveAnswered };
    this.pending.set(sessionId, entry);

    let outcome: ClarificationOutcome = { kind: 'cancelled' };
    try {
      // 2. Session → AWAITING_HUMAN. On failure, only continue if it is already there.
      try {
        await this.opts.sessionService.transition(sessionId, 'HUMAN_REQUIRED');
      } catch {
        if ((await this.readState(sessionId)) !== AWAITING_HUMAN) {
          outcome = { kind: 'cancelled' };
          return outcome;
        }
      }

      // 3. Wait for answers, a state change (cancel), or the deadline.
      const deadline = this.nowMs() + this.maxWaitMs;
      for (;;) {
        const got = await Promise.race([
          answered.then((answers) => ({ answers })),
          this.sleep(this.pollIntervalMs).then(() => null),
        ]);
        if (got) { outcome = { kind: 'answered', answers: got.answers }; break; }
        if ((await this.readState(sessionId)) !== AWAITING_HUMAN) { outcome = { kind: 'cancelled' }; break; }
        if (this.nowMs() >= deadline) { outcome = { kind: 'timeout' }; break; }
      }
      return outcome;
    } catch {
      // Contract: never throw — treat an unexpected failure as cancelled.
      outcome = { kind: 'cancelled' };
      return outcome;
    } finally {
      // 4. Drop the waiter (only if it is still ours) and resume the session.
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

  /** Synchronous check-and-remove: at most one accepted submission per request. */
  submit(sessionId: string, rawAnswers: unknown): SubmitClarificationResult {
    const entry = this.pending.get(sessionId);
    if (!entry) {
      return { ok: false, code: 'NOT_AWAITING', message: 'session not awaiting clarification' };
    }
    const v = validateClarificationAnswers(entry.request, rawAnswers);
    if (!v.ok) return { ok: false, code: v.code, message: v.message };

    this.pending.delete(sessionId);
    entry.resolve(v.answers);
    const merged = mergeClarificationAnswers(entry.request, v.answers);
    return {
      ok: true,
      requestId: entry.request.requestId,
      answered: merged.answered.length,
      skipped: merged.skipped.length,
    };
  }

  private async readState(sessionId: string): Promise<string | undefined> {
    try {
      return (await this.opts.sessions.getById(sessionId))?.state;
    } catch {
      return undefined;
    }
  }
}
