// ME-004 — Memory retrieval deterministic trên cùng (query, store state).
//
// Invariants-first: enforcement lives in MemoryRetriever (P7-MR1), not yet built.
// MemoryRetriever will rank by (tag match desc, recency desc, id asc) — a total,
// stable order independent of input ordering, mirroring the determinism already
// proven for computeAffectedClosureFromGraph (VR-010 style).
import { describe, it } from 'vitest';

describe('ME-004 — memory retrieval is deterministic', () => {
  // Pending MemoryRetriever (P7-MR1):
  it.todo('retrieve(query, records) yields the same order regardless of input order');
  it.todo('retrieve is a pure function of (query, records) — no clock/randomness');
});
