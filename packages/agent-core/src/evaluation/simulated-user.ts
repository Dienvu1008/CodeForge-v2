/*
 * Copyright 2026 DienVu (Dienvu1008)
 * SPDX-License-Identifier: Apache-2.0
 */

// Simulated user (interaction benchmark) — plays the USER for vague / multi-approach benchmark goals.
//
// It knows the hidden intent the checks verify. When the agent asks clarification questions it
// answers from the case's profile; when the agent proposes plan options it picks the one matching
// the user's preferences. DETERMINISTIC on purpose (rule matching, no LLM): a second model would add
// noise and could leak the checks; the measurement must be about the agent.
//
// The gates implement the same ports the runtime uses (ClarificationGate / PlanChoiceGate), so the
// benchmark drives the REAL MissionIntelligence code path; they only skip the session parking
// (there is no human to wait for) and record a transcript for metrics.
import type { SimulatedUserProfile } from '../domain/evaluation.js';
import type {
  ClarificationAnswers,
  ClarificationGate,
  ClarificationOutcome,
  ClarificationRequest,
} from '../mission/goal-clarification.js';
import type { PlanChoiceGate, PlanChoiceOutcome, PlanOptionsRequest } from '../mission/plan-options.js';

/** Answer every open question: first matching rule (case-insensitive substring), else the intent. */
export function answerClarification(profile: SimulatedUserProfile, request: ClarificationRequest): ClarificationAnswers {
  const out: Record<string, string> = {};
  for (const q of request.openQuestions) {
    const text = q.text.toLowerCase();
    const rule = (profile.answers ?? []).find((a) => text.includes(a.match.toLowerCase()));
    out[q.id] = rule !== undefined ? rule.answer : profile.intent;
  }
  return out;
}

/**
 * Pick a plan option: the option whose title + summary + pros contain the most `prefer` keywords
 * (case-insensitive); ties go to the recommended option, then to the earlier one. No hits (or no
 * preferences) ⇒ let the agent decide (the recommended option, source 'default').
 */
export function choosePlanOption(
  profile: SimulatedUserProfile,
  request: PlanOptionsRequest,
): { readonly optionId: string; readonly source: 'user' | 'default'; readonly score: number } {
  const prefer = (profile.prefer ?? []).map((p) => p.toLowerCase());
  let best: { id: string; score: number; recommended: boolean } | undefined;
  for (const o of request.options) {
    const hay = [o.title, o.summary, ...o.pros].join(' ').toLowerCase();
    const score = prefer.filter((p) => hay.includes(p)).length;
    if (best === undefined || score > best.score || (score === best.score && o.recommended && !best.recommended)) {
      best = { id: o.id, score, recommended: o.recommended };
    }
  }
  if (best === undefined || best.score === 0) {
    return { optionId: request.recommendedOptionId, source: 'default', score: 0 };
  }
  return { optionId: best.id, source: 'user', score: best.score };
}

/** One interaction recorded during a benchmark case. */
export type SimulatedInteraction =
  | { readonly kind: 'clarification'; readonly questions: number; readonly answeredByRule: number }
  | { readonly kind: 'plan-choice'; readonly options: number; readonly optionId: string; readonly source: 'user' | 'default'; readonly score: number };

/** ClarificationGate that answers immediately from the profile (no session parking). */
export class SimulatedClarificationGate implements ClarificationGate {
  public readonly transcript: SimulatedInteraction[] = [];
  constructor(private readonly profile: SimulatedUserProfile) {}
  async awaitAnswers(_sessionId: string, request: ClarificationRequest): Promise<ClarificationOutcome> {
    const answers = answerClarification(this.profile, request);
    const byRule = request.openQuestions.filter((q) => (this.profile.answers ?? []).some((a) => q.text.toLowerCase().includes(a.match.toLowerCase()))).length;
    this.transcript.push({ kind: 'clarification', questions: request.openQuestions.length, answeredByRule: byRule });
    return { kind: 'answered', answers };
  }
}

/** PlanChoiceGate that picks immediately from the profile's preferences (no session parking). */
export class SimulatedPlanChoiceGate implements PlanChoiceGate {
  public readonly transcript: SimulatedInteraction[] = [];
  constructor(private readonly profile: SimulatedUserProfile) {}
  async awaitChoice(_sessionId: string, request: PlanOptionsRequest): Promise<PlanChoiceOutcome> {
    const c = choosePlanOption(this.profile, request);
    this.transcript.push({ kind: 'plan-choice', options: request.options.length, optionId: c.optionId, source: c.source, score: c.score });
    return { kind: 'chosen', optionId: c.optionId, source: c.source };
  }
}