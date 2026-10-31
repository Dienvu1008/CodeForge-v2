/*
 * Copyright 2026 DienVu (Dienvu1008)
 * SPDX-License-Identifier: Apache-2.0
 */

// Deterministic simulated user (interaction benchmark) + loader validation of simulatedUser.
import { describe, it, expect } from 'vitest';
import {
  answerClarification,
  choosePlanOption,
  SimulatedClarificationGate,
  SimulatedPlanChoiceGate,
  buildClarificationRequest,
  buildPlanOptionsRequest,
  validateBenchmarkTask,
  type PlanOption,
} from '@codeforge/agent-core';

const profile = {
  intent: 'A module temp.js exporting cToF and fToC.',
  answers: [{ match: 'inputs and outputs', answer: 'numbers in, numbers out' }],
  prefer: ['lru', 'least recently used'],
};
const opt = (id: string, title: string, summary: string, recommended = false): PlanOption =>
  ({ id, title, summary, pros: ['p'], cons: ['c'], recommended });

describe('answerClarification', () => {
  it('answers by the first matching rule (case-insensitive) and falls back to the intent', () => {
    const req = buildClarificationRequest('R', 'M', 'G', [
      'What are the INPUTS AND OUTPUTS (types, format)?',
      'The goal is very short — can you describe the expected behavior in more detail?',
    ]);
    expect(answerClarification(profile, req)).toEqual({ q1: 'numbers in, numbers out', q2: profile.intent });
  });
});

describe('choosePlanOption', () => {
  it('picks the option with the most preference hits', () => {
    const req = buildPlanOptionsRequest('R', 'M', 'G', [
      opt('o1', 'TTL expiry', 'Entries expire after a time.', true),
      opt('o2', 'LRU eviction', 'Evict the least recently used entry.'),
    ]);
    expect(choosePlanOption(profile, req)).toEqual({ optionId: 'o2', source: 'user', score: 2 });
  });
  it('no hits (or no preferences) ⇒ let the agent decide (recommended, source default)', () => {
    const req = buildPlanOptionsRequest('R', 'M', 'G', [opt('o1', 'A', 'a'), opt('o2', 'B', 'b', true)]);
    expect(choosePlanOption(profile, req)).toEqual({ optionId: 'o2', source: 'default', score: 0 });
    expect(choosePlanOption({ intent: 'x' }, req)).toEqual({ optionId: 'o2', source: 'default', score: 0 });
  });
  it('ties go to the recommended option, then to the earlier one', () => {
    const req = buildPlanOptionsRequest('R', 'M', 'G', [opt('o1', 'LRU a', 'x'), opt('o2', 'LRU b', 'y', true), opt('o3', 'LRU c', 'z')]);
    expect(choosePlanOption(profile, req).optionId).toBe('o2');
    const req2 = buildPlanOptionsRequest('R', 'M', 'G', [opt('o1', 'LRU a', 'x'), opt('o2', 'LRU b', 'y'), opt('o3', 'none', 'z', true)]);
    expect(choosePlanOption(profile, req2).optionId).toBe('o1');
  });
});

describe('simulated gates', () => {
  it('answer immediately and record a transcript', async () => {
    const cg = new SimulatedClarificationGate(profile);
    const creq = buildClarificationRequest('R', 'M', 'G', ['What are the inputs and outputs?', 'Other?']);
    await expect(cg.awaitAnswers('S', creq)).resolves.toEqual({ kind: 'answered', answers: { q1: 'numbers in, numbers out', q2: profile.intent } });
    expect(cg.transcript).toEqual([{ kind: 'clarification', questions: 2, answeredByRule: 1 }]);

    const pg = new SimulatedPlanChoiceGate(profile);
    const preq = buildPlanOptionsRequest('R', 'M', 'G', [opt('o1', 'TTL', 'x', true), opt('o2', 'LRU', 'y')]);
    await expect(pg.awaitChoice('S', preq)).resolves.toEqual({ kind: 'chosen', optionId: 'o2', source: 'user' });
    expect(pg.transcript).toEqual([{ kind: 'plan-choice', options: 2, optionId: 'o2', source: 'user', score: 1 }]);
  });
});

describe('validateBenchmarkTask — simulatedUser / interaction', () => {
  const base = {
    id: 'X', version: 1, category: 'FEATURE', title: 't', description: 'd', difficulty: 'EASY', risk: 'LOW', timeoutMs: 1000,
    verification: [{ kind: 'command', target: 'node', args: ['-e', '1'], description: 'c' }],
  };
  it('keeps a valid profile and interaction kind', () => {
    const r = validateBenchmarkTask({ ...base, interaction: 'vague', simulatedUser: profile });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.simulatedUser).toEqual(profile);
    expect(r.value.interaction).toBe('vague');
  });
  it('rejects malformed profiles and unknown interaction kinds', () => {
    for (const bad of [
      { simulatedUser: 'x' }, { simulatedUser: { intent: '' } }, { simulatedUser: { intent: 'i', answers: [{ match: '', answer: 'a' }] } },
      { simulatedUser: { intent: 'i', prefer: ['', 'x'] } }, { interaction: 'chatty' },
    ]) {
      expect(validateBenchmarkTask({ ...base, ...bad }).ok, JSON.stringify(bad)).toBe(false);
    }
  });
  it('tasks without a profile are unchanged', () => {
    const r = validateBenchmarkTask(base);
    expect(r.ok && r.value.simulatedUser === undefined && r.value.interaction === undefined).toBe(true);
  });
});