// P8-BI1 — BranchIsolation: scratch-zone allocation + write classification + no-orphan cancel.
import { describe, it, expect } from 'vitest';
import {
  allocateScratchZones,
  classifyWrite,
  assertWriteAllowed,
  isCleanCancellation,
  cancelOneBranch,
  BranchIsolationError,
  type BranchRunOutcome,
} from '@codeforge/agent-core';

describe('P8-BI1 allocateScratchZones — disjoint zones (AU-005)', () => {
  it('gives each branch a distinct zone under the root prefix', () => {
    const zones = allocateScratchZones(['b', 'a'], '.scratch');
    expect(zones).toEqual([
      { branchId: 'a', relpath: '.scratch/a/' },
      { branchId: 'b', relpath: '.scratch/b/' },
    ]);
  });

  it('zones are pairwise disjoint (no zone is a prefix of another)', () => {
    const zones = allocateScratchZones(['a', 'ab', 'b']);
    for (const x of zones) {
      for (const y of zones) {
        if (x.branchId === y.branchId) continue;
        expect(x.relpath.startsWith(y.relpath)).toBe(false);
      }
    }
  });

  it('is deterministic regardless of input order', () => {
    expect(allocateScratchZones(['x', 'y', 'z'])).toEqual(allocateScratchZones(['z', 'y', 'x']));
  });

  it('rejects a duplicate branch id', () => {
    expect(() => allocateScratchZones(['a', 'a'])).toThrowError(BranchIsolationError);
  });
});

describe('P8-BI1 classifyWrite — isolation enforcement (AU-005)', () => {
  const zones = allocateScratchZones(['a', 'b']);

  it('a branch may write inside its own zone (OWN, allowed)', () => {
    const c = classifyWrite('a', '.scratch/a/out.txt', zones);
    expect(c).toEqual({ disposition: 'OWN', allowed: true });
  });

  it('a branch may not write into a sibling zone (FOREIGN, rejected)', () => {
    const c = classifyWrite('a', '.scratch/b/out.txt', zones);
    expect(c).toEqual({ disposition: 'FOREIGN', allowed: false });
  });

  it('an explicitly shared prefix is permitted (SHARED)', () => {
    const c = classifyWrite('a', '.scratch/shared/x', zones, ['.scratch/shared']);
    expect(c).toEqual({ disposition: 'SHARED', allowed: true });
  });

  it('a path in no branch zone is not a cross-branch concern (OWN)', () => {
    const c = classifyWrite('a', 'src/index.ts', zones);
    expect(c.allowed).toBe(true);
  });

  it('assertWriteAllowed throws on a foreign write', () => {
    expect(() => assertWriteAllowed('a', '.scratch/b/x', zones)).toThrowError(BranchIsolationError);
  });

  it('zone boundary is exact — a sibling-prefixed name is not inside the zone', () => {
    // '.scratch/ab/' must not be seen as under '.scratch/a/'.
    const z = allocateScratchZones(['a', 'ab']);
    const c = classifyWrite('a', '.scratch/ab/x', z);
    expect(c.disposition).toBe('FOREIGN');
  });
});

describe('P8-BI1 cancellation — no orphan (AU-006)', () => {
  const clean = (branchId: string): BranchRunOutcome => ({ branchId, runState: 'CANCELLED', orphanPids: [] });

  it('a terminal run with no surviving PID is a clean cancellation', () => {
    expect(isCleanCancellation(clean('a'))).toBe(true);
  });

  it('a run with surviving PIDs is NOT clean', () => {
    expect(isCleanCancellation({ branchId: 'a', runState: 'CANCELLED', orphanPids: [123] })).toBe(false);
  });

  it('a still-RUNNING run is NOT clean', () => {
    expect(isCleanCancellation({ branchId: 'a', runState: 'RUNNING', orphanPids: [] })).toBe(false);
  });

  it('cancelling one branch leaves siblings byte-for-byte unchanged', () => {
    const before: BranchRunOutcome[] = [
      { branchId: 'a', runState: 'RUNNING', orphanPids: [] },
      { branchId: 'b', runState: 'RUNNING', orphanPids: [] },
      { branchId: 'c', runState: 'RUNNING', orphanPids: [] },
    ];
    const after = cancelOneBranch(before, clean('b'));
    expect(after.find((o) => o.branchId === 'a')).toBe(before[0]); // same reference
    expect(after.find((o) => o.branchId === 'c')).toBe(before[2]); // same reference
    expect(after.find((o) => o.branchId === 'b')!.runState).toBe('CANCELLED');
  });

  it('refuses to cancel a branch that would leave an orphan', () => {
    const before: BranchRunOutcome[] = [{ branchId: 'a', runState: 'RUNNING', orphanPids: [] }];
    expect(() =>
      cancelOneBranch(before, { branchId: 'a', runState: 'CANCELLED', orphanPids: [99] }),
    ).toThrowError(BranchIsolationError);
  });
});
