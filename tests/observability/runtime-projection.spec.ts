// P9.2 — RuntimeProjection.computeRuntimeProjection (pure read-model reducer).
import { describe, it, expect } from 'vitest';
import {
  computeRuntimeProjection,
  type RuntimeInput,
  type TaskStateInput,
  type BudgetInput,
} from '@codeforge/agent-core';

function task(taskId: string, state: TaskStateInput['state'], attempts = 1): TaskStateInput {
  return { taskId, state, attempts };
}

function input(over: Partial<RuntimeInput> = {}): RuntimeInput {
  return {
    sessionId: 'S', sessionState: 'RUNNING', goalId: 'G', graphVersion: 2,
    workspaceRevisionId: 'R1', tasks: [], edges: [], activeRuns: [],
    ...over,
  };
}

describe('P9.2 computeRuntimeProjection — task tree + status', () => {
  it('projects tasks sorted by id with terminal/active/blocked flags', () => {
    const p = computeRuntimeProjection(input({
      tasks: [task('b', 'READY'), task('a', 'PASSED'), task('c', 'PENDING')],
      edges: [{ fromTaskId: 'c', toTaskId: 'a' }],
    }));
    expect(p.tasks.map((t) => t.taskId)).toEqual(['a', 'b', 'c']);
    expect(p.tasks[0]!.isTerminal).toBe(true); // a PASSED
    // c depends_on a (PASSED) → not blocked
    expect(p.tasks[2]!.isBlocked).toBe(false);
    expect(p.passedTaskIds).toEqual(['a']);
  });

  it('marks a task blocked when a dependency has not PASSED', () => {
    const p = computeRuntimeProjection(input({
      tasks: [task('a', 'RUNNING'), task('b', 'PENDING')],
      edges: [{ fromTaskId: 'b', toTaskId: 'a' }], // b depends_on a (not PASSED)
    }));
    const b = p.tasks.find((t) => t.taskId === 'b')!;
    expect(b.isBlocked).toBe(true);
    expect(b.blockedBy).toEqual(['a']);
    expect(p.blockedTaskIds).toEqual(['b']);
  });

  it('derives active tasks from active runs and RUNNING state', () => {
    const p = computeRuntimeProjection(input({
      tasks: [task('a', 'RUNNING'), task('b', 'READY')],
      activeRuns: [{ taskRunId: 'TR1', taskId: 'b', attemptNumber: 1, startedAt: 't' }],
    }));
    expect([...p.activeTaskIds].sort()).toEqual(['a', 'b']); // a RUNNING, b has active run
    expect(p.activeRunCount).toBe(1);
  });

  it('counts tasks by category', () => {
    const p = computeRuntimeProjection(input({
      tasks: [task('a', 'PASSED'), task('b', 'FAILED'), task('c', 'PENDING'), task('d', 'RUNNING')],
    }));
    expect(p.counts).toEqual({ total: 4, passed: 1, active: 1, blocked: 0, failed: 1, pending: 1 });
  });

  it('carries session metadata and model/provider when present', () => {
    const p = computeRuntimeProjection(input({ model: 'qwen2.5-coder', provider: 'ollama' }));
    expect(p.sessionState).toBe('RUNNING');
    expect(p.graphVersion).toBe(2);
    expect(p.model).toBe('qwen2.5-coder');
    expect(p.provider).toBe('ollama');
  });

  it('is deterministic — same input yields the same projection', () => {
    const i = input({ tasks: [task('b', 'READY'), task('a', 'PASSED')] });
    expect(computeRuntimeProjection(i)).toEqual(computeRuntimeProjection(i));
  });
});

describe('P9.2 computeRuntimeProjection — budget', () => {
  const budget: BudgetInput = {
    limits: { wallClockMs: 1000, modelTokens: 100, toolCalls: 10, recoveryAttempts: 2 },
    consumed: { wallClockMs: 500, modelTokens: 90, toolCalls: 2, recoveryAttempts: 0 },
    state: 'ACTIVE',
  };

  it('computes remaining per dimension and pressure = tightest ratio', () => {
    const p = computeRuntimeProjection(input({ budget }));
    expect(p.budget!.remaining).toEqual({ wallClockMs: 500, modelTokens: 10, toolCalls: 8, recoveryAttempts: 2 });
    expect(p.budget!.pressure).toBeCloseTo(0.9); // modelTokens 90/100 is tightest
  });

  it('clamps remaining at 0 and pressure at 1 on overrun', () => {
    const p = computeRuntimeProjection(input({
      budget: { ...budget, consumed: { wallClockMs: 2000, modelTokens: 100, toolCalls: 10, recoveryAttempts: 2 } },
    }));
    expect(p.budget!.remaining.wallClockMs).toBe(0);
    expect(p.budget!.pressure).toBe(1);
  });

  it('omits budget when not provided', () => {
    expect(computeRuntimeProjection(input()).budget).toBeUndefined();
  });
});

describe('P9.2 computeRuntimeProjection — not authority (OB-005)', () => {
  it('returns a plain data read-model — no mutator, no repository handle', () => {
    const p = computeRuntimeProjection(input({ tasks: [task('a', 'PASSED')] }));
    // Output is pure data: keys are read fields only, nothing callable.
    for (const v of Object.values(p)) {
      expect(typeof v).not.toBe('function');
    }
  });
});
