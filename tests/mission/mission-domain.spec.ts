// P12.1 — Mission domain model shape. Pure types; this pins the public contract so later
// sub-phases (intake/analyzers/gates) build on a stable shape. No behavior yet.
import { describe, it, expect } from 'vitest';
import { MISSION_VERSION } from '@codeforge/agent-core';
import type {
  Mission,
  MissionType,
  Complexity,
  RiskLevel,
  PlanningMode,
  ContextScope,
  CapabilityStatus,
  Capability,
  PreflightReport,
  ModelRequirement,
  ExpertProfile,
  Provenance,
} from '@codeforge/agent-core';

function prov(): Provenance {
  return { provenanceId: 'p', source: { kind: 'runtime', id: 'mission-builder' }, inputs: ['goal-1'], reason: 'intake', at: '2026-01-01T00:00:00.000Z' };
}

describe('P12.1 Mission domain model', () => {
  it('exposes a Mission schema version', () => {
    expect(MISSION_VERSION).toBe(1);
  });

  it('a Mission is well-typed and references a Goal without embedding it', () => {
    const mission: Mission = {
      missionId: 'm-1',
      goalId: 'goal-1',
      userGoal: 'Rename calculatePrice to calculateTotalPrice',
      normalizedGoal: 'rename symbol calculatePrice -> calculateTotalPrice',
      missionType: 'REFACTOR' satisfies MissionType,
      complexity: { level: 'LOW' satisfies Complexity, confidence: 0.9, reasons: ['single symbol rename'], usedAdvisory: false },
      risk: { level: 'LOW' satisfies RiskLevel, factors: ['LOCAL_EDIT'], requiredApprovals: [], requiredVerification: [] },
      uncertainty: { level: 'KNOWN', openQuestions: [] },
      contextScope: 'FILE' satisfies ContextScope,
      planningMode: 'DIRECT' satisfies PlanningMode,
      architectureRequirement: 'NOT_REQUIRED',
      capabilityRequirements: [],
      modelRequirement: {
        reasoning: 'LOW', coding: 'LOW', architecture: 'LOW', context: 'SMALL', toolUse: 'LOW', latencySensitive: true,
      } satisfies ModelRequirement,
      researchRequired: false,
      constraints: [],
      acceptanceCriteria: [],
      provenance: prov(),
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    // The mission carries only the goalId, never a mutable Goal object (MI-004).
    expect(mission.goalId).toBe('goal-1');
    expect('goal' in mission).toBe(false);
    // Round-trips as plain data (no behavior / methods).
    expect(JSON.parse(JSON.stringify(mission))).toEqual(mission);
  });

  it('Capability only treats VERIFIED as a usable status with evidence', () => {
    const verified: Capability = {
      name: 'flutter', scope: 'machine', status: 'VERIFIED' satisfies CapabilityStatus,
      version: '3.22.0', evidence: 'flutter --version → Flutter 3.22.0', enables: ['build_windows', 'test'],
      lastVerified: '2026-01-01T00:00:00.000Z',
    };
    const missing: Capability = { name: 'android-sdk', scope: 'machine', status: 'UNAVAILABLE', enables: [] };
    expect(verified.status).toBe('VERIFIED');
    expect(verified.evidence).toContain('flutter --version');
    expect(missing.status).toBe('UNAVAILABLE');
    expect(missing.evidence).toBeUndefined();
  });

  it('PreflightReport + ExpertProfile are plain data shapes', () => {
    const report: PreflightReport = {
      missionId: 'm-1', machine: [], workspace: [], aiModels: ['qwen2.5-coder'],
      readiness: 87, blockers: ['android-sdk'], warnings: ['Android target cannot be verified'],
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    const profile: ExpertProfile = {
      domain: 'Flutter Architecture', expertise: ['Flutter', 'Dart'], responsibilities: ['app architecture'],
      constraints: ['no secrets in code'], preferredPractices: ['Riverpod for state'],
    };
    expect(report.readiness).toBe(87);
    expect(report.blockers).toContain('android-sdk');
    expect(profile.domain).toBe('Flutter Architecture');
  });
});
