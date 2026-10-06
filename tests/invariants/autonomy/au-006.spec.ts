// AU-006 — Hủy một nhánh song song không để lại orphan.
//
// Invariants-first: EX-006 / CP-006 already require cancellation to leave no orphan
// state/process. Contract for P8-PX1: cancelling one branch must terminate its run +
// child processes and leave it in a non-orphan terminal state, without affecting
// sibling branches.
import { describe, it } from 'vitest';

describe('AU-006 — cancelling a parallel branch leaves no orphan', () => {
  it.todo('cancelled branch reaches a non-orphan terminal state (EX-006) (P8-PX1)');
  it.todo('cancelling one branch does not disturb sibling branches (P8-PX1)');
});
