// MissionContextStrategy (P12.7) — deterministic Mission → context scope recommendation. A
// trivial task must NOT widen to repository scope (CX-005 / §34); heavy/architectural missions
// warrant repository (or multi-repo) scope. Pure: same mission → same strategy.
import { describe, it, expect } from 'vitest';
import {
  decideContextStrategy, toContextPlan, policyFromContextPlan,
  type Mission, type MissionType, type Complexity,
} from '@codeforge/agent-core';

function mission(type: MissionType, level: Complexity, contextScope: Mission['contextScope'] = 'FILE'): Mission {
  return {
    missionId: 'm', goalId: 'g', userGoal: 'x', normalizedGoal: 'x',
    missionType: type,
    complexity: { level, confidence: 0.8, reasons: [], usedAdvisory: false },
    risk: { level: 'LOW', factors: ['READ_ONLY'], requiredApprovals: [], requiredVerification: [] },
    uncertainty: { level: 'KNOWN', openQuestions: [] },
    contextScope, planningMode: 'DIRECT', architectureRequirement: 'NOT_REQUIRED',
    capabilityRequirements: [], modelRequirement: { reasoning: 'LOW', coding: 'LOW', architecture: 'LOW', context: 'SMALL', toolUse: 'LOW', latencySensitive: true },
    researchRequired: false, constraints: [], acceptanceCriteria: [],
    provenance: { provenanceId: 'p', source: { kind: 'runtime', id: 't' }, inputs: [], reason: 'r', at: '2026-01-01T00:00:00.000Z' },
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('decideContextStrategy', () => {
  it('trivial bug fix → TASK scope, not repository-wide (CX-005)', () => {
    const s = decideContextStrategy(mission('BUG_FIX', 'LOW', 'TASK'));
    expect(s.scope).toBe('TASK');
    expect(s.repositoryWide).toBe(false);
    expect(s.maxFiles).toBeLessThan(10);
  });

  it('PROJECT → REPOSITORY scope', () => {
    const s = decideContextStrategy(mission('PROJECT', 'HIGH', 'REPOSITORY'));
    expect(s.scope).toBe('REPOSITORY');
    expect(s.repositoryWide).toBe(true);
  });

  it('SYSTEM complexity → REPOSITORY scope regardless of type', () => {
    expect(decideContextStrategy(mission('FEATURE', 'SYSTEM')).scope).toBe('REPOSITORY');
  });

  it('MULTI_REPOSITORY mission → MULTI_REPOSITORY scope', () => {
    expect(decideContextStrategy(mission('MULTI_REPOSITORY', 'HIGH')).scope).toBe('MULTI_REPOSITORY');
  });

  it('RESEARCH mission → EXTERNAL_RESEARCH scope', () => {
    expect(decideContextStrategy(mission('RESEARCH', 'MEDIUM')).scope).toBe('EXTERNAL_RESEARCH');
  });

  it('HIGH complexity feature → MODULE scope', () => {
    expect(decideContextStrategy(mission('FEATURE', 'HIGH')).scope).toBe('MODULE');
  });

  it('is deterministic', () => {
    const m = mission('REFACTOR', 'MEDIUM');
    expect(JSON.stringify(decideContextStrategy(m))).toEqual(JSON.stringify(decideContextStrategy(m)));
  });
});

describe('toContextPlan', () => {
  it('projects the three steering fields and drops reason', () => {
    const s = decideContextStrategy(mission('PROJECT', 'HIGH', 'REPOSITORY'));
    const plan = toContextPlan(s);
    expect(plan).toEqual({ scope: s.scope, maxFiles: s.maxFiles, repositoryWide: s.repositoryWide });
    expect('reason' in plan).toBe(false);
  });
});

describe('policyFromContextPlan', () => {
  it('narrow scopes (TASK/FILE) get the smallest token budget', () => {
    const p = policyFromContextPlan({ scope: 'TASK', maxFiles: 3, repositoryWide: false });
    expect(p.availableTokens).toBe(4096);
    // maxItems ≈ 2× maxFiles, clamped to a floor of 8.
    expect(p.maxItems).toBe(8); // max(8, round(3*2)) = 8
  });

  it('MODULE scope gets the mid token budget', () => {
    const p = policyFromContextPlan({ scope: 'MODULE', maxFiles: 25, repositoryWide: false });
    expect(p.availableTokens).toBe(8192);
    expect(p.maxItems).toBe(50); // round(25*2)=50, under the 60 cap
  });

  it('REPOSITORY scope gets the largest budget and clamps maxItems to 60', () => {
    const p = policyFromContextPlan({ scope: 'REPOSITORY', maxFiles: 150, repositoryWide: true });
    expect(p.availableTokens).toBe(12288);
    expect(p.maxItems).toBe(60); // round(150*2)=300, clamped to 60
  });

  it('EXTERNAL_RESEARCH and MULTI_REPOSITORY also get the largest budget', () => {
    expect(policyFromContextPlan({ scope: 'EXTERNAL_RESEARCH', maxFiles: 150, repositoryWide: true }).availableTokens).toBe(12288);
    expect(policyFromContextPlan({ scope: 'MULTI_REPOSITORY', maxFiles: 400, repositoryWide: true }).availableTokens).toBe(12288);
  });

  it('carries a scope-tagged policyId and is pure/deterministic', () => {
    const plan = { scope: 'FILE' as const, maxFiles: 5, repositoryWide: false };
    const a = policyFromContextPlan(plan);
    const b = policyFromContextPlan(plan);
    expect(a.policyId).toBe('cx-file');
    expect(JSON.stringify(a)).toEqual(JSON.stringify(b));
  });
});
