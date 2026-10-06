// AU-004 — Mỗi nhánh song song chịu Budget phân cấp (child <= parent.remaining).
//
// Enforced by ParallelExecutor.planParallelBatch (P8-PX1): admission stops once the
// CUMULATIVE cost of the batch would exceed the parent's remaining budget, so a
// parallel batch can never consume more than the parent allows (BU-001 extended).
import { describe, it, expect } from 'vitest';
import { planParallelBatch, type TaskCost } from '@codeforge/agent-core';

const cost = (toolCalls: number): TaskCost => ({
  wallClockMs: 0, modelTokens: 0, toolCalls, recoveryAttempts: 0,
});

describe('AU-004 — parallel branches respect the hierarchical budget', () => {
  it('defers tasks once cumulative cost would exceed parent.remaining', () => {
    const r = planParallelBatch({
      schedulable: ['a', 'b', 'c'],
      maxConcurrency: 10, // concurrency is not the binding constraint here
      cost: new Map([['a', cost(2)], ['b', cost(2)], ['c', cost(2)]]),
      parentRemaining: { wallClockMs: 0, modelTokens: 0, toolCalls: 5, recoveryAttempts: 0 },
    });
    // a(2) + b(2) = 4 <= 5 admitted; c would make 6 > 5 → deferred (budget).
    expect(r.admitted).toEqual(['a', 'b']);
    expect(r.deferred).toEqual([{ taskId: 'c', reason: 'budget' }]);
  });

  it('cumulative admitted cost never exceeds the parent remaining (any dimension)', () => {
    const r = planParallelBatch({
      schedulable: ['a', 'b', 'c', 'd'],
      maxConcurrency: 10,
      cost: new Map([['a', cost(3)], ['b', cost(3)], ['c', cost(3)], ['d', cost(3)]]),
      parentRemaining: { wallClockMs: 0, modelTokens: 0, toolCalls: 7, recoveryAttempts: 0 },
    });
    const total = r.admitted.reduce((s) => s + 3, 0);
    expect(total).toBeLessThanOrEqual(7);
  });

  it('admits a task whose cost sits exactly on the remaining boundary', () => {
    const r = planParallelBatch({
      schedulable: ['a'],
      maxConcurrency: 10,
      cost: new Map([['a', cost(5)]]),
      parentRemaining: { wallClockMs: 0, modelTokens: 0, toolCalls: 5, recoveryAttempts: 0 },
    });
    expect(r.admitted).toEqual(['a']); // 5 <= 5
  });

  it('with no parentRemaining, budget is not a constraint', () => {
    const r = planParallelBatch({
      schedulable: ['a', 'b'],
      maxConcurrency: 10,
      cost: new Map([['a', cost(1000)], ['b', cost(1000)]]),
    });
    expect(r.admitted).toEqual(['a', 'b']);
  });
});
