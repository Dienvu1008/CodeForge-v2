// ME-004 — Memory retrieval deterministic trên cùng (query, store state).
//
// Enforced by MemoryRetriever (P7-MR1): retrieve() is a pure function of
// (query, records) with a total order (tag-match desc, recency desc, memoryId
// asc), so the result is independent of input ordering and carries no clock or
// randomness.
import { describe, it, expect } from 'vitest';
import { MemoryRetriever } from '@codeforge/agent-core';
import type { MemoryRecord, Provenance } from '@codeforge/agent-core';

function provenance(id: string): Provenance {
  return {
    provenanceId: `p-${id}`,
    source: { kind: 'runtime', id: 'test' },
    inputs: [],
    reason: 'r',
    at: '2026-01-01T00:00:00.000Z',
  };
}

function rec(id: string, createdAt: string, tags: string[] = []): MemoryRecord {
  return {
    memoryId: id,
    kind: 'task_outcome',
    scope: 'project',
    content: id,
    tags,
    provenance: provenance(id),
    createdAt,
  };
}

const RECORDS: MemoryRecord[] = [
  rec('a', '2026-01-01T00:00:01.000Z', ['auth']),
  rec('b', '2026-01-01T00:00:02.000Z', ['auth', 'login']),
  rec('c', '2026-01-01T00:00:03.000Z', []),
];

describe('ME-004 — memory retrieval is deterministic', () => {
  it('yields the same order regardless of input order', () => {
    const r = new MemoryRetriever();
    const query = { tags: ['auth'], limit: 10 };
    const forward = r.retrieve(query, RECORDS).map((x) => x.memoryId);
    const reversed = r.retrieve(query, [...RECORDS].reverse()).map((x) => x.memoryId);
    const shuffled = r.retrieve(query, [RECORDS[2]!, RECORDS[0]!, RECORDS[1]!]).map((x) => x.memoryId);
    expect(reversed).toEqual(forward);
    expect(shuffled).toEqual(forward);
  });

  it('is a pure function of (query, records) — repeated calls are identical', () => {
    const r = new MemoryRetriever();
    const query = { tags: ['auth', 'login'], limit: 10 };
    const first = r.retrieve(query, RECORDS).map((x) => x.memoryId);
    const second = r.retrieve(query, RECORDS).map((x) => x.memoryId);
    expect(second).toEqual(first);
  });
});
