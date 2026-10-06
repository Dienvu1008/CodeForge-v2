// AU-004 — Mỗi nhánh song song chịu Budget phân cấp (child <= parent.remaining).
//
// Invariants-first: BU-001 already enforces hierarchical budget. Contract for P8-PX1:
// running N branches in parallel must debit the shared parent budget so the total
// never exceeds parent.remaining — parallelism must not be a way to escape the cap.
import { describe, it } from 'vitest';

describe('AU-004 — parallel branches respect the hierarchical budget', () => {
  it.todo('sum of parallel branch budgets never exceeds parent.remaining (BU-001) (P8-PX1)');
  it.todo('a branch whose budget is exhausted is not scheduled (SC-004) (P8-PX1)');
});
