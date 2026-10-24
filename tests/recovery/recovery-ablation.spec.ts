// recovery-ablation (P12.33) — pure policy transforms for diagnostic ablation studies.
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_RECOVERY_POLICY, decide,
  removeRecoveryAction, withoutReplan, withoutRollback, withoutFix, withoutRetry, applyAblations,
} from '@codeforge/agent-core';
import type { FailureClass } from '@codeforge/agent-core';

const ALL_CLASSES: FailureClass[] = [
  'TRANSIENT', 'DEPENDENCY', 'SYNTAX', 'LOGIC', 'ENVIRONMENT', 'TOOL', 'PERMISSION', 'TIMEOUT',
  'CONTEXT', 'BUDGET_EXHAUSTED', 'MODEL_OUTPUT_INVALID', 'MODEL_TIMEOUT', 'MODEL_UNAVAILABLE',
  'MODEL_CONTEXT_OVERFLOW', 'MODEL_TOOL_CALL_INVALID', 'UNKNOWN',
];

describe('removeRecoveryAction — purity + invariants', () => {
  it('does not mutate the input policy', () => {
    const before = JSON.stringify(DEFAULT_RECOVERY_POLICY);
    removeRecoveryAction(DEFAULT_RECOVERY_POLICY, 'REPLAN');
    expect(JSON.stringify(DEFAULT_RECOVERY_POLICY)).toBe(before);
  });

  it('never leaves a class with an empty action list (ESCALATE floor, RC-007)', () => {
    // Remove every non-ESCALATE kind; every class must still have at least ESCALATE.
    let p = DEFAULT_RECOVERY_POLICY;
    for (const k of ['FIX', 'RETRY', 'REPLAN', 'ROLLBACK', 'SPLIT', 'REPLACE', 'ABORT'] as const) {
      p = removeRecoveryAction(p, k);
    }
    for (const cls of ALL_CLASSES) {
      expect(p[cls].actions.length).toBeGreaterThanOrEqual(1);
      expect(p[cls].actions).toContain('ESCALATE');
    }
  });
});

describe('withoutReplan', () => {
  it('removes REPLAN from every class', () => {
    const p = withoutReplan(DEFAULT_RECOVERY_POLICY);
    for (const cls of ALL_CLASSES) expect(p[cls].actions).not.toContain('REPLAN');
  });

  it('a DEPENDENCY failure no longer decides REPLAN (falls through to ESCALATE)', () => {
    // DEFAULT: DEPENDENCY → [REPLAN, ESCALATE]. Without REPLAN → [ESCALATE].
    const base = decide({ failureClass: 'DEPENDENCY', attemptsSoFar: 0 });
    expect(base.action).toBe('REPLAN');
    const ablated = decide({ failureClass: 'DEPENDENCY', attemptsSoFar: 0, policy: withoutReplan(DEFAULT_RECOVERY_POLICY) });
    expect(ablated.action).toBe('ESCALATE');
  });
});

describe('withoutRollback', () => {
  it('removes ROLLBACK and clears rollbackAllowed everywhere', () => {
    const p = withoutRollback(DEFAULT_RECOVERY_POLICY);
    for (const cls of ALL_CLASSES) {
      expect(p[cls].actions).not.toContain('ROLLBACK');
      expect(p[cls].rollbackAllowed).toBe(false);
    }
  });

  it('SYNTAX no longer reaches ROLLBACK (FIX → ESCALATE after FIX exhausts)', () => {
    const p = withoutRollback(DEFAULT_RECOVERY_POLICY);
    // SYNTAX default: [FIX, ROLLBACK, ESCALATE]; without ROLLBACK → [FIX, ESCALATE].
    expect(p.SYNTAX.actions).toEqual(['FIX', 'ESCALATE']);
    const second = decide({ failureClass: 'SYNTAX', attemptsSoFar: 1, policy: p });
    expect(second.action).not.toBe('ROLLBACK');
  });
});

describe('withoutFix / withoutRetry', () => {
  it('withoutFix removes FIX from every class', () => {
    const p = withoutFix(DEFAULT_RECOVERY_POLICY);
    for (const cls of ALL_CLASSES) expect(p[cls].actions).not.toContain('FIX');
  });
  it('withoutRetry removes RETRY from every class', () => {
    const p = withoutRetry(DEFAULT_RECOVERY_POLICY);
    for (const cls of ALL_CLASSES) expect(p[cls].actions).not.toContain('RETRY');
  });
});

describe('applyAblations', () => {
  it('composes multiple ablations in order', () => {
    const p = applyAblations(DEFAULT_RECOVERY_POLICY, ['no-replan', 'no-rollback']);
    for (const cls of ALL_CLASSES) {
      expect(p[cls].actions).not.toContain('REPLAN');
      expect(p[cls].actions).not.toContain('ROLLBACK');
      expect(p[cls].rollbackAllowed).toBe(false);
    }
  });

  it('is identity for an empty ablation list', () => {
    const p = applyAblations(DEFAULT_RECOVERY_POLICY, []);
    expect(JSON.stringify(p)).toBe(JSON.stringify(DEFAULT_RECOVERY_POLICY));
  });

  it('preserves maxAttempts (ablation narrows actions, not the attempt budget)', () => {
    const p = applyAblations(DEFAULT_RECOVERY_POLICY, ['no-fix']);
    for (const cls of ALL_CLASSES) {
      expect(p[cls].maxAttempts).toBe(DEFAULT_RECOVERY_POLICY[cls].maxAttempts);
    }
  });
});
