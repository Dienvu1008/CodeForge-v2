// MemoryRetriever — P7-MR1. Deterministic relevance ranking of memory records.
//
// Pure + deterministic (ME-004): retrieve() is a function of (query, records)
// only — no clock, no randomness, no I/O. It takes records as PLAIN DATA (the
// caller fetches them from MemoryStore and feeds them in), so this lives in
// agent-core with no dependency on the infrastructure layer — the same pattern
// as the code-intelligence Retriever (CR1).
//
// Ranking adds a relevance layer the store does not: records are ordered by how
// many of the query tags they match (desc), then recency (desc), then memoryId
// (asc) as a stable tiebreaker. The query `tags` are a RELEVANCE SIGNAL here, not
// a hard AND filter — hard filtering is the store's job (MemoryStore.query).
import type { MemoryRecord, MemoryQuery } from '../domain/memory.js';

export class MemoryRetriever {
  /**
   * Rank and trim `records` for `query`. Applies the hard scope/kinds filter when
   * present, scores by tag overlap, and returns the top `limit` records in a
   * deterministic order.
   */
  retrieve(query: MemoryQuery, records: readonly MemoryRecord[]): readonly MemoryRecord[] {
    const queryTags = new Set(query.tags ?? []);

    const filtered = records.filter((r) => {
      if (query.scope !== undefined && r.scope !== query.scope) return false;
      if (query.kinds !== undefined && query.kinds.length > 0 && !query.kinds.includes(r.kind)) {
        return false;
      }
      return true;
    });

    // Note: query.text is intentionally unused in v1 (forward-compatible semantic
    // hint — PHASE_7_ROADMAP §4.10). A future embedding retriever consumes it
    // without changing this signature.
    const ranked = [...filtered].sort((a, b) => compareByRelevance(a, b, queryTags));

    return ranked.slice(0, Math.max(0, query.limit));
  }
}

// ── ranking ──────────────────────────────────────────────────────────────────

/** Number of query tags the record carries. */
function tagMatchCount(record: MemoryRecord, queryTags: ReadonlySet<string>): number {
  if (queryTags.size === 0) return 0;
  let n = 0;
  for (const t of record.tags) {
    if (queryTags.has(t)) n++;
  }
  return n;
}

/**
 * Total order (ME-004): tag-match desc, then createdAt desc, then memoryId asc.
 * Every tiebreaker is a stable key, so the result is independent of input order.
 */
function compareByRelevance(
  a: MemoryRecord,
  b: MemoryRecord,
  queryTags: ReadonlySet<string>,
): number {
  const ta = tagMatchCount(a, queryTags);
  const tb = tagMatchCount(b, queryTags);
  if (ta !== tb) return tb - ta; // more matches first

  if (a.createdAt !== b.createdAt) {
    return a.createdAt < b.createdAt ? 1 : -1; // newer first
  }
  return a.memoryId.localeCompare(b.memoryId); // stable final tiebreaker
}
