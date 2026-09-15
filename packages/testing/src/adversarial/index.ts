// AdversarialModel (C8) — interface + 7 variants (AM-1..AM-8).
export type { AdversarialModel, AdversaryId, AttackVector } from './types.js';
export {
  MaliciousPlanner,
  MaliciousReplanner,
  MaliciousVerifier,
  MaliciousToolProposal,
  MaliciousFailureAnalyzer,
  PromptInjectionContent,
  CombinedAttack,
  ADVERSARY_VARIANTS,
  createAllAdversaries,
} from './variants.js';
