// P11.5 unit — ContextReranker: advisory re-rank within the existing candidate list.
// Pinned items never move (CX-005); null advice = identity (LE-002); only order changes.
import { describe, it, expect } from 'vitest';
import { ContextReranker, AdviceGate } from '@codeforge/agent-core';
import type { ContextItem, Provenance, SafeContextRerankAdvice } from '@codeforge/agent-core';

function prov(): Provenance {
  return { provenanceId: 'p', source: { kind: 'runtime', id: 't' }, inputs: [], reason: 'r', at: '2026-01-01T00:00:00.000Z' };
}
function item(over: Partial<ContextItem> & { itemId: string; priority: number; path?: string; pinned?: boolean }): ContextItem {
  return {
    itemId: over.itemId,
    kind: 'file_full',
    source: { kind: 'workspace_file', ...(over.path !== undefined ? { path: over.path } : {}) },
    content: over.itemId,
    tokenCount: 1,
    trust: 'untrusted',
    reason: 'r',
    provenance: prov(),
    priority: over.priority,
    pinned: over.pinned ?? false,
    truncated: false,
  };
}

const ITEMS: ContextItem[] = [
  item({ itemId: 'pin', priority: 100, pinned: true, path: 'task' }),
  item({ itemId: 'a', priority: 40, path: 'src/a.ts' }),
  item({ itemId: 'b', priority: 40, path: 'src/b.ts' }),
  item({ itemId: 'c', priority: 40, path: 'src/c.ts' }),
];

describe('ContextReranker', () => {
  const reranker = new ContextReranker();

  it('null advice returns the input unchanged (same reference) — LE-002', () => {
    expect(reranker.rerank(ITEMS, null)).toBe(ITEMS);
    expect(reranker.rerank(ITEMS, undefined)).toBe(ITEMS);
  });

  it('applies a bounded delta to a non-pinned item and re-sorts it up', () => {
    const advice: SafeContextRerankAdvice = { kind: 'context_rerank', deltas: { 'src/c.ts': 5 }, maxDelta: 10 };
    const out = reranker.rerank(ITEMS, advice);
    // c now has priority 45 > a,b (40) → ranks first among non-pinned; pin stays on top.
    expect(out.map((i) => i.itemId)).toEqual(['pin', 'c', 'a', 'b']);
    // Same SET of items — nothing added or dropped.
    expect(out.map((i) => i.itemId).sort()).toEqual(['a', 'b', 'c', 'pin']);
  });

  it('never moves a pinned item even if advice targets it', () => {
    const advice: SafeContextRerankAdvice = { kind: 'context_rerank', deltas: { 'task': -999 }, maxDelta: 999 };
    const out = reranker.rerank(ITEMS, advice);
    // Pinned 'pin' stays first regardless of the delta aimed at its path.
    expect(out[0]!.itemId).toBe('pin');
  });

  it('does not mutate the input items (only order of a copy changes)', () => {
    const advice: SafeContextRerankAdvice = { kind: 'context_rerank', deltas: { 'src/c.ts': 5 }, maxDelta: 10 };
    const snapshot = ITEMS.map((i) => ({ id: i.itemId, p: i.priority }));
    reranker.rerank(ITEMS, advice);
    for (let k = 0; k < ITEMS.length; k++) {
      expect(ITEMS[k]!.priority).toBe(snapshot[k]!.p); // priorities untouched on the originals
    }
  });

  it('is deterministic — equal inputs give equal order', () => {
    const advice: SafeContextRerankAdvice = { kind: 'context_rerank', deltas: { 'src/a.ts': 3, 'src/b.ts': 3 }, maxDelta: 10 };
    const r1 = reranker.rerank(ITEMS, advice).map((i) => i.itemId);
    const r2 = reranker.rerank(ITEMS, advice).map((i) => i.itemId);
    expect(r2).toEqual(r1);
    // a and b tie on effective priority (43) → tiebreak by path asc: a before b.
    expect(r1).toEqual(['pin', 'a', 'b', 'c']);
  });

  it('respects the AdviceGate clamp end-to-end (out-of-set path dropped)', () => {
    const gate = new AdviceGate();
    const safe = gate.sanitize(
      { kind: 'context_rerank', deltas: { 'src/a.ts': 1000, 'etc/passwd': 1000 } },
      { candidatePaths: ['src/a.ts', 'src/b.ts', 'src/c.ts'], maxRerankDelta: 10 },
    );
    const out = reranker.rerank(ITEMS, safe as SafeContextRerankAdvice);
    // etc/passwd never existed as a candidate → not present; a is boosted (+10 clamped).
    expect(out.map((i) => i.itemId)).toEqual(['pin', 'a', 'b', 'c']);
    expect(out.some((i) => i.source.path === 'etc/passwd')).toBe(false);
  });
});
