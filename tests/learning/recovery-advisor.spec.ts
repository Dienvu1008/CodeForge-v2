// P11.4 unit — RecoveryAdvisor ranking + the full advisory pipeline:
//   SelfModel → RecoveryAdvisor (propose) → AdviceGate (clamp) → decide() (reorder try-order).
import { describe, it, expect } from 'vitest';
import {
  RecoveryAdvisor,
  AdviceGate,
  SelfModelBuilder,
  decide,
  DEFAULT_RECOVERY_POLICY,
} from '@codeforge/agent-core';
import type { Failure, RecoveryAction, RecoveryKind } from '@codeforge/agent-core';

function failure(id: string, cls: Failure['class'], sig: string): Failure {
  return {
    failureId: id, sessionId: 's1', taskId: `t-${id}`, taskRunId: `r-${id}`,
    stage: 'verify', class: cls, signature: sig, evidence: { message: 'x' },
    detectedAt: '2026-01-01T00:00:00.000Z', classifiedBy: 'deterministic', recoveryActionIds: [],
  };
}
function recovery(id: string, failureId: string, action: RecoveryKind, outcome: RecoveryAction['outcome']): RecoveryAction {
  return {
    actionId: id, failureId, action, reason: 'r', policyVersion: 1,
    budgetConsumed: { wallClockMs: 0, modelTokens: 0, toolCalls: 0, recoveryAttempts: 0 },
    startedAt: '2026-01-01T00:00:00.000Z', outcome,
  };
}

// Build a SelfModel where, for SYNTAX, REPLAN has a better track record than FIX.
function syntaxModel() {
  const failures = [
    failure('f1', 'SYNTAX', 'a'), failure('f2', 'SYNTAX', 'b'), failure('f3', 'SYNTAX', 'c'),
    failure('f4', 'SYNTAX', 'd'), failure('f5', 'SYNTAX', 'e'),
  ];
  const recoveries = [
    // FIX: 1/3 succeeded
    recovery('r1', 'f1', 'FIX', 'SUCCEEDED'),
    recovery('r2', 'f2', 'FIX', 'FAILED'),
    recovery('r3', 'f3', 'FIX', 'FAILED'),
    // REPLAN: 2/2 succeeded
    recovery('r4', 'f4', 'REPLAN', 'SUCCEEDED'),
    recovery('r5', 'f5', 'REPLAN', 'SUCCEEDED'),
  ];
  return new SelfModelBuilder().build({ events: [], failures, recoveryActions: recoveries });
}

describe('RecoveryAdvisor', () => {
  it('ranks actions by historical success rate (desc) for the failure class', () => {
    const advisor = new RecoveryAdvisor();
    const advice = advisor.advise(syntaxModel(), 'SYNTAX');
    expect(advice).not.toBeNull();
    // REPLAN (100%) ranked before FIX (33%).
    expect(advice!.order).toEqual(['REPLAN', 'FIX']);
    expect(advice!.failureClass).toBe('SYNTAX');
  });

  it('returns null when there is no sufficiently-sampled signal (LE-002 fail-safe)', () => {
    const advisor = new RecoveryAdvisor({ minSamples: 2 });
    const model = new SelfModelBuilder().build({
      events: [],
      failures: [failure('f1', 'LOGIC', 's')],
      recoveryActions: [recovery('r1', 'f1', 'FIX', 'SUCCEEDED')], // only 1 sample < minSamples
    });
    expect(advisor.advise(model, 'LOGIC')).toBeNull();
    expect(advisor.advise(model, 'SYNTAX')).toBeNull(); // no data at all
  });

  it('is deterministic (pure function of the model + class)', () => {
    const advisor = new RecoveryAdvisor();
    const m = syntaxModel();
    expect(JSON.stringify(advisor.advise(m, 'SYNTAX'))).toEqual(JSON.stringify(advisor.advise(m, 'SYNTAX')));
  });
});

describe('full pipeline — SelfModel → advisor → gate → decide', () => {
  it('reorders the SYNTAX try-order to prefer REPLAN, within the allowed-set', () => {
    const advisor = new RecoveryAdvisor();
    const gate = new AdviceGate();

    const raw = advisor.advise(syntaxModel(), 'SYNTAX');
    const safe = gate.sanitize(raw!, { allowedActions: DEFAULT_RECOVERY_POLICY.SYNTAX.actions });
    // SYNTAX default is ['FIX','REPLAN','ESCALATE']; advice (['REPLAN','FIX']) is a real reorder.
    expect(safe).not.toBeNull();
    if (safe === null || safe.kind !== 'recovery_order') throw new Error('expected recovery_order');

    // First attempt now tries REPLAN (advised) instead of the default FIX.
    const first = decide({ failureClass: 'SYNTAX', attemptsSoFar: 0, advice: safe });
    expect(first.action).toBe('REPLAN');
    expect(first.reason).toContain('learning-advised');

    // The set over all attempts is still exactly the policy's set — nothing added/dropped.
    const reachable = new Set<RecoveryKind>();
    for (let i = 0; i < DEFAULT_RECOVERY_POLICY.SYNTAX.maxAttempts; i++) {
      reachable.add(decide({ failureClass: 'SYNTAX', attemptsSoFar: i, advice: safe }).action);
    }
    expect([...reachable].sort()).toEqual([...DEFAULT_RECOVERY_POLICY.SYNTAX.actions].sort());
  });

  it('with no advice, decide() keeps the exact Phase 10 order', () => {
    expect(decide({ failureClass: 'SYNTAX', attemptsSoFar: 0 }).action).toBe('FIX');
    expect(decide({ failureClass: 'SYNTAX', attemptsSoFar: 1 }).action).toBe('REPLAN');
    expect(decide({ failureClass: 'SYNTAX', attemptsSoFar: 2 }).action).toBe('ESCALATE');
  });
});
