// LE-003 — Learning advice chỉ được sắp xếp lại / chấm điểm TRONG một allowed-set/ranking đã
// tất định; không được thêm action, nới budget, hay tạo quyền mới.
//
// Enforced by AdviceGate: recovery advice is intersected with the policy's allowed-set
// (subset-permutation only); rerank deltas are clamped to a bound and restricted to current
// candidate paths. This test feeds the gate deliberately out-of-bounds proposals and asserts
// nothing escapes the deterministic bounds.
import { describe, it, expect } from 'vitest';
import { AdviceGate, DEFAULT_MAX_RERANK_DELTA } from '@codeforge/agent-core';
import type { RecoveryKind } from '@codeforge/agent-core';

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
