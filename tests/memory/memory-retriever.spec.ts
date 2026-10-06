// P7-MR1 — MemoryRetriever.
// Relevance ranking (tag-match desc, recency desc, id asc) + filtering + limit.
import { describe, it, expect } from 'vitest';
import { MemoryRetriever } from '@codeforge/agent-core';
import type { MemoryRecord, MemoryQuery, Provenance, MemoryKind, MemoryScope } from '@codeforge/agent-core';

function provenance(id: string): Provenance {
  return {
    provenanceId: `p-${id}`,
    source: { kind: 'runtime', id: 'test' },
    inputs: [],
    reason: 'r',
    at: '2026-01-01T00:00:00.000Z',
  };
}

function rec(
  id: string,
  over: Partial<MemoryRecord> = {},
): MemoryRecord {
  return {
    memoryId: id,
    kind: 'task_outcome' as MemoryKind,
    scope: 'project' as MemoryScope,
    content: id,
    tags: [],
    provenance: provenance(id),
    createdAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

const ids = (recs: readonly MemoryRecord[]): string[] => recs.map((r) => r.memoryId);
const q = (over: Partial<MemoryQuery> = {}): MemoryQuery => ({ limit: 10, ...over });

describe('P7-MR1 MemoryRetriever — filtering', () => {
  const r = new MemoryRetriever();

  it('filters by scope', () => {
    const recs = [rec('a', { scope: 'project' }), rec('b', { scope: 'global' })];
    expect(ids(r.retrieve(q({ scope: 'global' }), recs))).toEqual(['b']);
  });

  it('filters by kinds', () => {
    const recs = [rec('a', { kind: 'task_outcome' }), rec('b', { kind: 'failure_pattern' })];
    expect(ids(r.retrieve(q({ kinds: ['failure_pattern'] }), recs))).toEqual(['b']);
  });

  it('no scope/kind filter returns all (ranked)', () => {
    const recs = [rec('a'), rec('b')];
    expect(r.retrieve(q(), recs)).toHaveLength(2);
  });
});

describe('P7-MR1 MemoryRetriever — relevance ranking', () => {
  const r = new MemoryRetriever();

  it('ranks records with more matching tags higher', () => {
    const recs = [
      rec('one', { tags: ['auth'], createdAt: '2026-01-01T00:00:03.000Z' }),
      rec('two', { tags: ['auth', 'login'], createdAt: '2026-01-01T00:00:01.000Z' }),
      rec('none', { tags: [], createdAt: '2026-01-01T00:00:05.000Z' }),
    ];
    // 'two' matches 2 tags, 'one' matches 1, 'none' matches 0 — tag score beats recency.
    expect(ids(r.retrieve(q({ tags: ['auth', 'login'] }), recs))).toEqual(['two', 'one', 'none']);
  });

  it('breaks tag ties by recency (newer first)', () => {
    const recs = [
      rec('older', { tags: ['x'], createdAt: '2026-01-01T00:00:01.000Z' }),
      rec('newer', { tags: ['x'], createdAt: '2026-01-01T00:00:09.000Z' }),
    ];
    expect(ids(r.retrieve(q({ tags: ['x'] }), recs))).toEqual(['newer', 'older']);
  });

  it('breaks recency ties by memoryId asc (stable)', () => {
    const recs = [
      rec('b', { createdAt: '2026-01-01T00:00:01.000Z' }),
      rec('a', { createdAt: '2026-01-01T00:00:01.000Z' }),
    ];
    expect(ids(r.retrieve(q(), recs))).toEqual(['a', 'b']);
  });

  it('with no query tags, orders purely by recency then id', () => {
    const recs = [
      rec('a', { createdAt: '2026-01-01T00:00:01.000Z' }),
      rec('b', { createdAt: '2026-01-01T00:00:02.000Z' }),
    ];
    expect(ids(r.retrieve(q(), recs))).toEqual(['b', 'a']);
  });
});

describe('P7-MR1 MemoryRetriever — limit, empty, forward-compat', () => {
  const r = new MemoryRetriever();

  it('applies the limit', () => {
    const recs = [rec('a'), rec('b'), rec('c')];
    expect(r.retrieve(q({ limit: 2 }), recs)).toHaveLength(2);
  });

  it('returns empty for empty records', () => {
    expect(r.retrieve(q(), [])).toEqual([]);
  });

  it('ignores the forward-compatible text hint in v1', () => {
    const recs = [rec('a'), rec('b')];
    const withText = ids(r.retrieve(q({ text: 'anything' }), recs));
    const without = ids(r.retrieve(q(), recs));
    expect(withText).toEqual(without);
  });
});
