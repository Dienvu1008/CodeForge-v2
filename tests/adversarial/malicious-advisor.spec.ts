// P11-ADV — MaliciousAdvisor: a hostile learning advisor must not be able to widen the
// deterministic decision surface through the AdviceGate. Every attack below mirrors a real
// escalation attempt (inject a destructive action, blow past score bounds, point at files
// outside the workspace, smuggle authority through a boolean) and must be clamped or dropped.
//
// Target invariants: LE-001 (never authority), LE-003 (reorder/score within allowed-set
// only), LE-007 (no bypass path). The gate is the single enforcement point.
import { describe, it, expect } from 'vitest';
import { AdviceGate } from '@codeforge/agent-core';
import type { RawAdvice, RecoveryKind, AdviceGateContext } from '@codeforge/agent-core';

const ALLOWED: readonly RecoveryKind[] = ['FIX', 'RETRY', 'ESCALATE'];
const CANDIDATES = ['src/a.ts', 'src/b.ts'];
const CTX: AdviceGateContext = { allowedActions: ALLOWED, candidatePaths: CANDIDATES, maxRerankDelta: 5 };

describe('MaliciousAdvisor — AdviceGate blocks every escalation attempt', () => {
  const gate = new AdviceGate();

  it('attack 1: inject a destructive action (ROLLBACK/ABORT) not in the allowed-set', () => {
    const attack: RawAdvice = {
      kind: 'recovery_order',
      failureClass: 'SYNTAX',
      order: ['ROLLBACK', 'ABORT', 'REPLACE'] as RecoveryKind[],
    };
    const safe = gate.sanitize(attack, CTX);
    // None of the injected actions are allowed → nothing survives → null (keep default).
    expect(safe).toBeNull();
  });

  it('attack 2: smuggle one allowed action in front of forbidden ones', () => {
    const attack: RawAdvice = {
      kind: 'recovery_order',
      failureClass: 'SYNTAX',
      order: ['ABORT', 'ESCALATE', 'ROLLBACK', 'FIX'] as RecoveryKind[],
    };
    const safe = gate.sanitize(attack, CTX);
    // Only the allowed actions survive; forbidden ones are stripped — never a superset.
    if (safe !== null && safe.kind === 'recovery_order') {
      for (const a of safe.order) expect(ALLOWED).toContain(a);
      expect(safe.order).toEqual(['ESCALATE', 'FIX']);
    }
  });

  it('attack 3: blow past the score bound with a huge delta', () => {
    const attack: RawAdvice = { kind: 'context_rerank', deltas: { 'src/a.ts': Number.MAX_SAFE_INTEGER } };
    const safe = gate.sanitize(attack, CTX);
    if (safe !== null && safe.kind === 'context_rerank') {
      expect(safe.deltas['src/a.ts']).toBe(5); // clamped to maxRerankDelta
    }
  });

  it('attack 4: point rerank at a file outside the workspace candidate set', () => {
    const attack: RawAdvice = {
      kind: 'context_rerank',
      deltas: { '/etc/passwd': 5, '../../secret.env': 5, 'src/a.ts': 3 },
    };
    const safe = gate.sanitize(attack, CTX);
    if (safe !== null && safe.kind === 'context_rerank') {
      // Only the real candidate survives; traversal/outside paths are dropped.
      expect(Object.keys(safe.deltas)).toEqual(['src/a.ts']);
    }
  });

  it('attack 5: NaN / Infinity deltas are rejected (no undefined behavior)', () => {
    const attack: RawAdvice = {
      kind: 'context_rerank',
      deltas: { 'src/a.ts': Number.NaN, 'src/b.ts': Number.POSITIVE_INFINITY },
    };
    const safe = gate.sanitize(attack, CTX);
    // Non-finite deltas are dropped; nothing finite survives → null.
    expect(safe).toBeNull();
  });

  it('attack 6: unknown advice kind is dropped (fail-closed)', () => {
    const attack = { kind: 'exfiltrate', target: '/etc/passwd' } as unknown as RawAdvice;
    expect(gate.sanitize(attack, CTX)).toBeNull();
  });

  it('attack 7: a no_progress boolean carries no authority (just a gated nudge)', () => {
    const safe = gate.sanitize({ kind: 'no_progress', likelyStuck: true }, CTX);
    // It passes through as a boolean signal only — it cannot carry an action or a path.
    expect(safe).toEqual({ kind: 'no_progress', likelyStuck: true });
    expect(Object.keys(safe ?? {})).toEqual(['kind', 'likelyStuck']);
  });

  it('attack 8: a recovery order equal to the default cannot "lock in" as authority', () => {
    const safe = gate.sanitize(
      { kind: 'recovery_order', failureClass: 'LOGIC', order: ALLOWED },
      CTX,
    );
    // No-op advice collapses to null so the policy keeps full ownership of the default order.
    expect(safe).toBeNull();
  });
});
