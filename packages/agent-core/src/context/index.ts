// Context module — P2-CX1 (CX-001..006, PR-002).
export { countTokens, countPromptTokens } from './token-counter.js';
export { assignTrust, isUntrustedSource } from './trust-marker.js';
export {
  ProvenanceTracker,
  type ProvenanceTrackerDeps,
  type ContextItemProvenance,
  type RetrievedBy,
} from './provenance-tracker.js';
export { Retriever, type RetrieveRequest, type RetrieverDeps } from './retriever.js';
export {
  fitToBudget,
  ContextBudgetError,
  type BudgetConfig,
  type BudgetResult,
} from './token-budgeter.js';
export {
  ContextBuilder,
  ContextBuilderError,
  DEFAULT_CONTEXT_POLICY,
  type ContextBuilderDeps,
  type BuildContextRequest,
  type ContextPolicy,
} from './context-builder.js';
