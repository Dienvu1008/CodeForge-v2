// LE-007 — Lớp learning không bao giờ bypass Policy/ToolGateway/ModelGateway để lấy dữ liệu
// hay thực thi action.
//
// Enforced by AdviceGate's construction: it is a PURE function of (rawAdvice, deterministic
// context). It takes no store, no gateway, no engine, no model — there is simply no I/O path
// through which advice could reach a side effect. This test asserts the gate has no such
// surface and performs no mutation, so advice cannot become an action.
import { describe, it, expect } from 'vitest';
import { AdviceGate } from '@codeforge/agent-core';
import type { AdviceGateContext, RecoveryKind } from '@codeforge/agent-core';

const ALLOWED: readonly RecoveryKind[] = ['FIX', 'RETRY', 'ESCALATE'];

describe('LE-007 — the gate has no bypass path (pure clamp, no side effects)', () => {
  it('constructs with no dependencies (no store/gateway/engine/model injected)', () => {
    // The gate takes nothing — there is no handle to a side-effecting system.
    expect(() => new AdviceGate()).not.toThrow();
    // The constructor declares zero parameters (no deps to inject).
    expect(AdviceGate.length).toBe(0);
  });

  it('exposes only sanitize() — no execute/apply/fetch/write surface', () => {
    const gate = new AdviceGate() as unknown as Record<string, unknown>;
    const proto = Object.getPrototypeOf(gate) as object;
    const methods = Object.getOwnPropertyNames(proto).filter((m) => m !== 'constructor');
    const forbidden = ['execute', 'apply', 'fetch', 'write', 'request', 'run', 'commit', 'generate'];
    for (const f of forbidden) expect(methods).not.toContain(f);
    expect(typeof (gate as { sanitize?: unknown }).sanitize).toBe('function');
  });

  it('does not mutate the input advice or the context', () => {
    const gate = new AdviceGate();
    const raw = { kind: 'context_rerank' as const, deltas: { 'src/a.ts': 9999 } };
    const ctx: AdviceGateContext = { candidatePaths: ['src/a.ts'], maxRerankDelta: 5, allowedActions: ALLOWED };
    const rawSnapshot = JSON.stringify(raw);
    const ctxSnapshot = JSON.stringify(ctx);

    gate.sanitize(raw, ctx);

    expect(JSON.stringify(raw)).toEqual(rawSnapshot);   // input advice untouched
    expect(JSON.stringify(ctx)).toEqual(ctxSnapshot);   // context untouched
  });

  it('is a pure function — same inputs give the same output', () => {
    const gate = new AdviceGate();
    const raw = { kind: 'recovery_order' as const, failureClass: 'SYNTAX' as const, order: ['RETRY', 'FIX'] as RecoveryKind[] };
    const ctx: AdviceGateContext = { allowedActions: ALLOWED };
    expect(JSON.stringify(gate.sanitize(raw, ctx))).toEqual(JSON.stringify(gate.sanitize(raw, ctx)));
  });
});
