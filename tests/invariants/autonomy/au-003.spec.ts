// AU-003 — Lập lịch song song deterministic trên cùng input.
//
// Invariants-first: the base scheduler is already deterministic (SC-006 —
// computeSchedule is a pure function of graph + states + budget). P8-PX1's parallel
// selection must preserve this: same input → same set of branches, same order.
import { describe, it } from 'vitest';

describe('AU-003 — parallel scheduling is deterministic', () => {
  it.todo('ParallelExecutor selects the same ready-set across runs for the same input (P8-PX1)');
  it.todo('parallel decision is pure — no clock, no randomness (extends SC-006) (P8-PX1)');
});
