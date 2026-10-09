// AssumptionAdvisor (Tier B1) — turns an under-specified mission into EXPLICIT assumptions + a
// clarified goal via the structured-output pipeline. Deterministic (FakeModel; FM-8). Validates:
// mapping, the MAX_ASSUMPTIONS clamp, and rejection of invalid output.
import { describe, it, expect } from 'vitest';
import { AssumptionAdvisor, type Mission, ModelError } from '@codeforge/agent-core';
import { FakeModel } from '@codeforge/testing';

function mission(over: Partial<Mission> = {}): Mission {
  return {
    missionId: 'm-1', goalId: 'g-1', userGoal: 'multiply two matrices', normalizedGoal: 'multiply two matrices',
    missionType: 'FEATURE',
    complexity: { level: 'MEDIUM', confidence: 0.7, reasons: [], usedAdvisory: false },
    risk: { level: 'LOW', factors: ['LOCAL_EDIT'], requiredApprovals: [], requiredVerification: [] },
    uncertainty: { level: 'UNKNOWN', openQuestions: ['What are the inputs and outputs?'] },
    contextScope: 'FILE', planningMode: 'DIRECT', architectureRequirement: 'NOT_REQUIRED',
    capabilityRequirements: [], modelRequirement: { reasoning: 'LOW', coding: 'MEDIUM', architecture: 'LOW', context: 'SMALL', toolUse: 'MEDIUM', latencySensitive: true },
    researchRequired: false, constraints: [], acceptanceCriteria: [],
    provenance: { provenanceId: 'p', source: { kind: 'runtime', id: 't' }, inputs: [], reason: 'r', at: '2026-01-01T00:00:00.000Z' },
    createdAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

function advisor(gateway: FakeModel) {
  let n = 0;
  return new AssumptionAdvisor({ gateway, now: () => '2026-01-02T00:00:00.000Z', newProvenanceId: () => `prov-${++n}` });
}

const VALID = JSON.stringify({
  clarifiedGoal: 'Create matmul.py with multiply(a,b) over nested-list matrices, printing the product.',
  assumptions: [
    { question: 'representation?', assumption: 'matrices are Python nested lists', acceptance: 'multiply([[1,2],[3,4]],[[5,6],[7,8]]) == [[19,22],[43,50]]' },
    { question: 'interface?', assumption: 'a function multiply(a, b) is exported', acceptance: 'importing multiply works' },
  ],
});

describe('AssumptionAdvisor.clarify', () => {
  it('maps a valid model response into a GoalClarification', async () => {
    const gw = new FakeModel(); gw.setResponse(/.*/, VALID);
    const out = await advisor(gw).clarify(mission());
    expect(out.missionId).toBe('m-1');
    expect(out.clarifiedGoal).toContain('matmul');
    expect(out.assumptions).toHaveLength(2);
    expect(out.assumptions[0]!.acceptance).toContain('19,22');
    expect(out.provenance.source.kind).toBe('model');
  });

  it('uses the untrusted boundary (goal wrapped) and the plan purpose', async () => {
    const gw = new FakeModel(); gw.setResponse(/.*/, VALID);
    await advisor(gw).clarify(mission());
    const call = gw.history[0]!;
    expect(call.request.taskPrompt).toContain('<untrusted>');
    expect(call.request.systemPrompt).toContain('UNTRUSTED');
  });

  it('clamps to at most 6 assumptions', async () => {
    const many = JSON.stringify({
      clarifiedGoal: 'x',
      assumptions: Array.from({ length: 10 }, (_, i) => ({ assumption: `a${i}`, acceptance: `check ${i}` })),
    });
    const gw = new FakeModel(); gw.setResponse(/.*/, many);
    const out = await advisor(gw).clarify(mission());
    expect(out.assumptions.length).toBeLessThanOrEqual(6);
  });

  it('rejects output with an empty assumptions array (semantic check)', async () => {
    const gw = new FakeModel(); gw.setResponse(/.*/, JSON.stringify({ clarifiedGoal: 'x', assumptions: [] }));
    await expect(advisor(gw).clarify(mission())).rejects.toBeInstanceOf(ModelError);
  });

  it('rejects non-JSON output', async () => {
    const gw = new FakeModel(); gw.setResponse(/.*/, 'not json');
    await expect(advisor(gw).clarify(mission())).rejects.toBeInstanceOf(ModelError);
  });
});
