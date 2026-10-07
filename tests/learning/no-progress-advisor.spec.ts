// P11.5 unit — NoProgressAdvisor + combineNoProgress. Advisory only: the deterministic
// detector verdict is never changed (RC-003); combine only ATTACHES an advisory flag.
import { describe, it, expect } from 'vitest';
import {
  NoProgressAdvisor,
  combineNoProgress,
  SelfModelBuilder,
  detectNoProgress,
} from '@codeforge/agent-core';
import type { Failure, SafeNoProgressAdvice } from '@codeforge/agent-core';

function failure(id: string, cls: Failure['class'], sig: string): Failure {
  return {
    failureId: id, sessionId: 's1', taskId: 't1', taskRunId: `r-${id}`,
    stage: 'verify', class: cls, signature: sig, evidence: { message: 'x' },
    detectedAt: '2026-01-01T00:00:00.000Z', classifiedBy: 'deterministic', recoveryActionIds: [],
  };
}

function modelWithRecurrence(n: number) {
  const failures = Array.from({ length: n }, (_, i) => failure(`f${i}`, 'LOGIC', 'same-sig'));
  return new SelfModelBuilder().build({ events: [], failures, recoveryActions: [] });
}

describe('NoProgressAdvisor', () => {
  it('nudges likelyStuck when a signature recurs at/above the threshold', () => {
    const advisor = new NoProgressAdvisor({ recurrenceThreshold: 3 });
    expect(advisor.advise(modelWithRecurrence(3))).toEqual({ kind: 'no_progress', likelyStuck: true });
  });

  it('returns null below the threshold (no advice → LE-002)', () => {
    const advisor = new NoProgressAdvisor({ recurrenceThreshold: 3 });
    expect(advisor.advise(modelWithRecurrence(2))).toBeNull();
    expect(advisor.advise(modelWithRecurrence(1))).toBeNull();
  });

  it('is deterministic', () => {
    const advisor = new NoProgressAdvisor();
    const m = modelWithRecurrence(4);
    expect(JSON.stringify(advisor.advise(m))).toEqual(JSON.stringify(advisor.advise(m)));
  });
});

describe('combineNoProgress — advisory only, never flips the verdict (RC-003)', () => {
  it('null advice returns the detector result unchanged (LE-002)', () => {
    const base = detectNoProgress([failure('a', 'LOGIC', 's'), failure('b', 'LOGIC', 's')], 3);
    expect(combineNoProgress(base, null)).toEqual(base);
    expect(combineNoProgress(base, undefined)).toEqual(base);
  });

  it('attaches advisoryStuck WITHOUT changing the deterministic noProgress verdict', () => {
    // Only 2 failures, threshold 3 → detector says noProgress=false (deterministic).
    const base = detectNoProgress([failure('a', 'LOGIC', 's'), failure('b', 'LOGIC', 's')], 3);
    expect(base.noProgress).toBe(false);

    const advice: SafeNoProgressAdvice = { kind: 'no_progress', likelyStuck: true };
    const combined = combineNoProgress(base, advice);
    // The hard verdict is still false — advice cannot force a stop (RC-003).
    expect(combined.noProgress).toBe(false);
    // But the advisory hint is attached for a policy to optionally consider.
    expect(combined.advisoryStuck).toBe(true);
  });

  it('preserves a deterministic true verdict as-is', () => {
    const threeSame = [failure('a', 'LOGIC', 's'), failure('b', 'LOGIC', 's'), failure('c', 'LOGIC', 's')];
    const base = detectNoProgress(threeSame, 3);
    expect(base.noProgress).toBe(true);
    const combined = combineNoProgress(base, { kind: 'no_progress', likelyStuck: false });
    expect(combined.noProgress).toBe(true); // detector authority unchanged
    expect(combined.advisoryStuck).toBe(false);
  });
});
