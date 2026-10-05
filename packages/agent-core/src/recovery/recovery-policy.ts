// RecoveryPolicy — P5-RP1. Deterministic action selection for a given FailureClass.
//
// Enforces:
//   RC-001: action must be in the allowed set for the failure class.
//   RC-002: UNKNOWN failures are not retried (maxAttempts=1 → only ESCALATE).
//   RC-004: ROLLBACK only when policy explicitly allows it.
//   RC-008: recovery cannot proceed if budget is exhausted.
//
// Pure + deterministic: decide() is a total function of (class, history, budget).
// No LLM, no wall-clock, no side effects.
import type { FailureClass, RecoveryKind } from '../domain/failure.js';
import type { Budget } from '../domain/budget.js';
import { recoveryExhausted } from '../budget/budget-engine.js';

// ── RecoveryRules ─────────────────────────────────────────────────────────────

export interface RecoveryRule {
  /** Ordered list of actions to try (first attempt = index 0). */
  readonly actions:     readonly RecoveryKind[];
  /** Max total attempts (across all action kinds) before forcing ESCALATE. */
  readonly maxAttempts: number;
  /** Whether ROLLBACK is allowed for this class (RC-004). */
  readonly rollbackAllowed: boolean;
}

/** Full policy: maps every FailureClass to a RecoveryRule. */
export type RecoveryPolicyConfig = Readonly<Record<FailureClass, RecoveryRule>>;

// ── Default policy ────────────────────────────────────────────────────────────

/**
 * Default Phase 5 recovery policy.
 *
 * Decision table:
 *   SYNTAX (BUILD_ERROR/tsc)  → FIX (LLM fixes the code), then REPLAN if FIX fails,
 *                               then ESCALATE. Max 3 attempts.
 *   LOGIC (TEST_FAIL)         → FIX, then RETRY (maybe flaky), then ESCALATE. Max 3.
 *   TOOL (LINT)               → FIX (auto-fix), then ESCALATE. Max 2.
 *   ENVIRONMENT               → RETRY (transient), then ESCALATE. Max 2.
 *   TRANSIENT                 → RETRY, then ESCALATE. Max 2.
 *   DEPENDENCY                → REPLAN (task deps may need adjustment), then ESCALATE. Max 2.
 *   TIMEOUT                   → RETRY once (maybe slow), then ESCALATE. Max 2.
 *   UNKNOWN                   → ESCALATE immediately (RC-002: no unbounded retry). Max 1.
 *   BUDGET_EXHAUSTED          → ESCALATE only. Max 1.
 *   MODEL_* errors            → RETRY once, then ESCALATE. Max 2.
 */
export const DEFAULT_RECOVERY_POLICY: RecoveryPolicyConfig = {
  SYNTAX:                  { actions: ['FIX', 'REPLAN', 'ESCALATE'], maxAttempts: 3, rollbackAllowed: false },
  LOGIC:                   { actions: ['FIX', 'RETRY', 'ESCALATE'], maxAttempts: 3, rollbackAllowed: false },
  TOOL:                    { actions: ['FIX', 'ESCALATE'], maxAttempts: 2, rollbackAllowed: false },
  ENVIRONMENT:             { actions: ['RETRY', 'ESCALATE'], maxAttempts: 2, rollbackAllowed: false },
  TRANSIENT:               { actions: ['RETRY', 'ESCALATE'], maxAttempts: 2, rollbackAllowed: false },
  DEPENDENCY:              { actions: ['REPLAN', 'ESCALATE'], maxAttempts: 2, rollbackAllowed: false },
  TIMEOUT:                 { actions: ['RETRY', 'ESCALATE'], maxAttempts: 2, rollbackAllowed: false },
  CONTEXT:                 { actions: ['RETRY', 'ESCALATE'], maxAttempts: 2, rollbackAllowed: false },
  UNKNOWN:                 { actions: ['ESCALATE'], maxAttempts: 1, rollbackAllowed: false },
  BUDGET_EXHAUSTED:        { actions: ['ESCALATE'], maxAttempts: 1, rollbackAllowed: false },
  MODEL_OUTPUT_INVALID:    { actions: ['RETRY', 'ESCALATE'], maxAttempts: 2, rollbackAllowed: false },
  MODEL_TIMEOUT:           { actions: ['RETRY', 'ESCALATE'], maxAttempts: 2, rollbackAllowed: false },
  MODEL_UNAVAILABLE:       { actions: ['RETRY', 'ESCALATE'], maxAttempts: 2, rollbackAllowed: false },
  MODEL_CONTEXT_OVERFLOW:  { actions: ['REPLAN', 'ESCALATE'], maxAttempts: 2, rollbackAllowed: false },
  MODEL_TOOL_CALL_INVALID: { actions: ['FIX', 'ESCALATE'], maxAttempts: 2, rollbackAllowed: false },
  PERMISSION:              { actions: ['ESCALATE'], maxAttempts: 1, rollbackAllowed: false },
};

// ── DecisionInput ─────────────────────────────────────────────────────────────

export interface DecisionInput {
  /** Failure class being decided on. */
  readonly failureClass:   FailureClass;
  /**
   * Number of recovery attempts already made for this task in this session.
   * Includes both the current failure and prior ones.
   */
  readonly attemptsSoFar:  number;
  /**
   * Current session-level budget. When recoveryAttempts is exhausted → ESCALATE (RC-008).
   */
  readonly budget?: Budget | undefined;
  /** Override the default policy (for testing or per-session config). */
  readonly policy?: RecoveryPolicyConfig | undefined;
}

// ── DecisionResult ────────────────────────────────────────────────────────────

export interface DecisionResult {
  /** The chosen recovery action. */
  readonly action:  RecoveryKind;
  /** Policy version (for binding in RecoveryAction record — RC-006). */
  readonly policyVersion: number;
  /** Why this action was chosen. */
  readonly reason:  string;
}

/** Current policy version (bump when DEFAULT_RECOVERY_POLICY changes). */
export const RECOVERY_POLICY_VERSION = 1;

// ── decide ────────────────────────────────────────────────────────────────────

/**
 * Choose the next recovery action (RC-001: must be in allowed set).
 * Always resolves — never throws. Worst case returns ESCALATE.
 */
export function decide(input: DecisionInput): DecisionResult {
  const policy    = input.policy ?? DEFAULT_RECOVERY_POLICY;
  const rule      = policy[input.failureClass];
  const policyVersion = RECOVERY_POLICY_VERSION;

  // RC-008: budget check first — if recovery budget is exhausted → ESCALATE.
  if (input.budget !== undefined && recoveryExhausted(input.budget)) {
    return {
      action: 'ESCALATE',
      policyVersion,
      reason: 'Recovery budget exhausted (RC-008)',
    };
  }

  // RC-002: if max attempts reached → ESCALATE.
  if (input.attemptsSoFar >= rule.maxAttempts) {
    return {
      action: 'ESCALATE',
      policyVersion,
      reason: `Max attempts (${rule.maxAttempts}) reached for class ${input.failureClass} (RC-002)`,
    };
  }

  // RC-001: pick the next action in the ordered list (by attemptsSoFar index).
  const actionIndex = Math.min(input.attemptsSoFar, rule.actions.length - 1);
  const action      = rule.actions[actionIndex] ?? 'ESCALATE';

  // RC-004: ROLLBACK guard — if policy says rollbackAllowed=false, skip to next.
  if (action === 'ROLLBACK' && !rule.rollbackAllowed) {
    const fallback = rule.actions[actionIndex + 1] ?? 'ESCALATE';
    return {
      action: fallback,
      policyVersion,
      reason: `ROLLBACK not allowed for class ${input.failureClass} (RC-004); using ${fallback}`,
    };
  }

  return {
    action,
    policyVersion,
    reason: `Attempt ${input.attemptsSoFar + 1}/${rule.maxAttempts} for class ${input.failureClass}`,
  };
}