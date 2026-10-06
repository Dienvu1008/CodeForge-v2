// P9.2 — ContextTelemetry.computeContextTelemetry (pure rollup of a ContextSnapshot).
import { describe, it, expect } from 'vitest';
import {
  computeContextTelemetry,
  sumItemTokens,
  type ContextSnapshot,
  type ContextItem,
  type ContextItemKind,
} from '@codeforge/agent-core';

function item(id: string, kind: ContextItemKind, tokens: number, extra: Partial<ContextItem> = {}): ContextItem {
  return {
    itemId: id, kind,
    source: { kind: 'workspace_file', path: `${id}.ts` },
    content: 'x', tokenCount: tokens, trust: 'trusted', reason: 'r',
    provenance: { provenanceId: `pv-${id}`, source: { kind: 'runtime', id: 'ctx' }, inputs: [], reason: 'r', at: 't' },
    priority: 1, pinned: false, truncated: false,
    ...extra,
  };
}

function snapshot(items: readonly ContextItem[], budget: number): ContextSnapshot {
  return {
    snapshotId: 'SNAP1', sessionId: 'S', taskId: 'T1',
    workspaceRevision: {
      revisionId: 'R', canonicalFormVersion: 'v1', root: '/', includedPaths: [],
      excludedScratchPaths: [], hashAlgorithm: 'blake3', hash: 'H', fileCount: 0, totalBytes: 0,
      createdAt: 't', createdBy: { sessionId: 'S', reason: 'session_start' },
    },
    canonicalFormVersion: 'v1', items,
    tokenBudget: budget, tokenUsed: sumItemTokens(items),
    builtBy: 'executor', builtAt: 't', buildReason: 'task_execution', policyVersion: 1, schemaVersion: 1,
  };
}

describe('P9.2 computeContextTelemetry — category rollup', () => {
  it('groups tokens by kind and computes fraction of used', () => {
    const snap = snapshot([
      item('a', 'file_snippet', 40),
      item('b', 'file_snippet', 20),
      item('c', 'memory', 20),
      item('d', 'task_definition', 20),
    ], 200);
    const t = computeContextTelemetry(snap);
    expect(t.tokenUsed).toBe(100);
    expect(t.byCategory[0]).toEqual({ kind: 'file_snippet', tokens: 60, itemCount: 2, fraction: 0.6 });
    expect(t.largestCategory).toBe('file_snippet');
    // sorted by tokens desc then kind asc
    expect(t.byCategory.map((c) => c.kind)).toEqual(['file_snippet', 'memory', 'task_definition']);
  });

  it('pressure = tokenUsed / tokenBudget; remaining is clamped at 0', () => {
    const t = computeContextTelemetry(snapshot([item('a', 'file_full', 150)], 200));
    expect(t.pressure).toBeCloseTo(0.75);
    expect(t.tokensRemaining).toBe(50);
  });

  it('empty snapshot → zero pressure, no largestCategory, fraction 0', () => {
    const t = computeContextTelemetry(snapshot([], 100));
    expect(t.tokenUsed).toBe(0);
    expect(t.pressure).toBe(0);
    expect(t.byCategory).toEqual([]);
    expect(t.largestCategory).toBeUndefined();
  });

  it('budget 0 → pressure 0 (no divide-by-zero)', () => {
    const t = computeContextTelemetry(snapshot([item('a', 'memory', 10)], 0));
    expect(t.pressure).toBe(0);
  });

  it('counts pinned / truncated / untrusted items', () => {
    const t = computeContextTelemetry(snapshot([
      item('a', 'memory', 10, { pinned: true }),
      item('b', 'memory', 10, { truncated: true }),
      item('c', 'memory', 10, { trust: 'untrusted' }),
    ], 100));
    expect(t.pinnedCount).toBe(1);
    expect(t.truncatedCount).toBe(1);
    expect(t.untrustedCount).toBe(1);
    expect(t.itemCount).toBe(3);
  });

  it('reports discarded item ids (sorted), passed from the TokenBudgeter', () => {
    const t = computeContextTelemetry(snapshot([item('a', 'memory', 10)], 100), ['z', 'a', 'm']);
    expect(t.discardedItemIds).toEqual(['a', 'm', 'z']);
  });

  it('is deterministic — same snapshot yields the same telemetry', () => {
    const snap = snapshot([item('a', 'file_snippet', 10), item('b', 'memory', 5)], 100);
    expect(computeContextTelemetry(snap)).toEqual(computeContextTelemetry(snap));
  });
});
