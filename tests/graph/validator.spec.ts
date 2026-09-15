// P1-G2 GraphValidator — GRAPH_PROTOCOL §5 (GI-002/004/005/006/007) + cycle detection.
import { describe, it, expect } from 'vitest';
import {
  validateMutation,
  DfsCycleDetector,
  hasCycleOfKinds,
} from '@codeforge/agent-core';
import type {
  TaskGraph,
  GraphMutation,
  GraphOperation,
  GraphNode,
  GraphEdge,
  Task,
  Provenance,
  ValidationContext,
} from '@codeforge/agent-core';

const PROVENANCE: Provenance = {
  provenanceId: 'P',
  source: { kind: 'model', id: 'planner' },
  inputs: [],
  reason: 'plan',
  at: '2026-01-01T00:00:00.000Z',
};

function task(id: string): Task {
  return {
    taskId: id,
    description: id,
    acceptanceCriteria: [],
    constraints: [],
    priority: 0,
    strategy: { kind: 'generate' },
    createdAt: '2026-01-01T00:00:00.000Z',
    createdBy: 'planner',
  };
}
function node(id: string): GraphNode {
  return { taskId: id, addedInVersion: 1 };
}
function edge(from: string, to: string, kind: GraphEdge['kind'] = 'depends_on'): GraphEdge {
  return { edgeId: `E-${from}-${to}-${kind}`, fromTaskId: from, toTaskId: to, kind, addedInVersion: 1 };
}
function graph(nodes: GraphNode[], edges: GraphEdge[], version = 1): TaskGraph {
  return {
    graphId: 'G',
    sessionId: 'S',
    version,
    nodes,
    edges,
    createdAt: '2026-01-01T00:00:00.000Z',
    createdBy: 'planner',
    canonicalHash: 'h',
    schemaVersion: 1,
    canonicalFormVersion: 'v1',
  };
}
function mutation(ops: GraphOperation[], baseVersion = 1): GraphMutation {
  return {
    mutationId: 'M',
    sessionId: 'S',
    baseVersion,
    operations: ops,
    proposedBy: 'planner',
    reason: 'r',
    provenance: PROVENANCE,
    createdAt: '2026-01-01T00:00:00.000Z',
    status: 'PROPOSED',
  };
}
const codes = (r: { errors: readonly { code: string }[] }) => r.errors.map((e) => e.code);

describe('cycle detection (GI-004)', () => {
  it('detects a dependency cycle', () => {
    const nodes = [node('A'), node('B'), node('C')];
    const cyc = [edge('A', 'B'), edge('B', 'C'), edge('C', 'A')];
    expect(hasCycleOfKinds(nodes, cyc, new Set(['depends_on', 'blocks']))).toBe(true);
    expect(new DfsCycleDetector().hasCycle(nodes, cyc)).toBe(true);
  });
  it('accepts a DAG', () => {
    const nodes = [node('A'), node('B'), node('C')];
    const dag = [edge('A', 'B'), edge('B', 'C')];
    expect(new DfsCycleDetector().hasCycle(nodes, dag)).toBe(false);
  });
  it('flags a self-loop', () => {
    expect(new DfsCycleDetector().hasCycle([node('A')], [edge('A', 'A')])).toBe(true);
  });
});

describe('Stage 1 SCHEMA', () => {
  it('rejects an empty operation list', () => {
    const r = validateMutation(graph([node('A')], []), mutation([]));
    expect(r.status).toBe('REJECTED');
    expect(codes(r)).toContain('SCHEMA_INVALID');
  });
  it('rejects a duplicate taskId in ADD_TASK (TASK_ID_DUPLICATE)', () => {
    const r = validateMutation(graph([node('A')], []), mutation([{ kind: 'ADD_TASK', task: task('A') }]));
    expect(codes(r)).toContain('TASK_ID_DUPLICATE');
  });
});

describe('Stage 2 REFERENCE (GI-005)', () => {
  it('rejects an edge to a non-existent task (MISSING_REFERENCE)', () => {
    const r = validateMutation(
      graph([node('A')], []),
      mutation([{ kind: 'ADD_EDGE', fromTaskId: 'A', toTaskId: 'GHOST', edgeKind: 'depends_on' }]),
    );
    expect(codes(r)).toContain('MISSING_REFERENCE');
  });
  it('allows an edge to a task added in the same mutation', () => {
    const r = validateMutation(
      graph([node('A')], []),
      mutation([
        { kind: 'ADD_TASK', task: task('B') },
        { kind: 'ADD_EDGE', fromTaskId: 'A', toTaskId: 'B', edgeKind: 'depends_on' },
      ]),
    );
    expect(r.status).toBe('VALIDATED');
  });
});

describe('Stage 3 OPERATION_SEMANTICS', () => {
  it('rejects removing a task that still has edges without cascade (GI-006 CASCADE_VIOLATION)', () => {
    const g = graph([node('A'), node('B')], [edge('A', 'B')]);
    const r = validateMutation(g, mutation([{ kind: 'REMOVE_TASK', taskId: 'B' }]));
    expect(codes(r)).toContain('CASCADE_VIOLATION');
  });
  it('allows REMOVE_TASK with cascade_edges', () => {
    const g = graph([node('A'), node('B')], [edge('A', 'B')]);
    const r = validateMutation(g, mutation([{ kind: 'REMOVE_TASK', taskId: 'B', cascade: 'cascade_edges' }]));
    expect(r.status).toBe('VALIDATED');
  });
  it('rejects removing a non-existent edge (EDGE_NOT_FOUND)', () => {
    const r = validateMutation(
      graph([node('A'), node('B')], []),
      mutation([{ kind: 'REMOVE_EDGE', fromTaskId: 'A', toTaskId: 'B' }]),
    );
    expect(codes(r)).toContain('EDGE_NOT_FOUND');
  });
  it('rejects a duplicate ADD_EDGE (EDGE_ALREADY_EXISTS)', () => {
    const g = graph([node('A'), node('B')], [edge('A', 'B')]);
    const r = validateMutation(g, mutation([{ kind: 'ADD_EDGE', fromTaskId: 'A', toTaskId: 'B', edgeKind: 'depends_on' }]));
    expect(codes(r)).toContain('EDGE_ALREADY_EXISTS');
  });
});

describe('Stage 4 STRUCTURAL (GI-004)', () => {
  it('rejects a mutation that introduces a cycle', () => {
    const g = graph([node('A'), node('B')], [edge('A', 'B')]);
    const r = validateMutation(g, mutation([{ kind: 'ADD_EDGE', fromTaskId: 'B', toTaskId: 'A', edgeKind: 'depends_on' }]));
    expect(r.status).toBe('REJECTED');
    expect(codes(r)).toContain('CYCLE_DETECTED');
  });
  it('rejects a self-loop edge', () => {
    const g = graph([node('A')], []);
    const r = validateMutation(g, mutation([{ kind: 'ADD_EDGE', fromTaskId: 'A', toTaskId: 'A', edgeKind: 'depends_on' }]));
    expect(codes(r)).toContain('SELF_LOOP');
  });
});

describe('Stage 6 SUPERSESSION (GI-007)', () => {
  it('supersede adds new task, marks old superseded, links supersedes edge', () => {
    const g = graph([node('A'), node('B')], [edge('A', 'B')]);
    const r = validateMutation(
      g,
      mutation([{ kind: 'SUPERSEDE_TASK', oldTaskId: 'B', newTask: task('B2'), rewire: true }]),
    );
    expect(r.status).toBe('VALIDATED');
  });
  it('rejects superseding a task with a RUNNING execution (§6.4)', () => {
    const g = graph([node('A'), node('B')], [edge('A', 'B')]);
    const ctx: ValidationContext = { runningTaskIds: new Set(['B']) };
    const r = validateMutation(
      g,
      mutation([{ kind: 'SUPERSEDE_TASK', oldTaskId: 'B', newTask: task('B2'), rewire: true }]),
      ctx,
    );
    expect(codes(r)).toContain('SUPERSEDE_WITH_RUNNING_EXECUTION');
  });
});

describe('Stage 7 POLICY', () => {
  it('rejects a mutation exceeding maxOps (MUTATION_TOO_LARGE)', () => {
    const ops: GraphOperation[] = Array.from({ length: 3 }, (_, i) => ({ kind: 'ADD_TASK', task: task(`X${i}`) }));
    const r = validateMutation(graph([node('A')], []), mutation(ops), { maxOps: 2 });
    expect(codes(r)).toContain('MUTATION_TOO_LARGE');
  });
  it('rejects removing a PASSED task (REMOVE_PASSED_TASK)', () => {
    const g = graph([node('A'), node('B')], []);
    const r = validateMutation(
      g,
      mutation([{ kind: 'REMOVE_TASK', taskId: 'B' }]),
      { passedTaskIds: new Set(['B']) },
    );
    expect(codes(r)).toContain('REMOVE_PASSED_TASK');
  });
});

describe('happy path', () => {
  it('validates a clean add-task + add-edge mutation', () => {
    const g = graph([node('A')], []);
    const r = validateMutation(
      g,
      mutation([
        { kind: 'ADD_TASK', task: task('B') },
        { kind: 'ADD_EDGE', fromTaskId: 'B', toTaskId: 'A', edgeKind: 'depends_on' },
      ]),
    );
    expect(r.status).toBe('VALIDATED');
    expect(r.errors).toEqual([]);
    expect(r.appliedOps).toBe(2);
  });
});
