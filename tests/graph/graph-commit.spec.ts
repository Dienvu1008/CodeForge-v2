// P1-G3 GraphCommit — GraphCommitService + SqliteGraphCommitter (GI-002/007/008).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  SqliteDatabaseAdapter,
  SqliteTaskGraphRepository,
  SqliteTaskRepository,
  SqliteGraphCommitter,
  SqliteEventLog,
  Blake3GraphHasher,
  runMigrations,
  createMigrationRegistry,
} from '@codeforge/infrastructure';
import {
  GraphCommitService,
  GraphCommitError,
  GraphService,
} from '@codeforge/agent-core';
import type { Task, GraphMutation, GraphOperation, TaskGraph, Provenance } from '@codeforge/agent-core';

let db: SqliteDatabaseAdapter;
let graphs: SqliteTaskGraphRepository;
let tasks: SqliteTaskRepository;
let events: SqliteEventLog;
let service: GraphCommitService;

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
function mutation(ops: GraphOperation[], baseVersion: number): GraphMutation {
  return {
    mutationId: `M-${baseVersion}-${Math.random().toString(36).slice(2, 6)}`,
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

beforeEach(async () => {
  db = new SqliteDatabaseAdapter(':memory:');
  db.open();
  runMigrations(db, createMigrationRegistry(), { now: () => '2026-01-01T00:00:00.000Z' });
  db.execute(
    `INSERT INTO sessions
      (session_id, workspace_id, workspace_root, goal_id, graph_version, state,
       created_at, updated_at, runtime_version, schema_version, budget_id, lock_id, metadata_json)
     VALUES ('S','W','/r','G',0,'RUNNING','t','t','0.1.0',1,'B','L','{}')`,
  );
  graphs = new SqliteTaskGraphRepository(db);
  tasks = new SqliteTaskRepository(db);
  events = new SqliteEventLog(db);

  let n = 0;
  const graphService = new GraphService({
    hasher: new Blake3GraphHasher(),
    now: () => '2026-01-01T00:00:00.000Z',
    nextId: () => `NID-${n++}`,
    canonicalFormVersion: 'v1',
    schemaVersion: 1,
  });
  let e = 0;
  service = new GraphCommitService({
    graphs,
    committer: new SqliteGraphCommitter(db),
    graphService,
    now: () => '2026-01-01T00:00:00.000Z',
    nextId: () => `EID-${e++}`,
  });

  // Seed an empty v1 graph so getCurrent works (baseVersion 1 for the first real mutation).
  await tasks.create(task('A'));
  const seed: TaskGraph = {
    graphId: 'G',
    sessionId: 'S',
    version: 1,
    nodes: [{ taskId: 'A', addedInVersion: 1 }],
    edges: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    createdBy: 'planner',
    canonicalHash: 'seed',
    schemaVersion: 1,
    canonicalFormVersion: 'v1',
  };
  await graphs.commit(seed, mutation([{ kind: 'ADD_TASK', task: task('A') }], 0));
});
afterEach(() => db.close());

describe('GraphCommitService.commit — GI-002 base version', () => {
  it('throws VERSION_CONFLICT when baseVersion is stale', async () => {
    await expect(
      service.commit(mutation([{ kind: 'ADD_TASK', task: task('B') }], 0)),
    ).rejects.toBeInstanceOf(GraphCommitError);
  });
});

describe('GraphCommitService.commit — VALIDATED path (GI-008 atomic)', () => {
  it('commits a new version, bumps session graph_version, appends events atomically', async () => {
    await tasks.create(task('B'));
    const r = await service.commit(
      mutation(
        [
          { kind: 'ADD_TASK', task: task('B') },
          { kind: 'ADD_EDGE', fromTaskId: 'B', toTaskId: 'A', edgeKind: 'depends_on' },
        ],
        1,
      ),
    );
    expect(r.status).toBe('COMMITTED');
    expect(r.version).toBe(2);

    const current = await graphs.getCurrent('S');
    expect(current.version).toBe(2);
    expect(current.nodes.map((n) => n.taskId).sort()).toEqual(['A', 'B']);
    expect(current.edges).toHaveLength(1);
    expect(current.edges[0]?.edgeId).toMatch(/^EID-/); // runtime-assigned edgeId at commit (§8.1)

    // Session pointer bumped in the same commit.
    const sess = db.query<{ graph_version: number }>(
      "SELECT graph_version FROM sessions WHERE session_id = 'S'",
    )[0];
    expect(sess?.graph_version).toBe(2);

    // Events appended with monotonic sequence.
    const evs = await events.query({ sessionId: 'S' });
    const types = evs.map((e) => e.type);
    expect(types).toContain('GRAPH_VERSION_CREATED');
    expect(types).toContain('GRAPH_MUTATION_COMMITTED');
    expect(evs.map((e) => e.sequenceNumber)).toEqual(
      Array.from({ length: evs.length }, (_, i) => i + 1),
    );
  });
});

describe('GraphCommitService.commit — REJECTED path (GI-002)', () => {
  it('records a REJECTED mutation + event, does not create a new version', async () => {
    // A cycle: A depends_on A via B then B->A already... simplest: self-loop add-edge.
    const r = await service.commit(
      mutation([{ kind: 'ADD_EDGE', fromTaskId: 'A', toTaskId: 'A', edgeKind: 'depends_on' }], 1),
    );
    expect(r.status).toBe('REJECTED');
    expect(r.validation.errors.map((e) => e.code)).toContain('SELF_LOOP');

    // No new graph version.
    expect((await graphs.getCurrent('S')).version).toBe(1);
    // Rejected mutation persisted + event.
    const m = db.query<{ status: string }>("SELECT status FROM graph_mutations ORDER BY rowid DESC LIMIT 1")[0];
    expect(m?.status).toBe('REJECTED');
    const types = (await events.query({ sessionId: 'S' })).map((e) => e.type);
    expect(types).toContain('GRAPH_MUTATION_REJECTED');
  });
});

describe('GraphCommitService.commit — SUPERSEDE (GI-007)', () => {
  it('marks the old task SUPERSEDED and links the successor', async () => {
    await tasks.create(task('A2'));
    const r = await service.commit(
      mutation([{ kind: 'SUPERSEDE_TASK', oldTaskId: 'A', newTask: task('A2'), rewire: true }], 1),
    );
    expect(r.status).toBe('COMMITTED');

    // tasks.superseded_by linked.
    const old = await tasks.getById('A');
    expect(old?.supersededBy).toBe('A2');
    // The new graph contains a supersedes edge A2 -> A.
    const current = await graphs.getCurrent('S');
    expect(current.edges.some((e) => e.kind === 'supersedes' && e.fromTaskId === 'A2' && e.toTaskId === 'A')).toBe(true);
  });
});
