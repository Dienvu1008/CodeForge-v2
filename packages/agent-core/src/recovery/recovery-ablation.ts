/*
 * Copyright 2026 DienVu (Dienvu1008)
 * SPDX-License-Identifier: Apache-2.0
 */

// recovery-ablation.ts (P12.33) — PURE, DETERMINISTIC policy transforms for ablation studies.
//
// Ablation is the diagnostic tool from .agents/failure-taxonomy.md: run the SAME benchmark case
// with a governance capability removed, and see whether the failure changes. If a case PASSES
// with recovery on but FAILS with it off, the recovery loop was carrying it → the failure (when
// recovery is off) is MODEL_CAPABILITY masked by governance. If it FAILS both ways, recovery was
// never the deciding factor.
//
// These transforms take a RecoveryPolicyConfig and return a new one with a capability removed.
// They are PURE (no I/O, no mutation of the input) so they are trivially testable and the runner
// can compose them. Removing a capability can never ADD an action or relax a guard — it only
// narrows the allowed set, which is always safe (a narrower policy escalates sooner).
//
// NOTE: fully disabling recovery (no FailureAnalyzer/RecoveryEngine wired at all) is done by the
// runner, not here — that is a wiring choice, not a policy transform. These transforms cover the
// finer-grained ablations: remove REPLAN, remove ROLLBACK, remove FIX, remove RETRY.
import type { FailureClass, RecoveryKind } from '../domain/failure.js';
import type { RecoveryPolicyConfig, RecoveryRule } from './recovery-policy.js';

/**
 * Remove a single RecoveryKind from every class's action list. If removing it would leave a class
 * with no actions, ESCALATE is kept as the floor (a class must always be able to escalate — RC-007
 * — so recovery never silently does nothing). ROLLBACK removal also clears rollbackAllowed.
 * Pure: returns a new config; the input is untouched.
 */
export function removeRecoveryAction(
  policy: RecoveryPolicyConfig,
  kind: RecoveryKind,
): RecoveryPolicyConfig {
  const out = {} as Record<FailureClass, RecoveryRule>;
  for (const cls of Object.keys(policy) as FailureClass[]) {
    const rule = policy[cls];
    const filtered = rule.actions.filter((a) => a !== kind);
    // Never leave an empty action list — ESCALATE is the guaranteed floor (RC-007).
    const actions = filtered.length > 0 ? filtered : (['ESCALATE'] as RecoveryKind[]);
    out[cls] = {
      actions,
      maxAttempts: rule.maxAttempts,
      // Removing ROLLBACK also revokes the rollbackAllowed flag so decide() can never emit it.
      rollbackAllowed: kind === 'ROLLBACK' ? false : rule.rollbackAllowed,
    };
  }
  return out;
}

/** Remove REPLAN everywhere (ablate the lightweight re-plan / SUPERSEDE path). Pure. */
export function withoutReplan(policy: RecoveryPolicyConfig): RecoveryPolicyConfig {
  return removeRecoveryAction(policy, 'REPLAN');
}

/** Remove ROLLBACK everywhere + clear rollbackAllowed (ablate workspace revert). Pure. */
export function withoutRollback(policy: RecoveryPolicyConfig): RecoveryPolicyConfig {
  return removeRecoveryAction(policy, 'ROLLBACK');
}

/** Remove FIX everywhere (ablate the re-prompt-with-evidence path). Pure. */
export function withoutFix(policy: RecoveryPolicyConfig): RecoveryPolicyConfig {
  return removeRecoveryAction(policy, 'FIX');
}

/** Remove RETRY everywhere (ablate the plain re-run path). Pure. */
export function withoutRetry(policy: RecoveryPolicyConfig): RecoveryPolicyConfig {
  return removeRecoveryAction(policy, 'RETRY');
}

/** The set of ablation names the runner understands. */
export type AblationName = 'no-replan' | 'no-rollback' | 'no-fix' | 'no-retry';

/**
 * Apply a named list of policy ablations in order. Unknown names are ignored (the caller validates
 * CLI input separately). 'no-recovery' is NOT handled here — it is a wiring-level ablation the
 * runner applies by not wiring the recovery stack at all.
 */
export function applyAblations(
  policy: RecoveryPolicyConfig,
  ablations: readonly AblationName[],
): RecoveryPolicyConfig {
  let out = policy;
  for (const a of ablations) {
    if (a === 'no-replan') out = withoutReplan(out);
    else if (a === 'no-rollback') out = withoutRollback(out);
    else if (a === 'no-fix') out = withoutFix(out);
    else if (a === 'no-retry') out = withoutRetry(out);
  }
  return out;
}
