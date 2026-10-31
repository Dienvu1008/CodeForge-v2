// Feature: goal-clarification-gate, Property 1: Dựng request tất định
/*
 * Copyright 2026 DienVu (Dienvu1008)
 * SPDX-License-Identifier: Apache-2.0
 */

// **Validates: Requirements 2.3, 2.4**

import { describe, it, expect } from 'vitest';
import { buildClarificationRequest, SUGGESTED_OPTIONS } from '@codeforge/agent-core';
import { forAll, genQuestionList, genString, int, SUGGESTED_KEYS } from './clarification-generators.js';

const SEED = 0x1c1a7e01;
const RUNS = 200;

describe('Property 1: buildClarificationRequest is deterministic', () => {
  it('assigns q1..qN in order, keeps texts, attaches suggestions iff the text is a known key', () => {
    forAll(SEED, RUNS, (rng) => {
      const qs = genQuestionList(rng, 1, 8);
      const requestId = genString(rng, { minLength: 1, maxLength: 20 });
      const missionId = `m-${int(rng, 0, 1e6)}`;
      const goalId = `g-${int(rng, 0, 1e6)}`;

      const req = buildClarificationRequest(requestId, missionId, goalId, qs);

      expect(req.requestId).toBe(requestId);
      expect(req.missionId).toBe(missionId);
      expect(req.goalId).toBe(goalId);
      expect(req.openQuestions).toHaveLength(qs.length);
      req.openQuestions.forEach((q, i) => {
        expect(q.id).toBe(`q${i + 1}`);
        expect(q.text).toBe(qs[i]);
        const expected = SUGGESTED_OPTIONS.get(qs[i] as string);
        if (expected) {
          expect(q.suggestedOptions).toEqual(expected);
        } else {
          expect('suggestedOptions' in q).toBe(false);
        }
      });

      expect(buildClarificationRequest(requestId, missionId, goalId, qs)).toEqual(req);
    });
  });
});

describe('SUGGESTED_OPTIONS table (examples)', () => {
  it('the "done" question carries the verification suggestions', () => {
    const doneQ = SUGGESTED_KEYS.find((k) => k.startsWith('What does "done" look like'));
    expect(doneQ).toBeDefined();
    const req = buildClarificationRequest('r', 'm', 'g', [doneQ as string]);
    expect(req.openQuestions[0]?.suggestedOptions).toEqual([
      'Unit tests',
      'An example input → expected output',
      'Manual check is enough',
    ]);
  });

  it('the inputs/outputs question carries I/O suggestions; unknown questions get none', () => {
    const ioQ = 'What are the inputs and outputs (types, format, an example of input → expected output)?';
    const req = buildClarificationRequest('r', 'm', 'g', ['Something else?', ioQ]);
    expect(req.openQuestions[0]).toEqual({ id: 'q1', text: 'Something else?' });
    expect(req.openQuestions[1]).toEqual({
      id: 'q2',
      text: ioQ,
      suggestedOptions: ['Command-line arguments → stdout', 'A function/library API', 'Read a file → write a file'],
    });
  });

  it('returned suggestions are a copy (mutating them does not affect the table)', () => {
    const ioQ = SUGGESTED_KEYS[1] as string;
    const req = buildClarificationRequest('r', 'm', 'g', [ioQ]);
    expect(req.openQuestions[0]?.suggestedOptions).not.toBe(SUGGESTED_OPTIONS.get(ioQ));
  });
});
