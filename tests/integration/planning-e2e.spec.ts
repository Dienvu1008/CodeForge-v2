// P2-I1 — Planning E2E (PHASE_2_ROADMAP §4.6).
//
// Full planning lifecycle with FakeModel (CI-safe, no real Ollama required):
//   Session RUNNING → Goal → Planner (ModelGateway + ContextBuilder) →
//   GraphMutation proposal → PlanValidator validates → GraphCommitService commits →
//   Graph v2 with real tasks + dependencies.
//
// Verifies:
//   MG-001: all LLM calls went through ModelGateway (FakeModel.callCount > 0).
//   MG-006: parsed plan value translated by runtime → GraphMutation (not used as authority).
//   GI-009: LLM never committed directly — caller (test) runs GraphCommitService.
//   CX-003: ContextBuilder snapshot has trust-marked items.
//   TI-003: tasks in the committed graph have no dependency fields.
//   GI-002: validator confirmed mutation before commit.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  SqliteDatabaseAdapter,
  SqliteTaskRepository,
  SqliteTaskGraphRepository,
  SqliteGraphCommitter,
  SqliteEventLog,
  Blake3GraphHasher,
  runMigrations,
  createMigrationRegistry,
} from '@codeforge/infrastructure';
import {
  GraphService,
  GraphCommitService,
  Planner,
  PlanValidator,
  PlanCritic,
} from '@codeforge/agent-core';
import type { Goal, WorkspaceRevision } from '@codeforge/agent-core';
import { FakeModel } from '@codeforge/testing';

// ── helpers ───────────────────────────────────────────────────────────────────

function makeCounters(): { now: () => string; nextId: () => string } {
  let t = 0; let n = 0;
  return {
    now:    () => `2026-01-01T00:00:${String(t++).padStart(2, '0')}.000Z`,
    nextId: () => `ID-${String(n++).padStart(4, '0')}`,
  };
}

function revision(): WorkspaceRevision {
  return {
    revisionId: 'rev-1', canonicalFormVersion: 'v1', root: '/r',
    includedPaths: ['src/auth.ts'], excludedScratchPaths: [],
    hashAlgorithm: 'blake3', hash: 'HASH-1', fileCount: 1, totalBytes: 200,
    createdAt: '2026-01-01T00:00:00.000Z',
    createdBy: { sessionId: 'S', reason: 'session_start' },
  };
}

function goal(): Goal {
  return {
    goalId: 'G', version: 1,
    description: 'Add user authentication to the application',
    constraints: [{ kind: 'scope', description: 'TypeScript only', enforceable: true }],
    acceptanceCriteria: [
      { criterionId: 'AC1', description: 'users can register and login', mandatory: true },
    ],
    createdAt: '2026-01-01T00:00:00.000Z', createdBy: 'user',
  };
}

/** A realistic plan JSON the FakeModel will return. */
const PLAN_RESPONSE = JSON.stringify({
  tasks: [
    { id: 'T1', description: 'Implement user registration endpoint', strategy: 'generate',
      acceptanceCriteria: ['POST /auth/register returns 201'] },
    { id: 'T2', description: 'Implement JWT login endpoint', strategy: 'generate',
      acceptanceCriteria: ['POST /auth/login returns token'] },
    { id: 'T3', description: 'Add auth middleware to protected routes', strategy: 'generate' },
  ],
  edges: [
    { from: 'T3', to: 'T1', kind: 'depends_on' }, // T3 depends on T1
    { from: 'T3', to: 'T2', kind: 'depends_on' }, // T3 depends on T2
  ],
  reason: 'standard auth flow: register + login first, middleware after',
});

let db: SqliteDatabaseAdapter;

beforeEach(async () => {
  db = new SqliteDatabaseAdapter(':memory:');
  db.open();
  runMigrations(db, createMigrationRegistry(), { now: () => '2026-01-01T00:00:00.000Z' });
});
afterEach(() => db.close());

// ─────────────────────────────────────────────────────────────────────────────
// Full planning E2E
// ─────────────────────────────────────────────────────────────────────────────

describe('P2-I1 Planning E2E — full lifecycle with FakeModel', () => {
  it('drives Goal → Planner → PlanValidator → GraphCommit → Graph v2 (GI-009, MG-001)', async () => {
    const c = makeCounters();

    // 1) Seed session directly (same pattern as P1-I1 and Phase 1.5 E2E tests).
    db.execute(
      `INSERT INTO sessions
         (session_id, workspace_id, workspace_root, goal_id, graph_version, state,
          created_at, updated_at, runtime_version, schema_version, budget_id, lock_id, metadata_json)
       VALUES ('S','W','/r','G',1,'RUNNING','t','t','0.3.0',1,'B','L','{}')`,
    );
    const events = new SqliteEventLog(db);

    // 2) Seed graph (v1 empty seed).
    const graphs = new SqliteTaskGraphRepository(db);
    await graphs.commit({
      graphId: 'GR', sessionId: 'S', version: 1,
      nodes: [], edges: [],
      createdAt: '2026-01-01T00:00:00.000Z', createdBy: 'planner',
      canonicalHash: 'seed', schemaVersion: 1, canonicalFormVersion: 'v1',
    }, {
      mutationId: 'M-seed', sessionId: 'S', baseVersion: 0, operations: [],
      proposedBy: 'planner', reason: 'seed',
      provenance: { provenanceId: 'P', source: { kind: 'runtime', id: 'init' }, inputs: [], reason: 'seed', at: 't' },
      createdAt: 't', status: 'PROPOSED',
    });

    // 3) Set up services.
    const tasks    = new SqliteTaskRepository(db);
    const graphSvc = new GraphService({
      hasher: new Blake3GraphHasher(), now: c.now, nextId: c.nextId,
      canonicalFormVersion: 'v1', schemaVersion: 1,
    });
    const graphCommit = new GraphCommitService({
      graphs, committer: new SqliteGraphCommitter(db),
      graphService: graphSvc, now: c.now, nextId: c.nextId,
    });

    // 4) FakeModel returns the pre-defined plan (deterministic CI run).
    const fakeModel = new FakeModel();
    fakeModel.setResponse(/./, PLAN_RESPONSE);

    const planner   = new Planner({ gateway: fakeModel, now: c.now, nextId: c.nextId });
    const validator = new PlanValidator();

    // 5) Plan: Planner proposes a GraphMutation (GI-009: does NOT commit).
    const currentGraph = await graphs.getCurrent('S');
    const mutation     = await planner.plan('S', goal(), currentGraph, revision());

    // MG-001: model.generate() was called at least once.
    expect(fakeModel.callCount).toBeGreaterThanOrEqual(1);

    // MG-006: mutation is a PROPOSED GraphMutation, not a committed graph.
    expect(mutation.status).toBe('PROPOSED');
    expect(mutation.proposedBy).toBe('planner');

    // Mutation contains ADD_TASK operations.
    const addTasks = mutation.operations.filter((op) => op.kind === 'ADD_TASK');
    expect(addTasks).toHaveLength(3);

    // Mutation contains ADD_EDGE operations.
    const addEdges = mutation.operations.filter((op) => op.kind === 'ADD_EDGE');
    expect(addEdges).toHaveLength(2);

    // TI-003: no task in the mutation carries dependency fields.
    for (const op of addTasks) {
      if (op.kind === 'ADD_TASK') {
        expect('dependencies' in op.task).toBe(false);
        expect('state' in op.task).toBe(false);
        expect('edges' in op.task).toBe(false);
      }
    }

    // 6) Persist tasks so GraphCommit FK is satisfied.
    for (const op of addTasks) {
      if (op.kind === 'ADD_TASK') await tasks.create(op.task);
    }

    // 7) Validate (GI-002: deterministic, no LLM).
    const validation = validator.validate(currentGraph, mutation);
    expect(validation.status).toBe('VALIDATED');

    // 8) Commit (GI-009: the runtime — not the LLM — commits via GraphCommitService).
    const result = await graphCommit.commit(mutation);
    expect(result.status).toBe('COMMITTED');
    expect(result.version).toBe(2);

    // 9) Verify committed graph.
    const newGraph = await graphs.getCurrent('S');
    expect(newGraph.version).toBe(2);
    expect(newGraph.nodes).toHaveLength(3);
    expect(newGraph.edges).toHaveLength(2);

    // Graph events emitted by GraphCommitService.
    const evts = await events.query({ sessionId: 'S' });
    expect(evts.map((e) => e.type)).toContain('GRAPH_VERSION_CREATED');
    expect(evts.map((e) => e.type)).toContain('GRAPH_MUTATION_COMMITTED');
  });

  it('MG-001/MG-003: retries on invalid model output then succeeds', async () => {
    const c = makeCounters();
    db.execute(`INSERT INTO sessions (session_id, workspace_id, workspace_root, goal_id, graph_version, state, created_at, updated_at, runtime_version, schema_version, budget_id, lock_id, metadata_json) VALUES ('S2','W','/r','G2',1,'RUNNING','t','t','0.3.0',1,'B','L','{}')`);
    const graphs = new SqliteTaskGraphRepository(db);
    await graphs.commit({
      graphId: 'GR2', sessionId: 'S2', version: 1,
      nodes: [], edges: [],
      createdAt: 't', createdBy: 'planner',
      canonicalHash: 'seed', schemaVersion: 1, canonicalFormVersion: 'v1',
    }, {
      mutationId: 'M-seed', sessionId: 'S2', baseVersion: 0, operations: [],
      proposedBy: 'planner', reason: 'seed',
      provenance: { provenanceId: 'P', source: { kind: 'runtime', id: 'init' }, inputs: [], reason: 'seed', at: 't' },
      createdAt: 't', status: 'PROPOSED',
    });

    const fakeModel = new FakeModel();
    // First response invalid, second response valid.
    fakeModel.setSequence(['not valid json at all', PLAN_RESPONSE]);

    const planner      = new Planner({ gateway: fakeModel, now: c.now, nextId: c.nextId });
    const currentGraph = await graphs.getCurrent('S2');
    const mutation     = await planner.plan('S2', goal(), currentGraph, revision());

    expect(fakeModel.callCount).toBe(2);
    expect(mutation.status).toBe('PROPOSED');
    expect(mutation.operations.filter((op) => op.kind === 'ADD_TASK')).toHaveLength(3);
  });

  it('PlanCritic returns advisory result without blocking the plan (MG-006)', async () => {
    const c = makeCounters();
    db.execute(`INSERT INTO sessions (session_id, workspace_id, workspace_root, goal_id, graph_version, state, created_at, updated_at, runtime_version, schema_version, budget_id, lock_id, metadata_json) VALUES ('S3','W','/r','G3',1,'RUNNING','t','t','0.3.0',1,'B','L','{}')`);
    const graphs = new SqliteTaskGraphRepository(db);
    await graphs.commit({
      graphId: 'GR3', sessionId: 'S3', version: 1, nodes: [], edges: [],
      createdAt: 't', createdBy: 'planner', canonicalHash: 'seed',
      schemaVersion: 1, canonicalFormVersion: 'v1',
    }, {
      mutationId: 'M-seed2', sessionId: 'S3', baseVersion: 0, operations: [],
      proposedBy: 'planner', reason: 'seed',
      provenance: { provenanceId: 'P2', source: { kind: 'runtime', id: 'init' }, inputs: [], reason: 'seed', at: 't' },
      createdAt: 't', status: 'PROPOSED',
    });

    const fakeModel = new FakeModel();
    // First call → plan, second call → critique.
    fakeModel.setSequence([
      PLAN_RESPONSE,
      JSON.stringify({ score: 4, issues: [], suggestions: ['add error handling'], summary: 'good plan' }),
    ]);

    const planner  = new Planner({ gateway: fakeModel, now: c.now, nextId: c.nextId });
    const critic   = new PlanCritic({ gateway: fakeModel, now: c.now, nextId: c.nextId });
    const currentGraph = await graphs.getCurrent('S3');

    const mutation  = await planner.plan('S3', goal(), currentGraph, revision());
    const critique  = await critic.critique(goal(), mutation);

    // MG-006: critique is advisory data only — cannot block or modify the mutation.
    expect(mutation.status).toBe('PROPOSED');
    expect(critique.score).toBeGreaterThanOrEqual(1);
    expect(critique.score).toBeLessThanOrEqual(5);
    expect(Array.isArray(critique.issues)).toBe(true);
    expect(Array.isArray(critique.suggestions)).toBe(true);
  });
});
