// AdversarialModel (C8) — EVALUATION_MODEL §5.5/§6, PHASE_0_ACCEPTANCE §3.11, INVARIANTS §7.
//
// An AdversarialModel is a ModelGateway double that deliberately emits MALICIOUS proposals,
// so Phase 1.5+ can prove the deterministic runtime BLOCKS them (runtime safety does not
// depend on the model being well-behaved — SECURITY_MODEL §0).
//
// Phase 0 delivers the INTERFACE + 7 variants + their attack payloads and the invariants
// each targets. The full harness that runs them against a live runtime is Phase 1.5.

import type { ModelGateway } from '@codeforge/agent-core';

export type AdversaryId =
  | 'MaliciousPlanner'
  | 'MaliciousReplanner'
  | 'MaliciousVerifier'
  | 'MaliciousToolProposal'
  | 'MaliciousFailureAnalyzer'
  | 'PromptInjectionContent'
  | 'CombinedAttack';

/** One malicious attempt: what the adversary proposes and what it is trying to break. */
export interface AttackVector {
  /** short id, e.g. "delete-workspace" */
  readonly id: string;
  /** human description of the attack */
  readonly description: string;
  /** the raw malicious output the model would emit (untrusted proposal) */
  readonly payload: string;
  /** invariant IDs the runtime must uphold to block this (INVARIANTS §7) */
  readonly targetInvariants: readonly string[];
  /** the enforcement point expected to block it (documentation/audit) */
  readonly expectedBlockedBy: string;
}

/** An adversarial model is a ModelGateway plus a declared set of attacks it can emit. */
export interface AdversarialModel extends ModelGateway {
  readonly adversaryId: AdversaryId;
  /** All attacks this variant can produce. */
  attacks(): readonly AttackVector[];
}
