// OB-010 — Context telemetry là suy diễn từ ContextSnapshot/EventLog; không điều khiển
// việc chọn context (không authority context).
//
// Enforced by ContextTelemetry (P9.2): computeContextTelemetry is a pure rollup of an
// immutable ContextSnapshot → telemetry data. It produces no selection decision, holds
// no builder handle, and does not mutate the snapshot — selection stays with
// ContextBuilder + TokenBudgeter (CX-004). Telemetry observes; it never decides.
import { describe, it, expect } from 'vitest';
import {
  computeContextTelemetry,
  sumItemTokens,
  type ContextSnapshot,
  type ContextItem,
} from '@codeforge/agent-core';

function item(id: string, tokens: number): ContextItem {
  return {
    itemId: id, kind: 'memory',
    source: { kind: 'memory' }, content: 'x', tokenCount: tokens, trust: 'untrusted', reason: 'r',
    provenance: { provenanceId: `pv-${id}`, source: { kind: 'runtime', id: 'ctx' }, inputs: [], reason: 'r', at: 't' },
    priority: 1, pinned: false, truncated: false,
  };
}

function snapshot(items: readonly ContextItem[]): ContextSnapshot {
  return {
    snapshotId: 'SNAP', sessionId: 'S',
    workspaceRevision: {
      revisionId: 'R', canonicalFormVersion: 'v1', root: '/', includedPaths: [],
      excludedScratchPaths: [], hashAlgorithm: 'blake3', hash: 'H', fileCount: 0, totalBytes: 0,
      createdAt: 't', createdBy: { sessionId: 'S', reason: 'session_start' },
    },
    canonicalFormVersion: 'v1', items,
    tokenBudget: 100, tokenUsed: sumItemTokens(items),
    builtBy: 'executor', builtAt: 't', buildReason: 'task_execution', policyVersion: 1, schemaVersion: 1,
  };
}

describe('OB-010 — context telemetry observes, never selects', () => {
  it('telemetry is pure data — no selection decision, nothing callable', () => {
    const t = computeContextTelemetry(snapshot([item('a', 10), item('b', 5)]));
    const walk = (v: unknown): void => {
      if (typeof v === 'function') throw new Error('telemetry exposed a callable');
      if (v && typeof v === 'object') for (const x of Object.values(v)) walk(x);
    };
    walk(t);
    // It reports what IS in the snapshot; it does not add/remove/choose items.
    expect(t.itemCount).toBe(2);
    expect(t.tokenUsed).toBe(15);
  });

  it('computing telemetry does not mutate the snapshot', () => {
    const snap = snapshot([item('a', 10)]);
    const before = JSON.stringify(snap);
    computeContextTelemetry(snap);
    expect(JSON.stringify(snap)).toEqual(before);
  });
});
