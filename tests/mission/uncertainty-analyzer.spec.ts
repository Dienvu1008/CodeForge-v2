// assessUncertainty (Tier A) — deterministic goal-ambiguity scoring. A precise goal with
// acceptance criteria + concrete I/O scores KNOWN; a vague one (no acceptance, open-ended
// wording, no I/O) scores UNKNOWN and surfaces concrete openQuestions. Pure + deterministic.
import { describe, it, expect } from 'vitest';
import { assessUncertainty, extractSignals, type AcceptanceCriterion } from '@codeforge/agent-core';

const ac = (description: string): AcceptanceCriterion => ({ criterionId: 'a', description, mandatory: true });

function u(goal: string, type: Parameters<typeof assessUncertainty>[1], acs: AcceptanceCriterion[] = []) {
  return assessUncertainty(extractSignals(goal), type, acs);
}

describe('assessUncertainty', () => {
  it('a precise goal with acceptance criteria + concrete I/O → KNOWN', () => {
    const r = u(
      'add an exported function isEven(n) that returns true for even integers and false otherwise',
      'FEATURE',
      [ac('isEven(2) returns true and isEven(3) returns false')],
    );
    expect(r.level).toBe('KNOWN');
    expect(r.openQuestions).toHaveLength(0);
  });

  it('the vague matrix goal → UNKNOWN with concrete open questions', () => {
    const r = u('create a python script matmul.py that multiplies two matrices', 'FEATURE', []);
    expect(r.level).toBe('UNKNOWN');
    // It should flag the missing acceptance/verification and the missing I/O spec.
    expect(r.openQuestions.some((q) => /verified|done|output/i.test(q))).toBe(true);
    expect(r.openQuestions.length).toBeGreaterThanOrEqual(2);
  });

  it('missing acceptance criteria alone → at least INFERRED', () => {
    const r = u('implement pagination for the users endpoint with limit and offset parameters returning a page', 'FEATURE', []);
    // Has concrete spec words (parameters/returns) + decent length, but no acceptance → INFERRED.
    expect(['INFERRED', 'UNKNOWN']).toContain(r.level);
    expect(r.openQuestions.some((q) => /verified|done/i.test(q))).toBe(true);
  });

  it('open-ended wording raises uncertainty ("help me ... something")', () => {
    const r = u('help me make a tool that does something with the files', 'FEATURE', []);
    expect(r.level).toBe('UNKNOWN');
  });

  it('Vietnamese vague phrasing is detected', () => {
    const r = u('tạo cho tôi một script làm gì đó với dữ liệu', 'FEATURE', []);
    expect(['INFERRED', 'UNKNOWN']).toContain(r.level);
    expect(r.openQuestions.length).toBeGreaterThan(0);
  });

  it('a RESEARCH goal is never fully KNOWN (exploratory by nature)', () => {
    const r = u('investigate which charting library best fits the dashboard and why', 'RESEARCH',
      [ac('a short comparison with a recommendation is produced')]);
    expect(r.level).not.toBe('KNOWN');
  });

  it('is deterministic (same inputs → identical result)', () => {
    const sig = extractSignals('create a script that multiplies two matrices');
    expect(JSON.stringify(assessUncertainty(sig, 'FEATURE', []))).toEqual(JSON.stringify(assessUncertainty(sig, 'FEATURE', [])));
  });

  it('openQuestions are sorted (stable output)', () => {
    const r = u('do something', 'FEATURE', []);
    const sorted = [...r.openQuestions].sort();
    expect(r.openQuestions).toEqual(sorted);
  });
});
