// ME-003 — Mọi memory write có provenance + reason + timestamp; append-only.
//
// Invariants-first: enforcement lives in MemoryWriter (P7-MW1), not yet built.
// The contract is recorded here and will be filled when the component lands. The
// append-only + provenance discipline mirrors PR-002/PR-003 already enforced for
// other write paths (ProvenanceTracker exists in agent-core).
import { describe, it } from 'vitest';

describe('ME-003 — memory writes are provenance-tracked + append-only', () => {
  // Pending MemoryWriter (P7-MW1):
  it.todo('MemoryWriter attaches provenance { reason, at, source } to every record');
  it.todo('MemoryWriter never mutates an existing memory record (append-only)');
});
