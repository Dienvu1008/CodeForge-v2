// Verification module — P1.5-VR1/VR2.
// VerificationPolicy, AffectedSet, Freshness, ScopeComputer,
// VerificationEngine, CompletionGate (TI-005 northstar).
export {
  DEFAULT_VERIFICATION_POLICY,
  GRAPH_FINAL_VERIFICATION_POLICY,
  SMOKE_VERIFICATION_POLICY,
  resolvePolicy,
  type VerificationPolicy,
  type CheckDefinition,
  type ScratchZone,
  type ScopeRule,
  type PolicyResolutionContext,
} from './verification-policy.js';

export {
  computeAffectedDirect,
  computeAffectedFromChanges,
  computeAffectedClosure,
} from './affected-set.js';

export { isFresh, isUsableForCompletion, isPassing } from './freshness.js';

export {
  computeScope,
  promoteScope,
  scopeIncludes,
  type ComputeScopeInput,
} from './scope-computer.js';

export {
  VerificationEngine,
  VerificationError,
  type VerificationEngineDeps,
  type VerifyRequest,
  type CompletionCheck,
  type RevisionProvider,
} from './verification-engine.js';

export {
  CompletionGate,
  CompletionGateError,
  type CompletionGateDeps,
} from './completion-gate.js';
