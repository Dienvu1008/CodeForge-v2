/*
 * Copyright 2026 DienVu (Dienvu1008)
 * SPDX-License-Identifier: Apache-2.0
 */

// ApproachAdvisor (plan-options) — FakeModel-driven: valid output, retry on invalid, throw when exhausted.
// Requirements 2.5, 3.1, 3.6.
import { describe, it, expect } from 'vitest';
import { ApproachAdvisor, type Mission } from '@codeforge/agent-core';
import { FakeModel } from '@codeforge/testing';

const mission = {
  missionId: 'M', goalId: 'G', userGoal: 'g', normalizedGoal: 'build a matrix multiplication tool',
  missionType: 'FEATURE', complexity: { level: 'MEDIUM', reasons: [] }, risk: { level: 'LOW', factors: [] },
  uncertainty: { level: 'KNOWN', openQuestions: [] }, acceptanceCriteria: [{ criterionId: 'a', description: 'tests pass', mandatory: true }],
} as unknown as Mission;

const VALID = JSON.stringify({ options: [
  { title: 'Single script', summary: 'One file with a CLI.', pros: ['Fast'], cons: ['No tests'], recommended: false },
  { title: 'Module + tests', summary: 'A module plus pytest tests.', pros: ['Verifiable'], cons: ['More files'], recommended: true },
] });

describe('ApproachAdvisor.propose', () => {
  it('returns sanitized options from a valid response through the single gateway', async () => {
    const gw = new FakeModel();
    gw.setResponse(/.*/, VALID);
    const opts = await new ApproachAdvisor({ gateway: gw }).propose(mission, ['[user-provided] q → a']);
    expect(opts.map((o) => [o.id, o.title, o.recommended])).toEqual([['o1', 'Single script', false], ['o2', 'Module + tests', true]]);
    expect(gw.callCount).toBe(1);
    expect(gw.lastPrompt).toContain('[user-provided] q → a');
    expect(gw.lastPrompt).toContain('build a matrix multiplication tool');
  });

  it('retries when the first output has fewer than 2 valid options, then succeeds', async () => {
    const gw = new FakeModel();
    gw.setSequence([JSON.stringify({ options: [{ title: 'Only one', summary: 's', pros: ['p'], cons: ['c'] }] }), VALID]);
    const opts = await new ApproachAdvisor({ gateway: gw }).propose(mission, []);
    expect(opts).toHaveLength(2);
    expect(gw.callCount).toBe(2);
  });

  it('throws when every attempt is invalid (caller skips the step)', async () => {
    const gw = new FakeModel();
    gw.setResponse(/.*/, 'not json');
    await expect(new ApproachAdvisor({ gateway: gw }).propose(mission, [])).rejects.toThrow();
  });
});