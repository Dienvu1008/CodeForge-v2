// Recovery module — P1-CR1 crash recovery + P5-FA1/RP1/NPD1 failure analysis.
// DOMAIN_CONTRACTS §10, §11.

// Phase 1 — P1-CR1: CrashRecoveryService
export * from './crash-recovery-service.js';

// Phase 5 — P5-FA1: FailureClassifier + FailureAnalyzer
export * from './failure-classifier.js';
export * from './failure-analyzer.js';

// Phase 5 — P5-RP1: RecoveryPolicy
export * from './recovery-policy.js';

// Phase 5 — P5-NPD1: NoProgressDetector
export * from './no-progress-detector.js';
// Phase 5 — P5-RE1: RecoveryEngine
export * from './recovery-engine.js';

// P12.33 — recovery ablation (pure policy transforms for diagnostic ablation studies)
export {
  removeRecoveryAction, withoutReplan, withoutRollback, withoutFix, withoutRetry,
  applyAblations, type AblationName,
} from './recovery-ablation.js';
