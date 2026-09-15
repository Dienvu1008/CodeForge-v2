// C8 — AdversarialModel acceptance (PHASE_0_ACCEPTANCE §3.11, §6.1, AM-1..AM-10).
//
// Phase 0 scope: verify the interface + 7 variants exist and each emits its declared
// malicious payloads with target invariants. Running them against a live runtime to prove
// blocking is the Phase 1.5 harness (INVARIANTS §7).
import { describe, it, expect } from 'vitest';
import {
  MaliciousPlanner,
  MaliciousReplanner,
  MaliciousVerifier,
  MaliciousToolProposal,
  MaliciousFailureAnalyzer,
  PromptInjectionContent,
  CombinedAttack,
  createAllAdversaries,
  type AdversarialModel,
} from '@codeforge/testing';
import type { ModelRequest } from '@codeforge/agent-core';

// Minimum attack counts per PHASE_0_ACCEPTANCE §6.1.
const MIN_ATTACKS: Record<string, number> = {
  MaliciousPlanner: 3,
  MaliciousReplanner: 3,
  MaliciousVerifier: 3,
  MaliciousToolProposal: 5,
  MaliciousFailureAnalyzer: 2,
  PromptInjectionContent: 3,
  CombinedAttack: 2,
};

function req(): ModelRequest {
  return { purpose: 'plan', systemPrompt: 's', taskPrompt: 't', maxOutputTokens: 100, temperature: 0 };
}

describe('AM-1: AdversarialModel interface + registry', () => {
  it('exposes exactly 7 variants', () => {
    const all = createAllAdversaries();
    expect(all).toHaveLength(7);
    const ids = all.map((a) => a.adversaryId).sort();
    expect(ids).toEqual(
      [
        'CombinedAttack',
        'MaliciousFailureAnalyzer',
        'MaliciousPlanner',
        'MaliciousReplanner',
        'MaliciousToolProposal',
        'MaliciousVerifier',
        'PromptInjectionContent',
      ].sort(),
    );
  });
});

describe('AM-2..AM-8: variants exist with required attack counts', () => {
  const variants: AdversarialModel[] = [
    new MaliciousPlanner(),
    new MaliciousReplanner(),
    new MaliciousVerifier(),
    new MaliciousToolProposal(),
    new MaliciousFailureAnalyzer(),
    new PromptInjectionContent(),
    new CombinedAttack(),
  ];

  for (const v of variants) {
    it(`${v.adversaryId} declares >= ${MIN_ATTACKS[v.adversaryId]} attacks`, () => {
      const min = MIN_ATTACKS[v.adversaryId] ?? 1;
      expect(v.attacks().length).toBeGreaterThanOrEqual(min);
    });

    it(`${v.adversaryId}: every attack has payload + target invariants + expected block point`, () => {
      for (const a of v.attacks()) {
        expect(a.id.length).toBeGreaterThan(0);
        expect(a.payload.length).toBeGreaterThan(0);
        expect(a.targetInvariants.length).toBeGreaterThan(0);
        // invariant IDs look like SE-001, VR-005, ...
        for (const inv of a.targetInvariants) {
          expect(inv).toMatch(/^[A-Z]{2}-\d{3}$/);
        }
        expect(a.expectedBlockedBy.length).toBeGreaterThan(0);
      }
    });
  }
});

describe('AM-9: adversary can be armed to emit malicious payloads via the gateway', () => {
  it('arm() makes generate() return the declared attack payloads in order', async () => {
    const adv = new MaliciousToolProposal().arm();
    const first = adv.attacks()[0]!;
    const out = await adv.generate(req());
    expect(out.raw).toBe(first.payload);
  });

  it('is still a ModelGateway (identity present)', () => {
    const adv = new MaliciousPlanner();
    expect(adv.identity.name).toBe('fake-model');
  });
});

describe('AM-10 (Phase 0 shape): each attack maps to at least one runtime invariant', () => {
  it('collected target invariants are non-empty and well-formed', () => {
    const invariants = new Set<string>();
    for (const adv of createAllAdversaries()) {
      for (const a of adv.attacks()) {
        for (const inv of a.targetInvariants) invariants.add(inv);
      }
    }
    // Sanity: covers the headline security/verification/tool/recovery invariants.
    expect(invariants.has('SE-001')).toBe(true);
    expect(invariants.has('SE-002')).toBe(true);
    expect(invariants.has('VR-001')).toBe(true);
    expect(invariants.has('TG-007')).toBe(true);
    expect(invariants.has('RC-002')).toBe(true);
  });
});
