// AU-006 — Hủy một nhánh song song không để lại orphan.
//
// Enforced by BranchIsolation (P8-BI1), on top of EX-006/CP-006: a branch cancellation
// is "clean" only when its run reached a terminal state AND its process tree was fully
// reconciled (zero surviving PIDs). cancelOneBranch refuses to seal a cancellation that
// would leave an orphan, and leaves sibling branches untouched.
import { describe, it, expect } from 'vitest';
import {
  isCleanCancellation,
  cancelOneBranch,
  BranchIsolationError,
  type BranchRunOutcome,
} from '@codeforge/agent-core';

describe('AU-006 — cancelling a parallel branch leaves no orphan', () => {
  it('cancelled branch reaches a non-orphan terminal state (EX-006)', () => {
    expect(isCleanCancellation({ branchId: 'a', runState: 'CANCELLED', orphanPids: [] })).toBe(true);
    // Terminal but with a surviving PID → NOT clean.
    expect(isCleanCancellation({ branchId: 'a', runState: 'CANCELLED', orphanPids: [7] })).toBe(false);
    // Non-terminal → NOT clean.
    expect(isCleanCancellation({ branchId: 'a', runState: 'RUNNING', orphanPids: [] })).toBe(false);
  });

  it('cancelling one branch does not disturb sibling branches', () => {
    const before: BranchRunOutcome[] = [
      { branchId: 'a', runState: 'RUNNING', orphanPids: [] },
      { branchId: 'b', runState: 'RUNNING', orphanPids: [] },
    ];
    const after = cancelOneBranch(before, { branchId: 'a', runState: 'CANCELLED', orphanPids: [] });
    // Sibling 'b' is preserved verbatim (same reference).
    expect(after.find((o) => o.branchId === 'b')).toBe(before[1]);
    expect(after.find((o) => o.branchId === 'a')!.runState).toBe('CANCELLED');
  });

  it('refuses a cancellation that would leave an orphan', () => {
    const before: BranchRunOutcome[] = [{ branchId: 'a', runState: 'RUNNING', orphanPids: [] }];
    expect(() =>
      cancelOneBranch(before, { branchId: 'a', runState: 'CANCELLED', orphanPids: [42] }),
    ).toThrowError(BranchIsolationError);
  });
});
