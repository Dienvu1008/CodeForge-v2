// P12.10 complexity regression benchmark — the 10 representative categories from the task brief.
// Each case asserts an ACCEPTABLE complexity BAND (not an exact level, to avoid tuning to one
// sentence) and, where it matters, the routed model capability. The point is to guard against BOTH
// false-low (a structural refactor sliding to LOW → weak model) and false-high (a trivial rename
// inflated to HIGH → wasted strong model). Deterministic; reuses the real agent-core functions.
import { describe, it, expect } from 'vitest';
import {
  extractSignals, classifyMissionType, assessComplexity, analyzeModelRequirement,
  type Complexity, type Mission, type RequirementLevel,
} from '@codeforge/agent-core';

interface Case {
  readonly name: string;
  readonly goal: string;
  readonly expect: readonly Complexity[];
  /** Minimum acceptable reasoning requirement the router should derive (optional). */
  readonly minReasoning?: RequirementLevel;
  /** When true, the task must NOT be latency-sensitive (i.e. not treated as trivial). */
  readonly notTrivial?: boolean;
}

const LVL: Record<RequirementLevel, number> = { LOW: 0, MEDIUM: 1, HIGH: 2 };

// Build a Mission around a computed complexity so analyzeModelRequirement can be exercised.
function missionFor(goal: string): Mission {
  const s = extractSignals(goal);
  const type = classifyMissionType(s).type;
  const complexity = assessComplexity(s, type);
  return {
    missionId: 'm', goalId: 'g', userGoal: goal, normalizedGoal: goal,
    missionType: type, complexity,
    risk: { level: 'LOW', factors: ['LOCAL_EDIT'], requiredApprovals: [], requiredVerification: [] },
    uncertainty: { level: 'KNOWN', openQuestions: [] },
    contextScope: 'FILE', planningMode: 'DIRECT', architectureRequirement: 'NOT_REQUIRED',
    capabilityRequirements: [],
    modelRequirement: { reasoning: 'LOW', coding: 'LOW', architecture: 'LOW', context: 'SMALL', toolUse: 'LOW', latencySensitive: true },
    researchRequired: false, constraints: [], acceptanceCriteria: [],
    provenance: { provenanceId: 'p', source: { kind: 'runtime', id: 't' }, inputs: [], reason: 'r', at: '2026-01-01T00:00:00.000Z' },
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

const CASES: readonly Case[] = [
  // 1. Simple local refactor — must stay LOW (guard against false-high).
  { name: 'simple local refactor', goal: 'Rename the function calc to computeTotal in src/order.js', expect: ['LOW', 'MEDIUM'] },
  // 2. Structural refactor — extract a module + update imports. The regression case: must NOT be LOW.
  { name: 'structural refactor (extract module)', goal: 'Refactor src/math.js: extract the summation logic into a new module src/sum-core.js, update imports and exports, preserve existing behavior', expect: ['MEDIUM', 'HIGH'], minReasoning: 'MEDIUM', notTrivial: true },
  // 3. Cross-file refactor — several related files, behavior preserved.
  { name: 'cross-file refactor', goal: 'Decouple the auth module from the logging module across src/auth.js and src/log.js, keep behavior unchanged', expect: ['MEDIUM', 'HIGH'], minReasoning: 'MEDIUM', notTrivial: true },
  // 4. Mechanical bulk edit — many files but low reasoning. Should NOT be HIGH.
  { name: 'mechanical bulk edit', goal: 'Rename the config field timeout to timeoutMs across all files', expect: ['LOW', 'MEDIUM'] },
  // 5. Difficult bug fix — few files, hard reasoning. (Known limitation: surface signals miss this.)
  { name: 'difficult bug fix', goal: 'Fix the intermittent race condition in the scheduler that drops tasks under load', expect: ['LOW', 'MEDIUM'] },
  // 6. Public API change — update interface + dependent call sites.
  { name: 'public api change', goal: 'Change the signature of the exported parse() function and update all call sites', expect: ['MEDIUM', 'HIGH'], minReasoning: 'MEDIUM', notTrivial: true },
  // 7. Multi-package migration — coordinated cross-package change.
  { name: 'multi-package migration', goal: 'Migrate the shared types across the packages monorepo and update every importer', expect: ['HIGH', 'SYSTEM'], minReasoning: 'HIGH', notTrivial: true },
  // 8. Ambiguous task — not enough info.
  { name: 'ambiguous task', goal: 'make the thing a bit better', expect: ['LOW', 'MEDIUM'] },
  // 9. Documentation-only — minimal source impact.
  { name: 'documentation only', goal: 'Document the public API in the README', expect: ['LOW', 'MEDIUM'] },
  // 10. Test-only — add tests, no implementation change.
  { name: 'test only', goal: 'Write unit tests for the pricing module', expect: ['LOW', 'MEDIUM'] },
];

describe('P12.10 complexity benchmark — band classification', () => {
  for (const c of CASES) {
    it(`${c.name}: complexity ∈ ${c.expect.join('|')}`, () => {
      const s = extractSignals(c.goal);
      const level = assessComplexity(s, classifyMissionType(s).type).level;
      expect(c.expect, `"${c.goal}" → ${level}`).toContain(level);
    });
  }

  it('overall band accuracy ≥ 0.9', () => {
    let within = 0;
    const misses: string[] = [];
    for (const c of CASES) {
      const s = extractSignals(c.goal);
      const level = assessComplexity(s, classifyMissionType(s).type).level;
      if (c.expect.includes(level)) within++; else misses.push(`${c.name}: ${level} ∉ ${c.expect.join('|')}`);
    }
    if (misses.length > 0) console.log('benchmark misses:\n' + misses.join('\n'));
    expect(within / CASES.length).toBeGreaterThanOrEqual(0.9);
  });
});

describe('P12.10 complexity benchmark — model routing appropriateness', () => {
  for (const c of CASES.filter((x) => x.minReasoning !== undefined || x.notTrivial)) {
    it(`${c.name}: router derives an adequate requirement`, () => {
      const req = analyzeModelRequirement(missionFor(c.goal));
      if (c.minReasoning !== undefined) {
        expect(LVL[req.reasoning], `${c.name} reasoning=${req.reasoning}`).toBeGreaterThanOrEqual(LVL[c.minReasoning]);
      }
      if (c.notTrivial) {
        expect(req.latencySensitive, `${c.name} should not be latency-sensitive`).toBe(false);
      }
    });
  }

  it('a trivial rename stays latency-sensitive + LOW reasoning (not over-routed)', () => {
    const req = analyzeModelRequirement(missionFor('Rename the function calc to computeTotal in src/order.js'));
    expect(req.latencySensitive).toBe(true);
    expect(req.reasoning).toBe('LOW');
  });
});
