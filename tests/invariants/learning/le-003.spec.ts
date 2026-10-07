// LE-003 — Learning advice chỉ được sắp xếp lại / chấm điểm TRONG một allowed-set/ranking đã
// tất định; không được thêm action, nới budget, hay tạo quyền mới.
//
// Enforced by AdviceGate: recovery advice is intersected with the policy's allowed-set
// (subset-permutation only); rerank deltas are clamped to a bound and restricted to current
// candidate paths. This test feeds the gate deliberately out-of-bounds proposals and asserts
// nothing escapes the deterministic bounds.
import { describe, it, expect } from 'vitest';
import { AdviceGate, DEFAULT_MAX_RERANK_DELTA, decide, DEFAULT_RECOVERY_POLICY } from '@codeforge/agent-core';
import type { RecoveryKind, SafeRecoveryOrderAdvice } from '@codeforge/agent-core';

const ALLOWED: readonly RecoveryKind[] = ['FIX', 'RETRY', 'ESCALATE'];

describe('LE-003 — advice may only reorder/score within the allowed-set', () => {
  const gate = new AdviceGate();

  it('drops recovery actions not in the allowed-set (cannot ADD an action)', () => {
    const safe = gate.sanitize(
      // ROLLBACK + ABORT are NOT in the allowed-set — advisor must not be able to inject them.
      { kind: 'recovery_order', failureClass: 'SYNTAX', order: ['ROLLBACK', 'FIX', 'ABORT', 'RETRY'] },
      { allowedActions: ALLOWED },
    );
    expect(safe).not.toBeNull();
    if (safe !== null && safe.kind === 'recovery_order') {
      // Only allowed actions survive, in the proposed order; the result is a subset of ALLOWED.
      expect(safe.order).toEqual(['FIX', 'RETRY']);
      for (const a of safe.order) expect(ALLOWED).toContain(a);
    }
  });

  it('de-duplicates and never produces a superset of the allowed-set', () => {
    const safe = gate.sanitize(
      { kind: 'recovery_order', failureClass: 'LOGIC', order: ['RETRY', 'RETRY', 'FIX', 'RETRY'] },
      { allowedActions: ALLOWED },
    );
    if (safe !== null && safe.kind === 'recovery_order') {
      expect(safe.order).toEqual(['RETRY', 'FIX']);
      expect(safe.order.length).toBeLessThanOrEqual(ALLOWED.length);
    }
  });

  it('clamps rerank deltas to the bound (cannot apply an arbitrarily large score)', () => {
    const safe = gate.sanitize(
      { kind: 'context_rerank', deltas: { 'src/a.ts': 9999, 'src/b.ts': -9999 } },
      { candidatePaths: ['src/a.ts', 'src/b.ts'], maxRerankDelta: 5 },
    );
    expect(safe).not.toBeNull();
    if (safe !== null && safe.kind === 'context_rerank') {
      expect(safe.deltas['src/a.ts']).toBe(5);
      expect(safe.deltas['src/b.ts']).toBe(-5);
      expect(safe.maxDelta).toBe(5);
    }
  });

  it('drops rerank paths outside the current candidate set (cannot ADD a candidate)', () => {
    const safe = gate.sanitize(
      { kind: 'context_rerank', deltas: { 'src/real.ts': 3, 'etc/passwd': 10, 'invented.ts': 2 } },
      { candidatePaths: ['src/real.ts'] },
    );
    if (safe !== null && safe.kind === 'context_rerank') {
      expect(Object.keys(safe.deltas)).toEqual(['src/real.ts']);
      expect(safe.deltas['etc/passwd']).toBeUndefined();
    }
  });

  it('uses the default bound when none is supplied', () => {
    const safe = gate.sanitize(
      { kind: 'context_rerank', deltas: { 'src/a.ts': 1e9 } },
      { candidatePaths: ['src/a.ts'] },
    );
    if (safe !== null && safe.kind === 'context_rerank') {
      expect(safe.deltas['src/a.ts']).toBe(DEFAULT_MAX_RERANK_DELTA);
    }
  });
});

// P11.4 — advice reaching decide() may reorder the try-order but NEVER the set, count, or
// maxAttempts. The reachable action set over all attempts must equal the policy's own set.
describe('LE-003 — advised decide() preserves the allowed-set and bounds', () => {
  // SYNTAX default: ['FIX','REPLAN','ESCALATE'], maxAttempts 3.
  const RULE = DEFAULT_RECOVERY_POLICY.SYNTAX;
  // Advice reorders ESCALATE first — the clamp against rule.actions must still preserve the set.
  const advice: SafeRecoveryOrderAdvice = { kind: 'recovery_order', failureClass: 'SYNTAX', order: ['ESCALATE', 'REPLAN', 'FIX'] };

  it('the set of actions reachable with advice equals the default set (no add/drop)', () => {
    const reachable = new Set<RecoveryKind>();
    for (let i = 0; i < RULE.maxAttempts; i++) {
      reachable.add(decide({ failureClass: 'SYNTAX', attemptsSoFar: i, advice }).action);
    }
    expect([...reachable].sort()).toEqual([...RULE.actions].sort());
  });

  it('maxAttempts is unchanged: past the bound still ESCALATEs even with advice', () => {
    const r = decide({ failureClass: 'SYNTAX', attemptsSoFar: RULE.maxAttempts, advice });
    expect(r.action).toBe('ESCALATE');
    expect(r.reason).toContain('Max attempts');
  });

  it('advice that names only out-of-rule actions is ignored (set unchanged)', () => {
    const bogus: SafeRecoveryOrderAdvice = { kind: 'recovery_order', failureClass: 'SYNTAX', order: ['ROLLBACK', 'ABORT'] as RecoveryKind[] };
    const a0 = decide({ failureClass: 'SYNTAX', attemptsSoFar: 0, advice: bogus }).action;
    // Falls back to the default first action (FIX) — bogus advice changed nothing.
    expect(a0).toBe(RULE.actions[0]);
  });
});
