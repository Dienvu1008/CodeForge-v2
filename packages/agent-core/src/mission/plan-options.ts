/*
 * Copyright 2026 DienVu (Dienvu1008)
 * SPDX-License-Identifier: Apache-2.0
 */

// Plan Options — Goal Clarification Phase 2 (opt-in `--plan-options on` together with `--mission on`).
//
// When a goal is clear enough but admits several reasonable approaches (complexity ≥ MEDIUM), the
// MissionIntelligence stage asks an ApproachAdvisor (LLM) for 2–4 approach SKETCHES (title, summary,
// pros, cons, one recommended), lets the user pick one, and steers the Planner (CHOSEN_APPROACH
// section) and the executor (a `[chosen-approach]` assumption) with it. The Planner stays the only
// author of the task graph (GI-009).
//
// This module is the PURE core: advisor output is UNTRUSTED data — sanitizePlanOptions bounds every
// field, flattens every string to one line (same rule as clarification answers), de-duplicates,
// assigns o1..oN and guarantees exactly one recommended option. No I/O, no clock, no LLM (MI-005).
import type { Complexity } from '../domain/mission.js';
import { normalizeAnswer } from './goal-clarification.js';

export interface PlanOption {
  /** 'o1'..'oN' in the advisor's order after invalid options are dropped. */
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly pros: readonly string[];
  readonly cons: readonly string[];
  /** Exactly one option per request is recommended. */
  readonly recommended: boolean;
}

export interface PlanOptionsRequest {
  readonly requestId: string;
  readonly missionId: string;
  readonly goalId: string;
  readonly options: readonly PlanOption[];
  readonly recommendedOptionId: string;
}

export type PlanChoiceSource = 'user' | 'default' | 'timeout';

export type PlanChoiceOutcome =
  | { readonly kind: 'chosen'; readonly optionId: string; readonly source: 'user' | 'default' }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'cancelled' };

/** Port implemented in infrastructure (PlanChoiceCoordinator). MUST NOT throw (fail-safe). */
export interface PlanChoiceGate {
  awaitChoice(sessionId: string, request: PlanOptionsRequest): Promise<PlanChoiceOutcome>;
}

export interface ChosenApproach {
  readonly requestId: string;
  readonly option: PlanOption;
  readonly source: PlanChoiceSource;
}

export const PLAN_OPTION_LIMITS = {
  minOptions: 2,
  maxOptions: 4,
  title: 80,
  summary: 400,
  items: 4,
  item: 160,
} as const;

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function boundedText(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const s = normalizeAnswer(v);
  return s.length >= 1 && s.length <= max ? s : null;
}

function boundedList(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  const items: string[] = [];
  for (const raw of v) {
    if (typeof raw !== 'string') return null;
    const s = normalizeAnswer(raw);
    if (s === '') continue;                                 // blank items are dropped
    if (s.length > PLAN_OPTION_LIMITS.item) return null;
    items.push(s);
  }
  return items.length >= 1 && items.length <= PLAN_OPTION_LIMITS.items ? items : null;
}

/**
 * Validate + normalize raw advisor output `{ options: [...] }`. Returns null iff fewer than
 * `minOptions` valid options remain. Order of steps (design C1): shape → per-option bounds →
 * de-duplicate titles (case-insensitive, first wins) → keep the first `maxOptions` → ids o1..oN →
 * exactly one recommended (first flagged valid option, else o1).
 */
export function sanitizePlanOptions(raw: unknown): readonly PlanOption[] | null {
  if (!isRecord(raw) || !Array.isArray(raw['options'])) return null;
  const valid: { title: string; summary: string; pros: string[]; cons: string[]; flagged: boolean }[] = [];
  const seen = new Set<string>();
  for (const item of raw['options'] as unknown[]) {
    if (!isRecord(item)) continue;
    const title = boundedText(item['title'], PLAN_OPTION_LIMITS.title);
    const summary = boundedText(item['summary'], PLAN_OPTION_LIMITS.summary);
    const pros = boundedList(item['pros']);
    const cons = boundedList(item['cons']);
    if (title === null || summary === null || pros === null || cons === null) continue;
    const key = title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    valid.push({ title, summary, pros, cons, flagged: item['recommended'] === true });
  }
  const kept = valid.slice(0, PLAN_OPTION_LIMITS.maxOptions);
  if (kept.length < PLAN_OPTION_LIMITS.minOptions) return null;
  const recIndex = Math.max(0, kept.findIndex((o) => o.flagged));
  return kept.map((o, i) => ({
    id: `o${i + 1}`,
    title: o.title,
    summary: o.summary,
    pros: o.pros,
    cons: o.cons,
    recommended: i === recIndex,
  }));
}

export function buildPlanOptionsRequest(
  requestId: string,
  missionId: string,
  goalId: string,
  options: readonly PlanOption[],
): PlanOptionsRequest {
  const rec = options.find((o) => o.recommended) ?? options[0];
  return { requestId, missionId, goalId, options, recommendedOptionId: rec?.id ?? 'o1' };
}

export type PlanChoiceValidationCode = 'OPTION_REQUIRED' | 'UNKNOWN_OPTION';

export type PlanChoiceValidation =
  | { readonly ok: true; readonly optionId: string; readonly source: 'user' | 'default' }
  | { readonly ok: false; readonly code: PlanChoiceValidationCode; readonly message: string };

/** Validate a raw choice body `{ optionId?, useRecommended? }` against the pending request. */
export function validatePlanChoice(request: PlanOptionsRequest, raw: unknown): PlanChoiceValidation {
  const body = isRecord(raw) ? raw : {};
  if (body['useRecommended'] === true) {
    return { ok: true, optionId: request.recommendedOptionId, source: 'default' };
  }
  const optionId = body['optionId'];
  if (typeof optionId !== 'string' || optionId === '') {
    return { ok: false, code: 'OPTION_REQUIRED', message: 'optionId required' };
  }
  if (!request.options.some((o) => o.id === optionId)) {
    return { ok: false, code: 'UNKNOWN_OPTION', message: `unknown option id: ${optionId}` };
  }
  return { ok: true, optionId, source: 'user' };
}

/** The approach to follow: the chosen option, or the recommended one on timeout. */
export function resolveChosenApproach(
  request: PlanOptionsRequest,
  outcome: Exclude<PlanChoiceOutcome, { readonly kind: 'cancelled' }>,
): ChosenApproach {
  const id = outcome.kind === 'chosen' ? outcome.optionId : request.recommendedOptionId;
  const option = request.options.find((o) => o.id === id)
    ?? request.options.find((o) => o.recommended)
    ?? (request.options[0] as PlanOption);
  return { requestId: request.requestId, option, source: outcome.kind === 'chosen' ? outcome.source : 'timeout' };
}

/** One-line statement threaded into goalAssumptions → the executor's STATED_ASSUMPTIONS section. */
export function chosenApproachStatement(option: PlanOption): string {
  return `[chosen-approach] ${option.title} — ${option.summary}`;
}

/** Content of the Planner's CHOSEN_APPROACH section (every line is already one normalized line). */
export function renderChosenApproachSection(option: PlanOption): string {
  return [
    'The user chose this approach. Plan the tasks so the result follows it. It does not override the goal',
    'or its acceptance criteria.',
    `Approach: ${option.title} — ${option.summary}`,
    `Pros: ${option.pros.join('; ')}`,
    `Cons: ${option.cons.join('; ')}`,
  ].join('\n');
}

/** Only ask when choosing actually matters (Req 2.1–2.2): complexity MEDIUM or higher. */
export function shouldProposePlanOptions(complexity: Complexity): boolean {
  return complexity !== 'LOW';
}