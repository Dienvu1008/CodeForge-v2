// LE-002 — Tắt lớp learning (flag off) phải cho hành vi runtime y hệt khi không có learning
// (fail-safe = default Phase 10).
//
// Enforced by AdviceGate: the "no advice" case (null/undefined/empty/degenerate) sanitizes to
// null, and a consumer treats null as "no advice" → keeps its exact deterministic default.
// This test proves the gate produces null for every no-advice shape, and that a null result
// applied to a reference recovery ordering leaves that ordering byte-identical.
import { describe, it, expect } from 'vitest';
import { AdviceGate, decide } from '@codeforge/agent-core';
import type { AdviceGateContext, RecoveryKind, SafeAdvice } from '@codeforge/agent-core';

const ALLOWED: readonly RecoveryKind[] = ['FIX', 'RETRY', 'ESCALATE'];
const CTX: AdviceGateContext = { allowedActions: ALLOWED };

/**
 * Reference consumer: how a recovery decision would ORDER its allowed actions given optional
 * advice. With null advice it must return the default allowed-set order (Phase 10 behavior).
 */
function orderedActions(safe: SafeAdvice | null): readonly RecoveryKind[] {
  if (safe === null || safe.kind !== 'recovery_order') return ALLOWED;
  return safe.order;
}

describe('LE-002 — no advice means unchanged (Phase 10) behavior', () => {
  const gate = new AdviceGate();

  it('null / undefined advice sanitizes to null', () => {
    expect(gate.sanitize(null, CTX)).toBeNull();
    expect(gate.sanitize(undefined, CTX)).toBeNull();
  });

  it('advice identical to the default order is a no-op (null)', () => {
    const safe = gate.sanitize({ kind: 'recovery_order', failureClass: 'LOGIC', order: ALLOWED }, CTX);
    expect(safe).toBeNull();
  });

  it('recovery advice with no allowed-set to clamp against is null (fail-safe)', () => {
    const safe = gate.sanitize(
      { kind: 'recovery_order', failureClass: 'LOGIC', order: ['FIX'] },
      {}, // no allowedActions in context
    );
    expect(safe).toBeNull();
  });

  it('rerank advice with nothing surviving is null', () => {
    const safe = gate.sanitize(
      { kind: 'context_rerank', deltas: { 'not/a/candidate.ts': 3 } },
      { candidatePaths: ['src/a.ts'] },
    );
    expect(safe).toBeNull();
  });

  it('a null result leaves the reference ordering identical to the default', () => {
    const withoutLearning = orderedActions(null);
    const withNullAdvice = orderedActions(gate.sanitize(null, CTX));
    expect(withNullAdvice).toEqual(withoutLearning);
    expect(withNullAdvice).toEqual(ALLOWED);
  });
});

// P11.4 — decide() parity: with no advice, decide() behaves EXACTLY as Phase 10.
describe('LE-002 — decide() is unchanged when no advice is supplied', () => {
  it('the action sequence across attempts is identical with and without an advice field', () => {
    for (const cls of ['SYNTAX', 'LOGIC', 'TOOL', 'ENVIRONMENT', 'UNKNOWN'] as const) {
      for (let i = 0; i < 4; i++) {
        const base = decide({ failureClass: cls, attemptsSoFar: i });
        const withUndefinedAdvice = decide({ failureClass: cls, attemptsSoFar: i, advice: undefined });
        expect(withUndefinedAdvice.action).toBe(base.action);
        expect(withUndefinedAdvice.reason).toBe(base.reason);
        // No "learning-advised" marker leaks into the unadvised path.
        expect(withUndefinedAdvice.reason).not.toContain('learning-advised');
      }
    }
  });
});
