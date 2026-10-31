/*
 * Copyright 2026 DienVu (Dienvu1008)
 * SPDX-License-Identifier: Apache-2.0
 */

// PlanChoiceCoordinator — the human-in-the-loop bridge for plan options (Goal Clarification Phase 2).
//
// MissionIntelligence proposes 2–4 approaches and asks this coordinator to wait for the user's pick
// (POST /plan-choice). Same mechanics as the clarification gate (shared HumanDecisionWaiter): the
// session parks in AWAITING_HUMAN, a cancel ends the wait, the budget expires to 'timeout' (the
// stage then takes the recommended option), and at most one valid choice is accepted per request.
// It never writes events (OB-009).
import {
  validatePlanChoice,
  type PlanChoiceGate,
  type PlanChoiceOutcome,
  type PlanChoiceValidationCode,
  type PlanOptionsRequest,
} from '@codeforge/agent-core';
import { HumanDecisionWaiter, type HumanDecisionWaiterOptions } from './human-decision-waiter.js';

export type PlanChoiceCoordinatorOptions = HumanDecisionWaiterOptions;

export type SubmitPlanChoiceResult =
  | { readonly ok: true; readonly requestId: string; readonly optionId: string; readonly source: 'user' | 'default' }
  | { readonly ok: false; readonly code: 'NOT_AWAITING' | PlanChoiceValidationCode; readonly message: string };

interface PlanChoiceAnswer {
  readonly optionId: string;
  readonly source: 'user' | 'default';
}

export class PlanChoiceCoordinator implements PlanChoiceGate {
  private readonly waiter: HumanDecisionWaiter<PlanOptionsRequest, PlanChoiceAnswer>;

  constructor(opts: PlanChoiceCoordinatorOptions) {
    this.waiter = new HumanDecisionWaiter(opts);
  }

  async awaitChoice(sessionId: string, request: PlanOptionsRequest): Promise<PlanChoiceOutcome> {
    const o = await this.waiter.wait(sessionId, request);
    return o.kind === 'answered' ? { kind: 'chosen', optionId: o.answer.optionId, source: o.answer.source } : o;
  }

  /** Synchronous check-and-remove: at most one accepted choice per request. */
  submit(sessionId: string, rawChoice: unknown): SubmitPlanChoiceResult {
    const r = this.waiter.submit(sessionId, (request) => {
      const v = validatePlanChoice(request, rawChoice);
      return v.ok ? { ok: true, answer: { optionId: v.optionId, source: v.source } } : { ok: false, error: v };
    });
    if (r.ok) return { ok: true, requestId: r.request.requestId, optionId: r.answer.optionId, source: r.answer.source };
    if (r.notAwaiting) return { ok: false, code: 'NOT_AWAITING', message: 'session not awaiting plan choice' };
    return { ok: false, code: r.error.code, message: r.error.message };
  }
}