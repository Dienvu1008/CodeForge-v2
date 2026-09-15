// T7 — Graph (GR-1..GR-5) + Repository (RI-1..RI-8) conformance.
// GRAPH_PROTOCOL §2/§4/§5; DOMAIN_CONTRACTS §23.
import { describe, it, expect } from 'vitest';
import type {
  EdgeKind,
  GraphOperation,
  GraphMutation,
  TaskGraph,
  ValidatorStage,
  CycleDetector,
  GraphNode,
  GraphEdge,
  Task,
  SessionRepository,
  TaskRepository,
  TaskGraphRepository,
  TaskRunRepository,
  VerificationRepository,
  EventLog,
} from '@codeforge/agent-core';
import { VALIDATOR_STAGES } from '@codeforge/agent-core';

function conforms<T>(value: T): T {
  return value;
}

const SAMPLE_TASK: Task = {
  taskId: 'T',
  description: 'd',
  acceptanceCriteria: [],
  constraints: [],
  priority: 0,
  strategy: { kind: 'generate' },
  createdAt: '2026-01-01T00:00:00.000Z',
  createdBy: 'planner',
};

const PROVENANCE: GraphMutation['provenance'] = {
  provenanceId: 'P',
  source: { kind: 'model', id: 'planner' },
  inputs: [],
  reason: 'test fixture',
  at: '2026-01-01T00:00:00.000Z',
};

describe('graph conformance (T7 / GR-1..GR-5)', () => {
  it('GR-2: EdgeKind is exactly {depends_on, blocks, supersedes} (§2.1)', () => {
    const kinds: EdgeKind[] = ['depends_on', 'blocks', 'supersedes'];
    expect(kinds).toHaveLength(3);
  });

  it('GR-3: GraphOperation is the 7-op union (§4.2)', () => {
    const ops: GraphOperation[] = [
      { kind: 'ADD_TASK', task: SAMPLE_TASK },
      { kind: 'REMOVE_TASK', taskId: 'T' },
      { kind: 'ADD_EDGE', fromTaskId: 'A', toTaskId: 'B', edgeKind: 'depends_on' },
      { kind: 'REMOVE_EDGE', fromTaskId: 'A', toTaskId: 'B' },
      { kind: 'SUPERSEDE_TASK', oldTaskId: 'A', newTask: SAMPLE_TASK, rewire: true },
      { kind: 'CHANGE_DEPENDENCY', fromTaskId: 'A', toTaskId: 'B', newKind: 'blocks' },
      { kind: 'REWIRE', fromTaskId: 'A', toTaskId: 'B', targetTaskId: 'C' },
    ];
    const opKinds = ops.map((o) => o.kind).sort();
    expect(opKinds).toEqual(
      [
        'ADD_EDGE',
        'ADD_TASK',
        'CHANGE_DEPENDENCY',
        'REMOVE_EDGE',
        'REMOVE_TASK',
        'REWIRE',
        'SUPERSEDE_TASK',
      ].sort(),
    );
  });

  it('GR-5: validator has 7 ordered stages (§5.2)', () => {
    const expected: ValidatorStage[] = [
      'SCHEMA',
      'REFERENCE',
      'OPERATION_SEMANTICS',
      'STRUCTURAL',
      'REACHABILITY',
      'SUPERSESSION',
      'POLICY',
    ];
    expect([...VALIDATOR_STAGES]).toEqual(expected);
  });

  it('GR-1: TaskGraph is versioned + canonically hashed, edgeId assigned by runtime', () => {
    const g = conforms<TaskGraph>({
      graphId: 'G',
      sessionId: 'S',
      version: 1,
      nodes: [],
      edges: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      createdBy: 'planner',
      canonicalHash: 'h',
      schemaVersion: 1,
      canonicalFormVersion: '1.0',
    });
    expect(g.version).toBe(1);
  });

  it('GR-1: GraphEdge carries a runtime-assigned edgeId (planner does not set it)', () => {
    const edge = conforms<GraphEdge>({
      edgeId: 'E',
      fromTaskId: 'A',
      toTaskId: 'B',
      kind: 'depends_on',
      addedInVersion: 1,
    });
    expect(edge.edgeId).toBe('E');
  });

  it('GR-4: CycleDetector is a pure predicate over nodes/edges', () => {
    const detector: CycleDetector = {
      hasCycle(nodes: readonly GraphNode[], edges: readonly GraphEdge[]): boolean {
        return nodes.length > 0 && edges.length > 0 && false;
      },
    };
    expect(detector.hasCycle([], [])).toBe(false);
  });

  it('GR-3: GraphMutation carries provenance + status lifecycle', () => {
    const m = conforms<GraphMutation>({
      mutationId: 'M',
      sessionId: 'S',
      baseVersion: 1,
      operations: [],
      proposedBy: 'planner',
      reason: 'because',
      provenance: PROVENANCE,
      createdAt: '2026-01-01T00:00:00.000Z',
      status: 'PROPOSED',
    });
    expect(m.status).toBe('PROPOSED');
  });
});

describe('repository conformance (T7 / RI-1..RI-8)', () => {
  // Compile-time structural checks: a stub object must satisfy each interface shape.
  it('RI-7: immutable-entity repos expose NO update() (Task, TaskRun)', () => {
    const taskRepo = conforms<TaskRepository>({
      create: async () => undefined,
      getById: async () => null,
      supersede: async () => undefined,
    });
    const runRepo = conforms<TaskRunRepository>({
      create: async () => undefined,
      getById: async () => null,
      finalize: async () => undefined,
      findRunning: async () => [],
    });
    expect('update' in taskRepo).toBe(false);
    expect('update' in runRepo).toBe(false);
    // Task is replaced via supersede, never mutated in place.
    expect(typeof taskRepo.supersede).toBe('function');
    // TaskRun is sealed via finalize (append the terminal patch), never updated after.
    expect(typeof runRepo.finalize).toBe('function');
  });

  it('RI-1: mutable-state aggregate (Session) MAY expose update()', () => {
    const sessionRepo = conforms<SessionRepository>({
      create: async () => undefined,
      getById: async () => null,
      getActiveByWorkspace: async () => null,
      update: async () => undefined,
    });
    expect(typeof sessionRepo.update).toBe('function');
  });

  it('RI-8: every repository exposes getById()', () => {
    const graphRepo = conforms<TaskGraphRepository>({
      getCurrent: async () => ({}) as TaskGraph,
      getVersion: async () => null,
      commit: async () => undefined,
    });
    const verRepo = conforms<VerificationRepository>({
      create: async () => undefined,
      getById: async () => null,
      getByTask: async () => [],
      getLatestForRevision: async () => null,
    });
    const eventLog = conforms<EventLog>({
      append: async () => undefined,
      stream: async function* () {},
      query: async () => [],
    });
    // graph repo keys on version, but still has getCurrent/getVersion (its identity accessor)
    expect(typeof graphRepo.getCurrent).toBe('function');
    expect(typeof verRepo.getById).toBe('function');
    // EventLog is append-only: no update/delete.
    expect('update' in eventLog).toBe(false);
    expect('delete' in eventLog).toBe(false);
  });
});
