// AU-003 — Lập lịch song song deterministic trên cùng input.
//
// Enforced by ParallelExecutor.planParallelBatch (P8-PX1): a pure, total function of
// (schedulable ids, concurrency cap, costs, parent budget). Same input → same batch,
// independent of input ordering. Extends SC-006 (the base scheduler determinism).
import { describe, it, expect } from 'vitest';
import { planParallelBatch } from '@codeforge/agent-core';

describe('AU-003 — parallel scheduling is deterministic', () => {
  it('same input yields the same batch across runs', () => {
    const input = { schedulable: ['t3', 't1', 't2'], maxConcurrency: 2 };
    const a = planParallelBatch(input);
    const b = planParallelBatch(input);
    expect(a.admitted).toEqual(b.admitted);
    expect(a.deferred).toEqual(b.deferred);
  });

  it('result is independent of schedulable input ordering', () => {
    const forward = planParallelBatch({ schedulable: ['a', 'b', 'c'], maxConcurrency: 2 });
    const reversed = planParallelBatch({ schedulable: ['c', 'b', 'a'], maxConcurrency: 2 });
    expect(forward.admitted).toEqual(reversed.admitted); // sorted → ['a','b']
  });

  it('admits in deterministic sorted order', () => {
    const r = planParallelBatch({ schedulable: ['z', 'm', 'a'], maxConcurrency: 2 });
    expect(r.admitted).toEqual(['a', 'm']);
  });
});
