// OB-010 — Context telemetry là suy diễn từ ContextSnapshot/EventLog; không điều khiển
// việc chọn context (không authority context).
//
// Invariants-first: enforcement lands with P9.2 (ContextTelemetry). Contract: telemetry
// is a PURE rollup over an immutable ContextSnapshot (items grouped by kind/source,
// pressure = tokenUsed/tokenBudget, discarded set) and emitted events. It never feeds
// back into the ContextBuilder's selection — context selection stays with the builder +
// TokenBudgeter (CX-004). Telemetry observes; it does not decide what goes into context.
import { describe, it } from 'vitest';

describe('OB-010 — context telemetry observes, never selects context', () => {
  it.todo('ContextTelemetry is a pure rollup of a ContextSnapshot — no mutation, no selection (P9.2)');
  it.todo('telemetry output is not an input to ContextBuilder selection (no feedback authority) (P9.2)');
});
