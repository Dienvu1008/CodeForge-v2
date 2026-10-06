// AU-001 — Task song song không bypass ToolGateway/Policy — mọi tác động vẫn qua kernel.
//
// The parallel layer is split into a pure PLANNER (ParallelExecutor.planParallelBatch,
// P8-PX1) and the EXECUTION it feeds (the existing ExecutionCoordinator/ToolGateway).
// The planner only decides WHICH ready tasks may run concurrently and returns their
// ids — it performs no I/O, no tool calls, no model calls. There is therefore no
// parallel side-channel into the kernel: every admitted task is still executed by the
// caller through the normal coordinator/gateway path (TG-001).
import { describe, it, expect } from 'vitest';
import { planParallelBatch, type ParallelBatch } from '@codeforge/agent-core';

describe('AU-001 — parallel execution never bypasses the kernel', () => {
  it('the planner is pure data-in/data-out — only task ids, no execution channel', () => {
    const r: ParallelBatch = planParallelBatch({ schedulable: ['a', 'b'], maxConcurrency: 2 });
    // Output is just ids + defer reasons — nothing executable, no handles/sockets/fds.
    expect(r.admitted.every((x) => typeof x === 'string')).toBe(true);
    expect(Object.keys(r).sort()).toEqual(['admitted', 'deferred']);
  });

  it('the planner does not mutate its input (no hidden side effects)', () => {
    const schedulable = ['a', 'b', 'c'];
    const snapshot = [...schedulable];
    planParallelBatch({ schedulable, maxConcurrency: 1 });
    expect(schedulable).toEqual(snapshot);
  });

  // Full end-to-end "every admitted task runs via ToolGateway" is covered by the
  // P8-I1 integration E2E (the planner has no way to execute anything itself).
  it.todo('E2E: each admitted task is executed through ExecutionCoordinator + ToolGateway (P8-I1)');
});
