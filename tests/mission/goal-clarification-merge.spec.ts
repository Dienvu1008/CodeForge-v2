// Feature: goal-clarification-gate, Property 3: Gộp câu trả lời phân hoạch đúng câu hỏi
/*
 * Copyright 2026 DienVu (Dienvu1008)
 * SPDX-License-Identifier: Apache-2.0
 */

// **Validates: Requirements 5.1, 7.2, 7.3, 7.6**

import { describe, it, expect } from 'vitest';
import {
  buildClarificationRequest,
  mergeClarificationAnswers,
  normalizeAnswer,
} from '@codeforge/agent-core';
import { forAll, genAnswerMap, genRequest, questionIds } from './clarification-generators.js';

const SEED = 0x1c1a7e03;
const RUNS = 200;
const LINE_BREAKS = /[\n\r\u2028\u2029]/u;

describe('Property 3: mergeClarificationAnswers partitions the questions', () => {
  it('answered/skipped partition the ids in request order; statements are one-line and well-formed', () => {
    forAll(SEED, RUNS, (rng) => {
      const request = genRequest(rng, 1, 8);
      const ids = questionIds(request);
      const answers = genAnswerMap(rng, ids);
      const n = ids.length;

      const merged = mergeClarificationAnswers(request, answers);
      const answeredIds = merged.answered.map((a) => a.questionId);
      const skippedIds = merged.skipped.map((q) => q.id);

      // Sizes.
      expect(answeredIds.length + skippedIds.length).toBe(n);
      expect(merged.userStatements).toHaveLength(merged.answered.length);

      // Each id appears exactly once across answered ∪ skipped.
      const all = [...answeredIds, ...skippedIds];
      expect(new Set(all).size).toBe(n);
      expect([...all].sort()).toEqual([...ids].sort());

      // Membership rule.
      for (const id of ids) {
        const isAnswered = normalizeAnswer(answers[id] ?? '') !== '';
        expect(answeredIds.includes(id)).toBe(isAnswered);
        expect(skippedIds.includes(id)).toBe(!isAnswered);
      }

      // Request order preserved in both lists.
      const indexOf = (id: string): number => ids.indexOf(id);
      for (const list of [answeredIds, skippedIds]) {
        for (let i = 1; i < list.length; i++) {
          expect(indexOf(list[i] as string)).toBeGreaterThan(indexOf(list[i - 1] as string));
        }
      }

      // Statements and answered entries.
      merged.answered.forEach((a, i) => {
        const q = request.openQuestions.find((oq) => oq.id === a.questionId);
        expect(q).toBeDefined();
        const expectedAnswer = normalizeAnswer(answers[a.questionId] ?? '');
        expect(a.answer).toBe(expectedAnswer);
        expect(a.question).toBe(q?.text); // raw text kept

        const statement = merged.userStatements[i] as string;
        expect(LINE_BREAKS.test(statement)).toBe(false);
        expect(statement.startsWith('[user-provided] ')).toBe(true);
        expect(statement).toContain(normalizeAnswer(q?.text ?? ''));
        expect(statement).toContain(expectedAnswer);
      });

      // Skipped entries are the original question objects.
      merged.skipped.forEach((q) => {
        expect(request.openQuestions).toContain(q);
      });
    });
  });
});

describe('mergeClarificationAnswers (examples)', () => {
  const request = buildClarificationRequest('r', 'm', 'g', ['First?', 'Second?', 'Third?']);

  it('empty answer map skips every question', () => {
    const merged = mergeClarificationAnswers(request, {});
    expect(merged.answered).toEqual([]);
    expect(merged.userStatements).toEqual([]);
    expect(merged.skipped.map((q) => q.id)).toEqual(['q1', 'q2', 'q3']);
  });

  it('blank answers count as skipped; others become user statements', () => {
    const merged = mergeClarificationAnswers(request, { q1: '  \n\t ', q3: 'use  JSON\noutput' });
    expect(merged.skipped.map((q) => q.id)).toEqual(['q1', 'q2']);
    expect(merged.answered).toEqual([{ questionId: 'q3', question: 'Third?', answer: 'use JSON output' }]);
    expect(merged.userStatements).toEqual(['[user-provided] Third? → use JSON output']);
  });

  it('normalizes the question text inside the statement but keeps raw text in answered', () => {
    const req = buildClarificationRequest('r', 'm', 'g', ['Multi\nline\u2028question?']);
    const merged = mergeClarificationAnswers(req, { q1: 'yes' });
    expect(merged.answered[0]?.question).toBe('Multi\nline\u2028question?');
    expect(merged.userStatements).toEqual(['[user-provided] Multi line question? → yes']);
  });
});
