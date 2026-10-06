// AU-005 — Hai nhánh/agent không ghi đè workspace của nhau ngoài policy (isolation).
//
// Enforced by BranchIsolation (P8-BI1): each parallel branch gets a disjoint scratch
// zone (a relpath prefix). A write into another branch's zone is classified FOREIGN and
// rejected; only the branch's OWN zone, or an explicitly SHARED prefix, is writable. So
// two concurrent branches cannot clobber each other's scratch outside explicit policy.
import { describe, it, expect } from 'vitest';
import {
  allocateScratchZones,
  classifyWrite,
  assertWriteAllowed,
  BranchIsolationError,
} from '@codeforge/agent-core';

describe('AU-005 — parallel branches are workspace-isolated', () => {
  it('each branch has a disjoint scratch zone', () => {
    const zones = allocateScratchZones(['a', 'b', 'c']);
    const paths = zones.map((z) => z.relpath);
    // All distinct, and none is a prefix of another (true isolation).
    expect(new Set(paths).size).toBe(paths.length);
    for (const x of zones) {
      for (const y of zones) {
        if (x.branchId !== y.branchId) expect(x.relpath.startsWith(y.relpath)).toBe(false);
      }
    }
  });

  it("a branch cannot write into another branch's zone outside explicit policy", () => {
    const zones = allocateScratchZones(['a', 'b']);
    // Without a shared policy → FOREIGN, rejected.
    expect(classifyWrite('a', '.scratch/b/x', zones).allowed).toBe(false);
    expect(() => assertWriteAllowed('a', '.scratch/b/x', zones)).toThrowError(BranchIsolationError);
    // With an explicit shared prefix → permitted (policy opt-in).
    expect(classifyWrite('a', '.scratch/common/x', zones, ['.scratch/common']).allowed).toBe(true);
  });
});
