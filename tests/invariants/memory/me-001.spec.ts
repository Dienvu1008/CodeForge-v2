// ME-001 — Memory item không bao giờ là runtime authority — chỉ là context evidence.
//
// Phase 7 invariant (invariants-first: full enforcement lands with MemoryStore/
// Retriever). What is testable now: memory is modelled only as context data, and
// context carries a trust level that is never 'trusted' for memory — so a memory
// item can never arrive as an authoritative instruction. The runtime kernel reads
// no memory to make decisions (architectural: agent-core has no memory authority
// path; depcruise + CX-005 guard this).
import { describe, it, expect } from 'vitest';
import { assignTrust } from '@codeforge/agent-core';

describe('ME-001 — memory is evidence, never authority', () => {
  it('memory source resolves to untrusted (cannot be authority)', () => {
    // A trusted source could be treated as higher-authority context; memory must not be.
    expect(assignTrust('memory')).toBe('untrusted');
  });

  it('memory is never classified trusted', () => {
    expect(assignTrust('memory')).not.toBe('trusted');
  });
});
