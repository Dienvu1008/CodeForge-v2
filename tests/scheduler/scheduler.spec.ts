// P1-SC1 Scheduler — deterministic READY computation + selection (SC-001..006).
import { describe, it, expect } from 'vitest';
import { computeSchedule, dependenciesSatisfied, isReadyEligible } from '@codeforge/agent-core';
import type { GraphNode, GraphEdge, TaskState, ScheduleInput } from '@codeforge/agent-core';

function node(id: string): GraphNode {
  return { taskId: id, addedInVersion: 1 };
}
function edge(from: string, to: string, kind: GraphEdge['kind'] = 'depends_on'): GraphEdge {
  return { edgeId: `E-${from}-${to}-${kind}`, fromTaskId: from, toTaskId: to, kind, addedInVersion: 1 };
}
function input(
  nodes: GraphNode[],
  edges: GraphEdge[],
  states: Record<string, TaskState>,
  budgetOk?: Record<string, boolean>,
): ScheduleInput {
  return {
    nodes,
    edges,
    states: new Map(Object.entries(states)),
    ...(budgetOk ? { budgetOk: new Map(Object.entries(budgetOk)) } : {}),
  };
}

describe('computeSchedule — SC-003 dependency readiness', () => {
  it('a root task with no deps is newlyReady when PENDING', () => {
    const r = computeSchedule(input([node('A')], [], { A: 'PENDING' }));
    expect(r.newlyReady).toEqual(['A']);
  });

  it('A depends_on B: A becomes ready only when B is PASSED', () => {
    // A --depends_on--> B  =>  B must PASS before A ready.
    const edges = [edge('A', 'B')];
    const nodes = [node('A'), node('B')];
    // B not passed yet → A not ready.
    expect(computeSchedule(input(nodes, edges, { A: 'PENDING', B: 'RUNNING' })).newlyReady).toEqual([]);
    // B passed → A ready.
    expect(computeSchedule(input(nodes, edges, { A: 'PENDING', B: 'PASSED' })).newlyReady).toEqual(['A']);
  });

  it('handles the blocks alias (A blocks B ≡ B depends_on A)', () => {
    const edges = [edge('A', 'B', 'blocks')]; // A must PASS before B
    const nodes = [node('A'), node('B')];
    expect(computeSchedule(input(nodes, edges, { A: 'RUNNING', B: 'PENDING' })).newlyReady).toEqual([]);
    expect(computeSchedule(input(nodes, edges, { A: 'PASSED', B: 'PENDING' })).newlyReady).toEqual(['B']);
  });

  it('ignores supersedes edges (not a dependency)', () => {
    const edges = [edge('A2', 'A', 'supersedes')];
    const r = computeSchedule(input([node('A2'), node('A')], edges, { A2: 'PENDING', A: 'SUPERSEDED' }));
    // A2 has no *dependency* predecessor → ready.
    expect(r.newlyReady).toContain('A2');
  });
});

describe('computeSchedule — SC-002 only READY schedulable', () => {
  it('schedulable contains only READY tasks', () => {
    const r = computeSchedule(
      input([node('A'), node('B'), node('C')], [], { A: 'READY', B: 'RUNNING', C: 'PENDING' }),
    );
    expect(r.schedulable).toEqual(['A']);
    expect(r.next).toBe('A');
  });
});

describe('computeSchedule — SC-004 budget gate', () => {
  it('excludes a READY task whose budget is exhausted', () => {
    const r = computeSchedule(
      input([node('A'), node('B')], [], { A: 'READY', B: 'READY' }, { A: false, B: true }),
    );
    expect(r.schedulable).toEqual(['B']);
    expect(r.next).toBe('B');
  });
  it('no next when all READY tasks are over budget', () => {
    const r = computeSchedule(input([node('A')], [], { A: 'READY' }, { A: false }));
    expect(r.schedulable).toEqual([]);
    expect(r.next).toBeUndefined();
  });
});

describe('computeSchedule — SC-001/SC-006 determinism', () => {
  it('same input -> same decision, stable tie-break (lexicographic)', () => {
    const nodes = [node('C'), node('A'), node('B')];
    const states = { A: 'READY' as TaskState, B: 'READY' as TaskState, C: 'READY' as TaskState };
    const r1 = computeSchedule(input(nodes, [], states));
    const r2 = computeSchedule(input(nodes, [], states));
    expect(r1).toEqual(r2);
    expect(r1.schedulable).toEqual(['A', 'B', 'C']); // sorted, deterministic
    expect(r1.next).toBe('A');
  });
});

describe('helpers', () => {
  it('dependenciesSatisfied returns true for a root', () => {
    const preds = new Map<string, Set<string>>();
    expect(dependenciesSatisfied('A', preds, new Map())).toBe(true);
  });
  it('isReadyEligible reflects SC-003 for a PENDING task', () => {
    const inp = input([node('A'), node('B')], [edge('A', 'B')], { A: 'PENDING', B: 'PASSED' });
    expect(isReadyEligible('A', inp)).toBe(true);
    const inp2 = input([node('A'), node('B')], [edge('A', 'B')], { A: 'PENDING', B: 'FAILED' });
    expect(isReadyEligible('A', inp2)).toBe(false);
  });
});
