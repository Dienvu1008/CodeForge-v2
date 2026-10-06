// ME-002 — Mọi memory item mang trust 'untrusted' trong ContextSnapshot.
//
// Directly testable now via TrustMarker (the deterministic trust assignment that
// the ContextBuilder applies to every item, CX-003).
import { describe, it, expect } from 'vitest';
import { assignTrust, isUntrustedSource } from '@codeforge/agent-core';

describe('ME-002 — memory items are untrusted', () => {
  it('assignTrust(memory) = untrusted', () => {
    expect(assignTrust('memory')).toBe('untrusted');
  });

  it('isUntrustedSource(memory) = true', () => {
    expect(isUntrustedSource('memory')).toBe(true);
  });
});
