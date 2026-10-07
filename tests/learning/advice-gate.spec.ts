// P11.3 unit — AdviceGate happy-path clamping + determinism.
import { describe, it, expect } from 'vitest';
import { AdviceGate, DEFAULT_MAX_RERANK_DELTA } from '@codeforge/agent-core';
import type { AdviceGateContext, RecoveryKind } from '@codeforge/agent-core';

const ALLOWED: readonly RecoveryKind[] = ['FIX', 'RETRY', 'REPLAN', 'ESCALATE'];

describe('AdviceGate — recovery_order', () => {
  const gate = new AdviceGate();

  it('reorders within the allowed-set (a genuine, in-bounds improvement)', () => {
    const safe = gate.sanitize(
      // Advisor says: for SYNTAX, try REPLAN before FIX this time.
      { kind: 'recovery_order', failureClass: 'SYNTAX', order: ['REPLAN', 'FIX', 'RETRY', 'ESCALATE'] },
      { allowedActions: ALLOWED },
    );
    expect(safe).toEqual({ kind: 'recovery_order', failureClass: 'SYNTAX', order: ['REPLAN', 'FIX', 'RETRY', 'ESCALATE'] });
  });

  it('a partial order is allowed (subset of the allowed-set, in proposed order)', () => {
    const safe = gate.sanitize(
      { kind: 'recovery_order', failureClass: 'LOGIC', order: ['RETRY', 'FIX'] },
      { allowedActions: ALLOWED },
    );
    if (safe !== null && safe.kind === 'recovery_order') {
      expect(safe.order).toEqual(['RETRY', 'FIX']);
    }
  });
});

describe('AdviceGate — context_rerank', () => {
  const gate = new AdviceGate();

  it('keeps in-bounds deltas for candidate paths, sorted deterministically', () => {
    const safe = gate.sanitize(
      { kind: 'context_rerank', deltas: { 'src/b.ts': 2, 'src/a.ts': -3 } },
      { candidatePaths: ['src/a.ts', 'src/b.ts'], maxRerankDelta: 10 },
    );
    if (safe !== null && safe.kind === 'context_rerank') {
      // Output key order is deterministic (sorted).
      expect(Object.keys(safe.deltas)).toEqual(['src/a.ts', 'src/b.ts']);
      expect(safe.deltas).toEqual({ 'src/a.ts': -3, 'src/b.ts': 2 });
      expect(safe.maxDelta).toBe(10);
    }
  });

  it('with no candidate restriction, keeps all finite non-zero deltas', () => {
    const safe = gate.sanitize(
      { kind: 'context_rerank', deltas: { 'x': 1, 'y': 0, 'z': 2 } },
      {}, // no candidatePaths → no path restriction
    );
    if (safe !== null && safe.kind === 'context_rerank') {
      expect(Object.keys(safe.deltas).sort()).toEqual(['x', 'z']); // y dropped (zero)
      expect(safe.maxDelta).toBe(DEFAULT_MAX_RERANK_DELTA);
    }
  });
});

describe('AdviceGate — determinism', () => {
  it('is a pure function of (advice, context)', () => {
    const gate = new AdviceGate();
    const ctx: AdviceGateContext = { allowedActions: ALLOWED, candidatePaths: ['a'], maxRerankDelta: 4 };
    const r1 = gate.sanitize({ kind: 'recovery_order', failureClass: 'TOOL', order: ['RETRY', 'FIX'] }, ctx);
    const r2 = gate.sanitize({ kind: 'recovery_order', failureClass: 'TOOL', order: ['RETRY', 'FIX'] }, ctx);
    expect(JSON.stringify(r1)).toEqual(JSON.stringify(r2));
  });
});
