/*
 * Copyright 2026 DienVu (Dienvu1008)
 * SPDX-License-Identifier: Apache-2.0
 */

// Seeded generators for the goal-clarification-gate property tests (Properties 1–7).
//
// The repo has no fast-check; these tiny generators keep property tests deterministic and
// reproducible (fixed seed ⇒ same inputs every run, MI-005 spirit). Shared by:
//   - tests/mission/goal-clarification*.spec.ts            (Properties 1–4)
//   - tests/mission/mission-intelligence-clarify.spec.ts   (Property 6)
//   - tests/approval-runtime/clarification-coordinator.spec.ts (Property 5)
//   - tests/vscode-extension/goal-history.spec.ts          (Property 7)

import {
  MAX_ANSWER_LENGTH,
  SUGGESTED_OPTIONS,
  type AnswerValidationCode,
  type ClarificationRequest,
} from '@codeforge/agent-core';

// ── PRNG ────────────────────────────────────────────────────────────────────────────────────────

/** Returns a float in [0, 1). */
export type Rng = () => number;

/** mulberry32: small, fast, deterministic 32-bit PRNG. */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Integer in [min, max] (inclusive). */
export function int(rng: Rng, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

export function bool(rng: Rng, pTrue = 0.5): boolean {
  return rng() < pTrue;
}

export function pick<T>(rng: Rng, items: readonly T[]): T {
  if (items.length === 0) throw new Error('pick: empty list');
  return items[int(rng, 0, items.length - 1)] as T;
}

/** Random subset (order preserved). May be empty. */
export function subset<T>(rng: Rng, items: readonly T[], pKeep = 0.5): T[] {
  return items.filter(() => bool(rng, pKeep));
}

/**
 * Run `body` for `runs` iterations with a PRNG seeded from `seed`. On failure the thrown error is
 * re-thrown with the iteration index and seed so the counterexample is reproducible.
 */
export function forAll(seed: number, runs: number, body: (rng: Rng, iteration: number) => void): void {
  const rng = mulberry32(seed);
  for (let i = 0; i < runs; i++) {
    try {
      body(rng, i);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`property failed at iteration ${i} (seed ${seed}): ${msg}`, { cause: err });
    }
  }
}

// ── Strings ─────────────────────────────────────────────────────────────────────────────────────

const PLAIN_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.,:;!?-_()[]→"\'/';
/** C0/C1 control chars (\p{Cc}) incl. \n \r \t, NUL, ESC, DEL, NEL. */
export const CONTROL_CHARS: readonly string[] = ['\n', '\r', '\t', '\u0000', '\u0007', '\u001b', '\u007f', '\u0085', '\u000b', '\u000c'];
/** Unicode whitespace that is NOT a control char (matched by \s). */
export const UNICODE_SPACES: readonly string[] = [' ', '\u00a0', '\u2000', '\u2003', '\u2028', '\u2029', '\u202f', '\u3000', '\ufeff'];
const WORDS = ['tool', 'parse', 'csv', 'file', 'output', 'test', 'API', 'Tiếng', 'Việt', 'ベンチ', 'done', '[LABEL]', '- bullet'];

export interface StringGenOptions {
  readonly minLength?: number;
  readonly maxLength?: number;
  /** Probability per char of a control char. Default 0.15. */
  readonly pControl?: number;
  /** Probability per char of a Unicode whitespace char. Default 0.15. */
  readonly pSpace?: number;
}

/** Arbitrary string mixing plain text, words, control chars and Unicode whitespace. */
export function genString(rng: Rng, opts: StringGenOptions = {}): string {
  const len = int(rng, opts.minLength ?? 0, opts.maxLength ?? 40);
  const pControl = opts.pControl ?? 0.15;
  const pSpace = opts.pSpace ?? 0.15;
  let out = '';
  while (out.length < len) {
    const r = rng();
    if (r < pControl) out += pick(rng, CONTROL_CHARS);
    else if (r < pControl + pSpace) out += pick(rng, UNICODE_SPACES);
    else if (r < pControl + pSpace + 0.1) out += pick(rng, WORDS);
    else out += pick(rng, [...PLAIN_CHARS]);
  }
  return out;
}

/** Plain printable text with at least one non-space char (never normalizes to ''). */
export function genNonBlankText(rng: Rng, maxLength = 60): string {
  return `${pick(rng, WORDS)}${genString(rng, { maxLength, pControl: 0, pSpace: 0.1 })}`;
}

/** Strings that normalize to '' (empty, spaces, control chars, Unicode whitespace). */
export function genBlank(rng: Rng): string {
  const len = int(rng, 0, 6);
  let out = '';
  for (let i = 0; i < len; i++) out += pick(rng, [...CONTROL_CHARS, ...UNICODE_SPACES]);
  return out;
}

// ── Questions / requests ────────────────────────────────────────────────────────────────────────

/** The exact question texts that have static suggestions. */
export const SUGGESTED_KEYS: readonly string[] = [...SUGGESTED_OPTIONS.keys()];

/** Question list of length [min, max] (default 1..8) mixing exact SUGGESTED_OPTIONS keys and random texts. */
export function genQuestionList(rng: Rng, min = 1, max = 8): string[] {
  const n = int(rng, min, max);
  const qs: string[] = [];
  for (let i = 0; i < n; i++) {
    qs.push(bool(rng, 0.35) ? pick(rng, SUGGESTED_KEYS) : `${genNonBlankText(rng)}?`);
  }
  return qs;
}

/** A ClarificationRequest built directly (no dependency on buildClarificationRequest). */
export function genRequest(rng: Rng, min = 1, max = 8): ClarificationRequest {
  const qs = genQuestionList(rng, min, max);
  return {
    requestId: `req-${int(rng, 0, 1e9)}`,
    missionId: `m-${int(rng, 0, 1e9)}`,
    goalId: `g-${int(rng, 0, 1e9)}`,
    openQuestions: qs.map((text, i) => {
      const options = SUGGESTED_OPTIONS.get(text);
      return options ? { id: `q${i + 1}`, text, suggestedOptions: [...options] } : { id: `q${i + 1}`, text };
    }),
  };
}

export function questionIds(request: ClarificationRequest): string[] {
  return request.openQuestions.map((q) => q.id);
}

// ── Answer maps ─────────────────────────────────────────────────────────────────────────────────

/**
 * Answer map whose keys are a (possibly empty) subset of `ids`. Values mix non-blank text, blank
 * strings and arbitrary strings (with control chars / Unicode whitespace). Values stay well under
 * MAX_ANSWER_LENGTH.
 */
export function genAnswerMap(rng: Rng, ids: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const id of subset(rng, ids, 0.6)) {
    const r = rng();
    out[id] = r < 0.25 ? genBlank(rng) : r < 0.6 ? genNonBlankText(rng) : genString(rng, { maxLength: 80 });
  }
  return out;
}

/** A VALID raw answer map: non-empty subset of `ids`, string values ≤ MAX_ANSWER_LENGTH after normalization. */
export function genValidAnswers(rng: Rng, ids: readonly string[]): Record<string, string> {
  if (ids.length === 0) throw new Error('genValidAnswers: no ids');
  const out = genAnswerMap(rng, ids);
  if (Object.keys(out).length === 0) out[pick(rng, ids)] = genString(rng, { maxLength: 80 });
  return out;
}

export type InvalidAnswersKind =
  | 'non-object'
  | 'null'
  | 'array'
  | 'empty-object'
  | 'non-string-value'
  | 'unknown-key'
  | 'too-long';

export interface InvalidAnswersCase {
  readonly kind: InvalidAnswersKind;
  readonly raw: unknown;
  /** The code validateClarificationAnswers must return (first failing check). */
  readonly expectedCode: AnswerValidationCode;
}

/** A string whose normalized form is longer than MAX_ANSWER_LENGTH. */
export function genTooLongAnswer(rng: Rng): string {
  const len = MAX_ANSWER_LENGTH + int(rng, 1, 200);
  let s = '';
  while (s.length < len) s += pick(rng, [...PLAIN_CHARS]);
  return s;
}

/**
 * An invalid raw answers payload for `ids`, containing exactly ONE fault class so the expected
 * code is unambiguous under the check order EMPTY → NON_STRING → UNKNOWN → TOO_LONG.
 */
export function genInvalidAnswers(rng: Rng, ids: readonly string[], kind?: InvalidAnswersKind): InvalidAnswersCase {
  if (ids.length === 0) throw new Error('genInvalidAnswers: no ids');
  const k: InvalidAnswersKind =
    kind ?? pick(rng, ['non-object', 'null', 'array', 'empty-object', 'non-string-value', 'unknown-key', 'too-long']);
  const base = (): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const id of subset(rng, ids, 0.5)) out[id] = genNonBlankText(rng);
    return out;
  };
  switch (k) {
    case 'non-object':
      return { kind: k, raw: pick<unknown>(rng, ['answers', 42, true, undefined, () => 'x']), expectedCode: 'EMPTY_ANSWERS' };
    case 'null':
      return { kind: k, raw: null, expectedCode: 'EMPTY_ANSWERS' };
    case 'array':
      return { kind: k, raw: [genNonBlankText(rng)], expectedCode: 'EMPTY_ANSWERS' };
    case 'empty-object':
      return { kind: k, raw: {}, expectedCode: 'EMPTY_ANSWERS' };
    case 'non-string-value': {
      const raw = base();
      raw[pick(rng, ids)] = pick<unknown>(rng, [1, null, true, ['a'], { a: 'b' }, undefined]);
      return { kind: k, raw, expectedCode: 'NON_STRING_ANSWER' };
    }
    case 'unknown-key': {
      const raw = base();
      const unknown = pick(rng, [`q${ids.length + int(rng, 1, 5)}`, 'q0', 'x1', 'Q1', `extra-${int(rng, 0, 99)}`]);
      raw[unknown] = genNonBlankText(rng);
      return { kind: k, raw, expectedCode: 'UNKNOWN_QUESTION' };
    }
    case 'too-long': {
      const raw = base();
      raw[pick(rng, ids)] = genTooLongAnswer(rng);
      return { kind: k, raw, expectedCode: 'ANSWER_TOO_LONG' };
    }
  }
}
