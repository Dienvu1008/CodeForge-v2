/*
 * Copyright 2026 DienVu (Dienvu1008)
 * SPDX-License-Identifier: Apache-2.0
 */

// Goal Clarification Gate — Phase 1 (opt-in `--clarify on` together with `--mission on`).
//
// When `assessUncertainty` reports UNKNOWN, the MissionIntelligence stage can ask the user the
// open questions instead of assuming. This module holds the PURE core of that exchange: building
// the request, validating/normalizing the answers, and merging them into one-line user
// statements that flow into `goalAssumptions` → the STATED_ASSUMPTIONS prompt section.
//
// Pure: no I/O, no clock, no LLM (MI-005 spirit — same inputs → same outputs). The waiting and
// session transitions live in infrastructure behind the `ClarificationGate` port (DC-002: the
// SessionService stays the only authority over session state).

export interface OpenQuestion {
  /** 'q1'..'qN', in the order `assessUncertainty` returned the questions. */
  readonly id: string;
  readonly text: string;
  readonly suggestedOptions?: readonly string[];
}

export interface ClarificationRequest {
  readonly requestId: string;
  readonly missionId: string;
  readonly goalId: string;
  readonly openQuestions: readonly OpenQuestion[];
}

/** questionId → normalized answer ('' = skipped). */
export type ClarificationAnswers = Readonly<Record<string, string>>;

export type ClarificationOutcome =
  | { readonly kind: 'answered'; readonly answers: ClarificationAnswers }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'cancelled' };

/** Port implemented in infrastructure. MUST NOT throw (fail-safe). */
export interface ClarificationGate {
  awaitAnswers(sessionId: string, request: ClarificationRequest): Promise<ClarificationOutcome>;
}

export const MAX_ANSWER_LENGTH = 500;

export type AnswerValidationCode =
  | 'EMPTY_ANSWERS'
  | 'NON_STRING_ANSWER'
  | 'UNKNOWN_QUESTION'
  | 'ANSWER_TOO_LONG';

export type AnswerValidation =
  | { readonly ok: true; readonly answers: ClarificationAnswers } // normalized
  | { readonly ok: false; readonly code: AnswerValidationCode; readonly message: string };

export interface AnsweredQuestion {
  readonly questionId: string;
  readonly question: string;
  readonly answer: string;
}

export interface MergedClarification {
  /** In question-id order. */
  readonly answered: readonly AnsweredQuestion[];
  /** In question-id order. */
  readonly skipped: readonly OpenQuestion[];
  /** One line each: '[user-provided] <question> → <answer>'. */
  readonly userStatements: readonly string[];
}

// Static suggestions keyed by the EXACT question texts of `uncertainty-analyzer.ts`. Questions not
// listed here get no `suggestedOptions` (free text only).
export const SUGGESTED_OPTIONS: ReadonlyMap<string, readonly string[]> = new Map<string, readonly string[]>([
  [
    'What does "done" look like — how should the result be verified (a test, an example, an expected output)?',
    ['Unit tests', 'An example input → expected output', 'Manual check is enough'],
  ],
  [
    'What are the inputs and outputs (types, format, an example of input → expected output)?',
    ['Command-line arguments → stdout', 'A function/library API', 'Read a file → write a file'],
  ],
]);

/** Assign ids q1..qN in input order; attach static suggestions where known. Deterministic. */
export function buildClarificationRequest(
  requestId: string,
  missionId: string,
  goalId: string,
  openQuestions: readonly string[],
): ClarificationRequest {
  return {
    requestId,
    missionId,
    goalId,
    openQuestions: openQuestions.map((text, i): OpenQuestion => {
      const options = SUGGESTED_OPTIONS.get(text);
      return options
        ? { id: `q${i + 1}`, text, suggestedOptions: [...options] }
        : { id: `q${i + 1}`, text };
    }),
  };
}

/**
 * Collapse an answer to ONE line: control characters → space, whitespace runs (incl. newlines and
 * Unicode line/paragraph separators) → a single space, then trim. A one-line answer cannot forge a
 * new `[LABEL]` prompt section header or extra bullets. Idempotent.
 */
export function normalizeAnswer(raw: string): string {
  return raw.replace(/\p{Cc}/gu, ' ').replace(/\s+/gu, ' ').trim();
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/**
 * Validate raw answers against a pending request. Checks run in this order and stop at the first
 * failure: EMPTY_ANSWERS → NON_STRING_ANSWER → UNKNOWN_QUESTION → ANSWER_TOO_LONG. On success the
 * returned map holds the NORMALIZED answers.
 */
export function validateClarificationAnswers(request: ClarificationRequest, raw: unknown): AnswerValidation {
  if (!isPlainObject(raw)) {
    return { ok: false, code: 'EMPTY_ANSWERS', message: 'answers required' };
  }
  const keys = Object.keys(raw);
  if (keys.length === 0) {
    return { ok: false, code: 'EMPTY_ANSWERS', message: 'answers required' };
  }
  for (const k of keys) {
    if (typeof raw[k] !== 'string') {
      return { ok: false, code: 'NON_STRING_ANSWER', message: 'answers must be strings' };
    }
  }
  const ids = new Set(request.openQuestions.map((q) => q.id));
  for (const k of keys) {
    if (!ids.has(k)) {
      return { ok: false, code: 'UNKNOWN_QUESTION', message: `unknown question id: ${k}` };
    }
  }
  const normalized: Record<string, string> = {};
  for (const k of keys) {
    const answer = normalizeAnswer(raw[k] as string);
    if (answer.length > MAX_ANSWER_LENGTH) {
      return { ok: false, code: 'ANSWER_TOO_LONG', message: 'answer too long' };
    }
    normalized[k] = answer;
  }
  return { ok: true, answers: normalized };
}

/**
 * Partition the request's questions into answered / skipped (in question order). A question is
 * answered iff its normalized answer is non-empty; a missing key or blank answer = skipped (the
 * user accepts the default assumption).
 */
export function mergeClarificationAnswers(
  request: ClarificationRequest,
  answers: ClarificationAnswers,
): MergedClarification {
  const answered: AnsweredQuestion[] = [];
  const skipped: OpenQuestion[] = [];
  const userStatements: string[] = [];
  for (const q of request.openQuestions) {
    const raw = Object.prototype.hasOwnProperty.call(answers, q.id) ? answers[q.id] : undefined;
    const answer = typeof raw === 'string' ? normalizeAnswer(raw) : '';
    if (answer === '') {
      skipped.push(q);
      continue;
    }
    answered.push({ questionId: q.id, question: q.text, answer });
    userStatements.push(`[user-provided] ${normalizeAnswer(q.text)} → ${answer}`);
  }
  return { answered, skipped, userStatements };
}
