// P10.9 — GoalIngressService: build + queue goals submitted at runtime.
import { describe, it, expect } from 'vitest';
import { GoalIngressService, GoalIngressError } from '@codeforge/agent-core';

function counters(): { now: () => string; nextId: () => string } {
  let t = 0; let n = 0;
  return {
    now: () => '2026-01-01T00:00:' + String(t++ % 60).padStart(2, '0') + '.000Z',
    nextId: () => 'ID-' + String(n++).padStart(4, '0'),
  };
}

describe('P10.9 GoalIngressService', () => {
  it('builds a user-origin Goal with >=1 acceptance criterion and queues it', () => {
    const svc = new GoalIngressService(counters());
    const res = svc.submitGoal({ description: 'Add a /health endpoint' });

    expect(res.goalId).toBeDefined();
    expect(res.position).toBe(1);
    expect(svc.size()).toBe(1);

    const goal = svc.dequeue();
    expect(goal).toBeDefined();
    expect(goal?.description).toBe('Add a /health endpoint');
    expect(goal?.createdBy).toBe('user'); // GL-002
    expect(goal?.version).toBe(1);
    expect(goal?.acceptanceCriteria.length).toBeGreaterThanOrEqual(1); // GL-003
    // Default criterion is the description when none supplied.
    expect(goal?.acceptanceCriteria[0]?.description).toBe('Add a /health endpoint');
  });

  it('maps explicit acceptance criteria', () => {
    const svc = new GoalIngressService(counters());
    svc.submitGoal({ description: 'ship feature', acceptanceCriteria: ['tests pass', 'lint clean'] });
    const goal = svc.dequeue();
    expect(goal?.acceptanceCriteria.map((a) => a.description)).toEqual(['tests pass', 'lint clean']);
    expect(goal?.acceptanceCriteria.every((a) => a.mandatory)).toBe(true);
  });

  it('dequeues in FIFO order and reports position', () => {
    const svc = new GoalIngressService(counters());
    expect(svc.submitGoal({ description: 'A' }).position).toBe(1);
    expect(svc.submitGoal({ description: 'B' }).position).toBe(2);
    expect(svc.submitGoal({ description: 'C' }).position).toBe(3);
    expect(svc.size()).toBe(3);

    expect(svc.dequeue()?.description).toBe('A');
    expect(svc.dequeue()?.description).toBe('B');
    expect(svc.dequeue()?.description).toBe('C');
    expect(svc.dequeue()).toBeUndefined();
    expect(svc.size()).toBe(0);
  });

  it('trims the description and rejects an empty one', () => {
    const svc = new GoalIngressService(counters());
    const r = svc.submitGoal({ description: '  spaced  ' });
    expect(svc.dequeue()?.description).toBe('spaced');
    void r;
    expect(() => svc.submitGoal({ description: '   ' })).toThrow(GoalIngressError);
  });

  it('ignores blank acceptance criteria and falls back to the description', () => {
    const svc = new GoalIngressService(counters());
    svc.submitGoal({ description: 'do X', acceptanceCriteria: ['', '  '] });
    const goal = svc.dequeue();
    expect(goal?.acceptanceCriteria).toHaveLength(1);
    expect(goal?.acceptanceCriteria[0]?.description).toBe('do X');
  });
});
