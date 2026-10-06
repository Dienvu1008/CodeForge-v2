// AU-005 — Hai nhánh/agent không ghi đè workspace của nhau ngoài policy (isolation).
//
// Invariants-first: enforcement lands with P8-BI1 (BranchIsolation). Contract: each
// parallel branch gets an isolated scratch zone (VR-003/WS spirit); writes outside a
// branch's own zone are rejected, so concurrent branches cannot clobber each other.
import { describe, it } from 'vitest';

describe('AU-005 — parallel branches are workspace-isolated', () => {
  it.todo('each branch has a disjoint scratch zone (P8-BI1)');
  it.todo('a branch cannot write into another branch\'s zone outside explicit policy (P8-BI1)');
});
