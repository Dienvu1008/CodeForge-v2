// P8-PX1 — ParallelExecutor.planParallelBatch (deterministic parallel-batch planner).
import { describe, it, expect } from 'vitest';
import { planParallelBatch, type TaskCost } from '@codeforge/agent-core';

const cost = (toolCalls: number): TaskCost => ({
  wallClockMs: 0, modelTokens: 0, toolCalls, recoveryAttempts: 0,
});

describe('P8-PX1 planParallelBatch — concurrency cap', () => {
  it('admits up to maxConcurrency and defers the rest with reason concurrency', () => {
    const r = planParallelBatch({ schedulable: ['a', 'b', 'c', 'd'], maxConcurrency: 2 });
    expect(r.admitted).toEqual(['a', 'b']);
    expect(r.deferred).toEqual([
      { taskId: 'c', reason: 'concurrency' },
      { taskId: 'd', reason: 'concurrency' },
    ]);
  });

  it('admits all when the cap exceeds the ready count', () => {
    const r = planParallelBatch({ schedulable: ['a', 'b'], maxConcurrency: 5 });
    expect(r.admitted).toEqual(['a', 'b']);
    expect(r.deferred).toEqual([]);
  });

  it('maxConcurrency 1 degrades to sequential (one admitted)', () => {
    const r = planParallelBatch({ schedulable: ['a', 'b', 'c'], maxConcurrency: 1 });
    expect(r.admitted).toEqual(['a']);
    expect(r.deferred.map((d) => d.taskId)).toEqual(['b', 'c']);
  });

  it('empty schedulable → empty batch', () => {
    const r = planParallelBatch({ schedulable: [], maxConcurrency: 3 });
    expect(r.admitted).toEqual([]);
    expect(r.deferred).toEqual([]);
  });

  it('maxConcurrency 0 admits nothing', () => {
    const r = planParallelBatch({ schedulable: ['a'], maxConcurrency: 0 });
    expect(r.admitted).toEqual([]);
    expect(r.deferred).toEqual([{ taskId: 'a', reason: 'concurrency' }]);
  });
});

describe('P8-PX1 planParallelBatch — concurrency + budget interaction', () => {
  it('concurrency is checked before budget (a cap-blocked task reports concurrency)', () => {
    const r = planParallelBatch({
      schedulable: ['a', 'b', 'c'],
      maxConcurrency: 1,
      cost: new Map([['a', cost(1)], ['b', cost(100)], ['c', cost(1)]]),
      parentRemaining: { wallClockMs: 0, modelTokens: 0, toolCalls: 2, recoveryAttempts: 0 },
    });
    // Only 'a' fits the cap of 1; b and c are deferred by concurrency (not budget),
    // because the cap binds first.
    expect(r.admitted).toEqual(['a']);
    expect(r.deferred).toEqual([
      { taskId: 'b', reason: 'concurrency' },
      { taskId: 'c', reason: 'concurrency' },
    ]);
  });

  it('skips an over-budget task but can still admit a later cheaper one', () => {
    const r = planParallelBatch({
      schedulable: ['a', 'b', 'c'],
      maxConcurrency: 10,
      cost: new Map([['a', cost(1)], ['b', cost(100)], ['c', cost(1)]]),
      parentRemaining: { wallClockMs: 0, modelTokens: 0, toolCalls: 3, recoveryAttempts: 0 },
    });
    // a(1) admitted; b(100) over → deferred budget; c(1) still fits (1+1=2<=3) → admitted.
    expect(r.admitted).toEqual(['a', 'c']);
    expect(r.deferred).toEqual([{ taskId: 'b', reason: 'budget' }]);
  });

  it('enforces the budget across all four dimensions', () => {
    const r = planParallelBatch({
      schedulable: ['a', 'b'],
      maxConcurrency: 10,
      cost: new Map([
        ['a', { wallClockMs: 10, modelTokens: 0, toolCalls: 0, recoveryAttempts: 0 }],
        ['b', { wallClockMs: 10, modelTokens: 0, toolCalls: 0, recoveryAttempts: 0 }],
      ]),
      parentRemaining: { wallClockMs: 15, modelTokens: 999, toolCalls: 999, recoveryAttempts: 999 },
    });
    // a(10ms) admitted; b would make 20ms > 15ms wallClock → deferred budget.
    expect(r.admitted).toEqual(['a']);
    expect(r.deferred).toEqual([{ taskId: 'b', reason: 'budget' }]);
  });
});
