// MI-007 — The ArchitectureGate deterministically BLOCKs before planning when the blueprint is
// not safe to act on: a required capability is not VERIFIED, open questions remain under
// unresolved uncertainty, or verification coverage is missing. BLOCK → the caller stops and moves
// the session to AWAITING_HUMAN; the gate itself never transitions state (it only returns a
// verdict). A clean blueprint over a verified environment PASSes.
import { describe, it, expect } from 'vitest';
import {
  evaluateArchitecture,
  type Architecture,
  type Mission,
  type PreflightReport,
  type Capability,
} from '@codeforge/agent-core';

const cap = (name: string, status: Capability['status']): Capability => ({
  name, scope: 'machine', status, enables: [],
});

function preflight(machine: readonly Capability[]): PreflightReport {
  return {
    missionId: 'm-1', machine, workspace: [], aiModels: [],
    readiness: 100, blockers: [], warnings: [], createdAt: '2026-01-01T00:00:00.000Z',
  };
}

function mission(over: Partial<Mission> = {}): Mission {
  return {
    missionId: 'm-1', goalId: 'g-1', userGoal: 'x', normalizedGoal: 'x',
    missionType: 'PROJECT',
    complexity: { level: 'HIGH', confidence: 0.8, reasons: [], usedAdvisory: false },
    risk: { level: 'MEDIUM', factors: ['LOCAL_EDIT'], requiredApprovals: [], requiredVerification: [] },
    uncertainty: { level: 'KNOWN', openQuestions: [] },
    contextScope: 'REPOSITORY', planningMode: 'ARCHITECTURE_FIRST', architectureRequirement: 'REQUIRED',
    capabilityRequirements: [], modelRequirement: { reasoning: 'HIGH', coding: 'HIGH', architecture: 'HIGH', context: 'LARGE', toolUse: 'HIGH', latencySensitive: false },
    researchRequired: false, constraints: [],
    acceptanceCriteria: [{ criterionId: 'a1', description: 'it works', mandatory: true }],
    provenance: { provenanceId: 'p', source: { kind: 'runtime', id: 't' }, inputs: [], reason: 'r', at: '2026-01-01T00:00:00.000Z' },
    createdAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

function architecture(over: Partial<Architecture> = {}): Architecture {
  return {
    missionId: 'm-1',
    summary: 'ok',
    requirements: ['persist data'],
    assumptions: [],
    techChoices: ['TypeScript'],
    moduleBoundaries: [{ name: 'domain', responsibility: 'rules', dependsOn: [] }],
    folderHierarchy: ['src/domain'],
    roadmap: [{ name: 'p1', outcome: 'model', requiresCapabilities: [] }],
    verificationStrategy: ['unit tests'],
    risks: [],
    openQuestions: [],
    requiredCapabilities: ['node'],
    provenance: { provenanceId: 'p', source: { kind: 'model', id: 'mission-architect' }, inputs: [], reason: 'r', at: '2026-01-01T00:00:00.000Z' },
    createdAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

describe('MI-007 — ArchitectureGate deterministic PASS/BLOCK', () => {
  it('PASS when required capabilities are VERIFIED, no open questions, verification present', () => {
    const result = evaluateArchitecture(
      architecture({ requiredCapabilities: ['node'] }),
      mission(),
      preflight([cap('node', 'VERIFIED')]),
    );
    expect(result.verdict).toBe('PASS');
    expect(result.blockers).toEqual([]);
  });

  it('BLOCK when a required capability is NOT VERIFIED (LLM claim is never enough — MI-003)', () => {
    const result = evaluateArchitecture(
      architecture({ requiredCapabilities: ['docker'] }),
      mission(),
      preflight([cap('node', 'VERIFIED'), cap('docker', 'UNAVAILABLE')]),
    );
    expect(result.verdict).toBe('BLOCK');
    expect(result.blockers.some((b) => b.includes('docker'))).toBe(true);
  });

  it('BLOCK when a capability named only by a roadmap phase is not VERIFIED', () => {
    const result = evaluateArchitecture(
      architecture({ requiredCapabilities: [], roadmap: [{ name: 'p', outcome: 'o', requiresCapabilities: ['flutter'] }] }),
      mission(),
      preflight([cap('node', 'VERIFIED')]),
    );
    expect(result.verdict).toBe('BLOCK');
    expect(result.blockers.some((b) => b.includes('flutter'))).toBe(true);
  });

  it('BLOCK when uncertainty is unresolved AND the architecture has open questions', () => {
    const result = evaluateArchitecture(
      architecture({ requiredCapabilities: [], openQuestions: ['which database?'] }),
      mission({ uncertainty: { level: 'UNKNOWN', openQuestions: ['which database?'] } }),
      preflight([]),
    );
    expect(result.verdict).toBe('BLOCK');
    expect(result.blockers.some((b) => b.includes('which database?'))).toBe(true);
  });

  it('PASS with open questions when uncertainty is already resolved (KNOWN)', () => {
    const result = evaluateArchitecture(
      architecture({ requiredCapabilities: [], openQuestions: ['nice-to-have?'] }),
      mission({ uncertainty: { level: 'KNOWN', openQuestions: [] } }),
      preflight([]),
    );
    expect(result.verdict).toBe('PASS');
  });

  it('BLOCK when the architecture provides no verification strategy', () => {
    const result = evaluateArchitecture(
      architecture({ requiredCapabilities: [], verificationStrategy: [] }),
      mission(),
      preflight([]),
    );
    expect(result.verdict).toBe('BLOCK');
    expect(result.blockers.some((b) => b.includes('verification strategy'))).toBe(true);
  });

  it('BLOCK when acceptance criteria exist but the architecture lists no requirements', () => {
    const result = evaluateArchitecture(
      architecture({ requiredCapabilities: [], requirements: [] }),
      mission(),
      preflight([]),
    );
    expect(result.verdict).toBe('BLOCK');
    expect(result.blockers.some((b) => b.includes('requirements'))).toBe(true);
  });

  it('is deterministic (same inputs → identical result)', () => {
    const a = architecture();
    const m = mission();
    const p = preflight([cap('node', 'VERIFIED')]);
    expect(JSON.stringify(evaluateArchitecture(a, m, p))).toEqual(JSON.stringify(evaluateArchitecture(a, m, p)));
  });
});
