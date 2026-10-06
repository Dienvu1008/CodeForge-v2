// ME-006 — Memory store có retention bound; không ghi không giới hạn.
//
// Invariants-first: enforcement lives in MemoryWriter (P7-MW1), not yet built.
// v1 policy (per PHASE_7_ROADMAP Appendix A): max-count per (scope, kind),
// enforced solely at the write path so the policy can change in one place later.
import { describe, it } from 'vitest';

describe('ME-006 — memory retention is bounded', () => {
  // Pending MemoryWriter (P7-MW1):
  it.todo('writing beyond the per-(scope,kind) max-count evicts the oldest records');
  it.todo('retention is enforced only in MemoryWriter (store/retriever stay policy-agnostic)');
});
