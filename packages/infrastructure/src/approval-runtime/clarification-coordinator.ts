/*
 * Copyright 2026 DienVu (Dienvu1008)
 * SPDX-License-Identifier: Apache-2.0
 */

// ClarificationCoordinator — the human-in-the-loop bridge for goal clarification (Phase 1).
//
// When MissionIntelligence finds a goal UNKNOWN (and --clarify on), it asks this coordinator to
// wait for the user's answers. The waiting mechanics (AWAITING_HUMAN via SessionService, poll for
// cancel, timeout, HUMAN_DECIDED, synchronous at-most-once submit) live in the shared
// HumanDecisionWaiter; this class only adds clarification-specific validation and result shapes.
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
import { HumanDecisionWaiter, type HumanDecisionWaiterOptions } from './human-decision-waiter.js';

export type { SessionStateReader } from './human-decision-waiter.js';

export type ClarificationCoordinatorOptions = HumanDecisionWaiterOptions;

export type SubmitClarificationResult =
  | { readonly ok: true; readonly requestId: string; readonly answered: number; readonly skipped: number }
  | { readonly ok: false; readonly code: 'NOT_AWAITING' | AnswerValidationCode; readonly message: string };

export class ClarificationCoordinator implements ClarificationGate {
  private readonly waiter: HumanDecisionWaiter<ClarificationRequest, ClarificationAnswers>;

  constructor(opts: ClarificationCoordinatorOptions) {
    this.waiter = new HumanDecisionWaiter(opts);
  }

  async awaitAnswers(sessionId: string, request: ClarificationRequest): Promise<ClarificationOutcome> {
    const o = await this.waiter.wait(sessionId, request);
    return o.kind === 'answered' ? { kind: 'answered', answers: o.answer } : o;
  }

  /** Synchronous check-and-remove: at most one accepted submission per request. */
  submit(sessionId: string, rawAnswers: unknown): SubmitClarificationResult {
    const r = this.waiter.submit(sessionId, (request) => {
      const v = validateClarificationAnswers(request, rawAnswers);
      return v.ok ? { ok: true, answer: v.answers } : { ok: false, error: v };
    });
    if (r.ok) {
      const merged = mergeClarificationAnswers(r.request, r.answer);
      return { ok: true, requestId: r.request.requestId, answered: merged.answered.length, skipped: merged.skipped.length };
    }
    if (r.notAwaiting) return { ok: false, code: 'NOT_AWAITING', message: 'session not awaiting clarification' };
    return { ok: false, code: r.error.code, message: r.error.message };
  }
}