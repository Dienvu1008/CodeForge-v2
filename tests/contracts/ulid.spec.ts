// ULID primitive — DOMAIN_CONTRACTS §1.2. Deterministic via injected sources.
import { describe, it, expect } from 'vitest';
import { generateUlid, isUlid, type UlidSources } from '@codeforge/agent-core';

function fixedSources(now: number, fill: number): UlidSources {
  return {
    now: () => now,
    randomBytes: (n) => new Uint8Array(n).fill(fill),
  };
}

describe('generateUlid', () => {
  it('produces a 26-char ULID', () => {
    const id = generateUlid(fixedSources(0, 0));
    expect(id).toHaveLength(26);
    expect(isUlid(id)).toBe(true);
  });

  it('is deterministic for fixed sources', () => {
    const a = generateUlid(fixedSources(1_700_000_000_000, 7));
    const b = generateUlid(fixedSources(1_700_000_000_000, 7));
    expect(a).toBe(b);
  });

  it('is lexicographically sortable by time', () => {
    const earlier = generateUlid(fixedSources(1_000, 0));
    const later = generateUlid(fixedSources(2_000, 0));
    expect(earlier < later).toBe(true);
  });

  it('encodes time in the first 10 chars (same time → same prefix)', () => {
    const t = 1_700_000_000_000;
    const a = generateUlid(fixedSources(t, 1));
    const b = generateUlid(fixedSources(t, 2));
    expect(a.slice(0, 10)).toBe(b.slice(0, 10));
    expect(a.slice(10)).not.toBe(b.slice(10)); // random part differs
  });

  it('rejects out-of-range time', () => {
    expect(() => generateUlid(fixedSources(-1, 0))).toThrow(RangeError);
    expect(() => generateUlid(fixedSources(2 ** 48, 0))).toThrow(RangeError);
  });
});

describe('isUlid', () => {
  it('accepts a valid ULID', () => {
    expect(isUlid('01ARZ3NDEKTSV4RRFFQ69G5FAV')).toBe(true);
  });
  it('rejects wrong length', () => {
    expect(isUlid('01ARZ3NDEK')).toBe(false);
  });
  it('rejects excluded letters (I, L, O, U)', () => {
    expect(isUlid('0IARZ3NDEKTSV4RRFFQ69G5FAV')).toBe(false);
  });
});
