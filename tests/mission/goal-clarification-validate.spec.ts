// Feature: goal-clarification-gate, Property 4: Kiểm tra hợp lệ từ chối đầu vào sai với đúng mã lỗi
/*
 * Copyright 2026 DienVu (Dienvu1008)
 * SPDX-License-Identifier: Apache-2.0
 */

// **Validates: Requirements 5.4, 5.5, 5.6, 5.7**

import { describe, it, expect } from 'vitest';
import {
  MAX_ANSWER_LENGTH,
  normalizeAnswer,
  validateClarificationAnswers,
  type AnswerValidationCode,
  type ClarificationRequest,
} from '@codeforge/agent-core';
import {
  forAll,
  genInvalidAnswers,
  genRequest,
  genValidAnswers,
  questionIds,
  type InvalidAnswersKind,
} from './clarification-generators.js';

const SEED = 0x1c1a7e04;
const RUNS = 300;

const ALL_KINDS: readonly InvalidAnswersKind[] = [
  'non-object',
  'null',
  'array',
  'empty-object',
  'non-string-value',
  'unknown-key',
  'too-long',
];

/** The HTTP error string expected for a given code (and raw payload, for UNKNOWN_QUESTION). */
function expectedMessage(code: AnswerValidationCode, request: ClarificationRequest, raw: unknown): string {
  switch (code) {
    case 'EMPTY_ANSWERS':
      return 'answers required';
    case 'NON_STRING_ANSWER':
      return 'answers must be strings';
    case 'ANSWER_TOO_LONG':
      return 'answer too long';
    case 'UNKNOWN_QUESTION': {
      const ids = new Set(questionIds(request));
      const unknown = Object.keys(raw as Record<string, unknown>).find((k) => !ids.has(k));
      return `unknown question id: ${unknown}`;
    }
  }
}

describe('Property 4: validateClarificationAnswers rejects bad input with the right code', () => {
  it('invalid payloads → ok:false with the expected code and HTTP message (all kinds covered)', () => {
    const seen = new Set<InvalidAnswersKind>();
    forAll(SEED, RUNS, (rng, i) => {
      const request = genRequest(rng, 1, 8);
      const ids = questionIds(request);
      // First pass cycles through every kind explicitly; the rest are random.
      const kind = i < ALL_KINDS.length ? ALL_KINDS[i] : undefined;
      const c = genInvalidAnswers(rng, ids, kind);
      seen.add(c.kind);

      const result = validateClarificationAnswers(request, c.raw);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe(c.expectedCode);
      expect(result.message).toBe(expectedMessage(c.expectedCode, request, c.raw));
    });
    expect([...seen].sort()).toEqual([...ALL_KINDS].sort());
  });

  it('valid payloads → ok:true with the same keys and normalized values', () => {
    forAll(SEED + 1, RUNS, (rng) => {
      const request = genRequest(rng, 1, 8);
      const raw = genValidAnswers(rng, questionIds(request));

      const result = validateClarificationAnswers(request, raw);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(Object.keys(result.answers).sort()).toEqual(Object.keys(raw).sort());
      for (const k of Object.keys(raw)) {
        expect(result.answers[k]).toBe(normalizeAnswer(raw[k] as string));
      }
    });
  });
});

describe('Answer length boundary (examples)', () => {
  const request: ClarificationRequest = {
    requestId: 'r',
    missionId: 'm',
    goalId: 'g',
    openQuestions: [{ id: 'q1', text: 'Q?' }],
  };

  it(`accepts exactly ${MAX_ANSWER_LENGTH} chars after normalization`, () => {
    const answer = 'a'.repeat(MAX_ANSWER_LENGTH);
    const result = validateClarificationAnswers(request, { q1: answer });
    expect(result).toEqual({ ok: true, answers: { q1: answer } });
  });

  it(`rejects ${MAX_ANSWER_LENGTH + 1} chars after normalization`, () => {
    const result = validateClarificationAnswers(request, { q1: 'a'.repeat(MAX_ANSWER_LENGTH + 1) });
    expect(result).toEqual({ ok: false, code: 'ANSWER_TOO_LONG', message: 'answer too long' });
  });

  it('accepts a long raw string whose internal whitespace normalizes to ≤ 500 chars', () => {
    // 250 'a' + 249 single separators = 499 chars after collapsing; raw is much longer.
    const raw = `  ${Array.from({ length: 250 }, () => 'a').join(' \n\t\u00a0 ')}  \r\n`;
    expect(raw.length).toBeGreaterThan(MAX_ANSWER_LENGTH);
    const result = validateClarificationAnswers(request, { q1: raw });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.answers.q1).toBe(normalizeAnswer(raw));
    expect(result.answers.q1?.length).toBe(499);
  });
});
