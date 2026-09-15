// P1-G1 TaskGraph — canonical form + Blake3GraphHasher + GraphService (GI-001, GI-003).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  canonicalGraphForm,
  GraphService,
} from '@codeforge/agent-core';
import type { GraphNode, GraphEdge, TaskGraph, GraphMutation, Provenance } from '@codeforge/agent-core';
import {
  Blake3GraphHasher,
  SqliteDatabaseAdapter,
  SqliteTaskGraphRepository,
  runMigrations,
  createMigrationRegistry,
} from '@codeforge/infrastructure';

const hasher = new Blake3GraphHasher();

function nodes(...ids: string[]): GraphNode[] {
  return ids.map((taskId) => ({ taskId, addedInVersion: 1 }));
}
function edge(from: string, to: string, kind: GraphEdge['kind'] = 'depends_on', id = `E-${from}-${to}`): GraphEdge {
  return { edgeId: id, fromTaskId: from, toTaskId: to, kind, addedInVersion: 1 };
}

describe('canonicalGraphForm (GRAPH_PROTOCOL §2.3)', () => {
  it('is order-independent for nodes and edges', () => {
    const a = canonicalGraphForm(nodes('T1', 'T2', 'T3'), [edge('T1', 'T2'), edge('T2', 'T3')]);
    const b = canonicalGraphForm(nodes('T3', 'T1', 'T2'), [edge('T2', 'T3'), edge('T1', 'T2')]);
    expect(a).toBe(b);
  });

  it('differs when structure differs (extra edge)', () => {
    const a = canonicalGraphForm(nodes('T1', 'T2'), [edge('T1', 'T2')]);
    const b = canonicalGraphForm(nodes('T1', 'T2'), [edge('T1', 'T2'), edge('T2', 'T1', 'blocks')]);
    expect(a).not.toBe(b);
  });

  it('ignores non-structural fields (addedInVersion, edgeId)', () => {
    const a = canonicalGraphForm(
      [{ taskId: 'T1', addedInVersion: 1 }],
      [edge('T1', 'T2', 'depends_on', 'E-a')],
    );
    const b = canonicalGraphForm(
      [{ taskId: 'T1', addedInVersion: 9 }],
      [edge('T1', 'T2', 'depends_on', 'E-zzz')],
    );
    expect(a).toBe(b);
  });
});

describe('Blake3GraphHasher (GI-001 drift detection)', () => {
  it('same structure -> same hash (deterministic)', () => {
    const h1 = hasher.hash(nodes('T1', 'T2'), [edge('T1', 'T2')]);
    const h2 = hasher.hash(nodes('T2', 'T1'), [edge('T1', 'T2')]);
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/); // blake3 256-bit hex
  });

  it('different structure -> different hash', () => {
    const h1 = hasher.hash(nodes('T1', 'T2'), [edge('T1', 'T2')]);
    const h2 = hasher.hash(nodes('T1', 'T2'), [edge('T1', 'T2', 'blocks')]);
    expect(h1).not.toBe(h2);
  });
});

describe('GraphService.build — versioning (GI-003) + canonical hash', () => {
  let svc: GraphService;
  beforeEach(() => {
    let n = 0;
    svc = new GraphService({
      hasher,
      now: () => '2026-01-01T00:00:00.000Z',
      nextId: () => `G-${n++}`,
      canonicalFormVersion: 'v1',
      schemaVersion: 1,
    });
  });

  it('first build is version 1 with no parentVersion', () => {
    const g = svc.build({ sessionId: 'S', nodes: nodes('T1'), edges: [], createdBy: 'planner' });
    expect(g.version).toBe(1);
    expect(g.parentVersion).toBeUndefined();
    expect(g.canonicalHash).toBe(hasher.hash(nodes('T1'), []));
    expect(svc.isConsistent(g)).toBe(true);
  });

  it('next build increments version and keeps the stable graphId (GI-003)', () => {
    const v1 = svc.build({ sessionId: 'S', nodes: nodes('T1'), edges: [], createdBy: 'planner' });
    const v2 = svc.build({
      sessionId: 'S',
      nodes: nodes('T1', 'T2'),
      edges: [edge('T2', 'T1')],
      createdBy: 'replanner',
      parent: v1,
    });
    expect(v2.version).toBe(2);
    expect(v2.parentVersion).toBe(1);
    expect(v2.graphId).toBe(v1.graphId);
  });

  it('detects structural drift (isConsistent false when hash stale)', () => {
    const g = svc.build({ sessionId: 'S', nodes: nodes('T1'), edges: [], createdBy: 'planner' });
    const tampered: TaskGraph = { ...g, nodes: nodes('T1', 'HACKED') };
    expect(svc.isConsistent(tampered)).toBe(false);
  });
});

describe('GraphService + TaskGraphRepository — build then commit (GI-003)', () => {
  let db: SqliteDatabaseAdapter;
  let repo: SqliteTaskGraphRepository;
  let svc: GraphService;

  const provenance: Provenance = {
    provenanceId: 'P',
    source: { kind: 'model', id: 'planner' },
    inputs: [],
    reason: 'plan',
    at: '2026-01-01T00:00:00.000Z',
  };
  function mutation(baseVersion: number): GraphMutation {
    return {
      mutationId: `M-${baseVersion}`,
      sessionId: 'S',
      baseVersion,
      operations: [],
      proposedBy: 'planner',
      reason: 'plan',
      provenance,
      createdAt: '2026-01-01T00:00:00.000Z',
      status: 'COMMITTED',
    };
  }

  beforeEach(() => {
    db = new SqliteDatabaseAdapter(':memory:');
    db.open();
    runMigrations(db, createMigrationRegistry(), { now: () => '2026-01-01T00:00:00.000Z' });
    db.execute(
      `INSERT INTO sessions
        (session_id, workspace_id, workspace_root, goal_id, graph_version, state,
         created_at, updated_at, runtime_version, schema_version, budget_id, lock_id, metadata_json)
       VALUES ('S','W','/r','G',1,'RUNNING','t','t','0.1.0',1,'B','L','{}')`,
    );
    repo = new SqliteTaskGraphRepository(db);
    let n = 0;
    svc = new GraphService({
      hasher,
      now: () => '2026-01-01T00:00:00.000Z',
      nextId: () => `G-${n++}`,
      canonicalFormVersion: 'v1',
      schemaVersion: 1,
    });
  });
  afterEach(() => db.close());

  it('builds v1, commits it, and reads it back with a matching canonical hash', async () => {
    const v1 = svc.build({
      sessionId: 'S',
      nodes: nodes('T1'),
      edges: [],
      createdBy: 'planner',
      mutationId: 'M-0',
    });
    await repo.commit(v1, mutation(0));
    const current = await repo.getCurrent('S');
    expect(current.version).toBe(1);
    expect(current.canonicalHash).toBe(v1.canonicalHash);
    expect(svc.isConsistent(current)).toBe(true);
  });

  it('rejects committing the same version twice (GI-003 monotonic)', async () => {
    const v1 = svc.build({ sessionId: 'S', nodes: nodes('T1'), edges: [], createdBy: 'planner' });
    await repo.commit(v1, mutation(0));
    await expect(repo.commit(v1, mutation(0))).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
  });
});
