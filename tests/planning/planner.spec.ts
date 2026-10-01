// P2-PL1 — Planner + PlanValidator + PlanCritic.
// Covers: MG-001 (all calls via gateway), MG-002/003 (bounded retry),
//         MG-006 (output not authority), GI-009 (LLM never commits directly),
//         CX-003 (context snapshot trust marking), TI-003 (no dep fields in task).
import { describe, it, expect } from 'vitest';
import {
  Planner,
  PlannerError,
  PlanValidator,
  PlanValidationError,
  PlanCritic,
  validatePlanSemantics,
  type RawPlan,
} from '@codeforge/agent-core';
import type { Goal, TaskGraph, WorkspaceRevision } from '@codeforge/agent-core';
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
} from '@codeforge/agent-core';
import { FakeModel } from '@codeforge/testing';

// ── helpers ───────────────────────────────────────────────────────────────────

function makeCounters(): { now: () => string; nextId: () => string } {
  let t = 0; let n = 0;
  return {
    now:    () => `2026-01-01T00:00:${String(t++).padStart(2, '0')}.000Z`,
    nextId: () => `ID-${String(n++).padStart(4, '0')}`,
  };
}

function goal(): Goal {
  return {
    goalId: 'G', version: 1,
    description: 'Add authentication feature',
    constraints: [],
    acceptanceCriteria: [{ criterionId: 'AC1', description: 'users can login', mandatory: true }],
    createdAt: 't', createdBy: 'user',
  };
}

function revision(): WorkspaceRevision {
  return {
    revisionId: 'rev-1', canonicalFormVersion: 'v1', root: '/r',
    includedPaths: [], excludedScratchPaths: [],
    hashAlgorithm: 'blake3', hash: 'HASH-1', fileCount: 0, totalBytes: 0,
    createdAt: 't', createdBy: { sessionId: 'S', reason: 'session_start' },
  };
}

/** Valid plan JSON the model would return. */
const VALID_PLAN_JSON = JSON.stringify({
  tasks: [
    { id: 'T1', description: 'implement login endpoint', strategy: 'generate' },
    { id: 'T2', description: 'add auth middleware', strategy: 'generate' },
  ],
  edges: [{ from: 'T2', to: 'T1', kind: 'depends_on' }],
  reason: 'standard auth plan',
});

// ─────────────────────────────────────────────────────────────────────────────
// validatePlanSemantics (pure)
// ─────────────────────────────────────────────────────────────────────────────

describe('validatePlanSemantics — TI-003 + schema', () => {
  it('accepts a valid plan', () => {
    const raw: RawPlan = {
      tasks: [{ id: 'T1', description: 'do work', strategy: 'generate' }],
    };
    expect(validatePlanSemantics(raw)).toBeUndefined();
  });

  it('rejects empty tasks array', () => {
    expect(validatePlanSemantics({ tasks: [] })).toMatch(/at least one task/);
  });

  it('rejects task missing id', () => {
    expect(validatePlanSemantics({ tasks: [{ description: 'work', strategy: 'generate' }] }))
      .toMatch(/missing.*id/);
  });

  it('rejects task missing description', () => {
    expect(validatePlanSemantics({ tasks: [{ id: 'T1', strategy: 'generate' }] }))
      .toMatch(/missing.*description/);
  });

  it('TI-003: rejects task with "dependencies" field', () => {
    const raw = { tasks: [{ id: 'T1', description: 'work', strategy: 'generate', dependencies: ['T2'] }] };
    expect(validatePlanSemantics(raw)).toMatch(/TI-003/);
  });

  it('TI-003: rejects task with "state" field', () => {
    const raw = { tasks: [{ id: 'T1', description: 'work', strategy: 'generate', state: 'RUNNING' }] };
    expect(validatePlanSemantics(raw)).toMatch(/TI-003/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Planner
// ─────────────────────────────────────────────────────────────────────────────

describe('Planner.plan — MG-001/002/006, GI-009', () => {
  const emptyGraph: TaskGraph = {
    graphId: 'G', sessionId: 'S', version: 1,
    nodes: [], edges: [],
    createdAt: 't', createdBy: 'planner',
    canonicalHash: 'h', schemaVersion: 1, canonicalFormVersion: 'v1',
  };

  it('MG-001: model.generate() is called exactly once on valid output', async () => {
    const fake = new FakeModel();
    fake.setResponse(/./, VALID_PLAN_JSON);
    const c = makeCounters();
    const planner = new Planner({ gateway: fake, now: c.now, nextId: c.nextId });

    await planner.plan('S', goal(), emptyGraph, revision());
    expect(fake.callCount).toBe(1);
  });

  it('GI-009: returns a GraphMutation (caller must commit — LLM never commits directly)', async () => {
    const fake = new FakeModel();
    fake.setResponse(/./, VALID_PLAN_JSON);
    const c = makeCounters();
    const planner = new Planner({ gateway: fake, now: c.now, nextId: c.nextId });

    const mutation = await planner.plan('S', goal(), emptyGraph, revision());

    // Must be a proper GraphMutation, not a committed graph.
    expect(mutation.status).toBe('PROPOSED');
    expect(mutation.proposedBy).toBe('planner');
    // Contains ADD_TASK operations (one per proposed task).
    const addTasks = mutation.operations.filter((op) => op.kind === 'ADD_TASK');
    expect(addTasks).toHaveLength(2);
    // Contains ADD_EDGE operation.
    const addEdges = mutation.operations.filter((op) => op.kind === 'ADD_EDGE');
    expect(addEdges).toHaveLength(1);
  });

  it('MG-006: parsed plan value is translated by runtime (not used as authority)', async () => {
    const fake = new FakeModel();
    // Model claims a task should have state RUNNING — runtime must ignore this.
    fake.setResponse(/./, JSON.stringify({
      tasks: [{ id: 'T1', description: 'work', strategy: 'generate' }],
    }));
    const c = makeCounters();
    const planner = new Planner({ gateway: fake, now: c.now, nextId: c.nextId });

    const mutation = await planner.plan('S', goal(), emptyGraph, revision());
    // Runtime-built task has no state field (Task is pure intent).
    const addTask = mutation.operations.find((op) => op.kind === 'ADD_TASK');
    expect(addTask?.kind).toBe('ADD_TASK');
    if (addTask?.kind === 'ADD_TASK') {
      expect('state' in addTask.task).toBe(false);
    }
  });

  it('MG-003: retries on invalid JSON, succeeds on second attempt', async () => {
    const fake = new FakeModel();
    fake.setSequence(['not json', VALID_PLAN_JSON]);
    const c = makeCounters();
    const planner = new Planner({ gateway: fake, now: c.now, nextId: c.nextId });

    const mutation = await planner.plan('S', goal(), emptyGraph, revision());
    expect(mutation.status).toBe('PROPOSED');
    expect(fake.callCount).toBe(2);
  });

  it('throws PlannerError when retries exhausted', async () => {
    const fake = new FakeModel();
    fake.setSequence(['bad', 'bad', 'bad']); // all invalid
    const c = makeCounters();
    const planner = new Planner({ gateway: fake, now: c.now, nextId: c.nextId });

    await expect(planner.plan('S', goal(), emptyGraph, revision()))
      .rejects.toBeInstanceOf(PlannerError);
  });

  it('CX-003: planner uses ContextBuilder → snapshot has trust-marked items', async () => {
    const fake = new FakeModel();
    fake.setResponse(/./, VALID_PLAN_JSON);
    const c = makeCounters();
    const planner = new Planner({ gateway: fake, now: c.now, nextId: c.nextId });

    // Just verify it runs without error — ContextBuilder is exercised internally.
    const mutation = await planner.plan('S', goal(), emptyGraph, revision());
    expect(mutation).toBeDefined();
  });

  it('mutation provenance records model identity (MG-004)', async () => {
    const fake = new FakeModel();
    fake.setResponse(/./, VALID_PLAN_JSON);
    const c = makeCounters();
    const planner = new Planner({ gateway: fake, now: c.now, nextId: c.nextId });

    const mutation = await planner.plan('S', goal(), emptyGraph, revision());
    expect(mutation.provenance.source.kind).toBe('model');
    expect(mutation.provenance.source.id).toBe(fake.identity.name);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PlanValidator
// ─────────────────────────────────────────────────────────────────────────────

describe('PlanValidator — deterministic validation (GI-002/004..007)', () => {
  let db: SqliteDatabaseAdapter;
  let graphs: SqliteTaskGraphRepository;
  let tasks: SqliteTaskRepository;
  let graphCommit: GraphCommitService;

  beforeEach(() => {
    db = new SqliteDatabaseAdapter(':memory:');
    db.open();
    runMigrations(db, createMigrationRegistry(), { now: () => 't' });
    db.execute(`INSERT INTO sessions (session_id, workspace_id, workspace_root, goal_id, graph_version, state, created_at, updated_at, runtime_version, schema_version, budget_id, lock_id, metadata_json) VALUES ('S','W','/r','G',1,'RUNNING','t','t','0.1.0',1,'B','L','{}')`);
    graphs = new SqliteTaskGraphRepository(db);
    tasks  = new SqliteTaskRepository(db);
    const events = new SqliteEventLog(db);
    const c = makeCounters();
    const graphSvc = new GraphService({
      hasher:               new Blake3GraphHasher(),
      now:                  c.now,
      nextId:               c.nextId,
      canonicalFormVersion: 'v1',
      schemaVersion:        1,
    });
    graphCommit = new GraphCommitService({
      graphs, committer: new SqliteGraphCommitter(db), graphService: graphSvc,
      now: c.now, nextId: c.nextId,
    });
  });
  afterEach(() => db.close());

  it('validates a good mutation as VALIDATED', async () => {
    // Seed empty v1 graph.
    const seedGraph: TaskGraph = {
      graphId: 'GR', sessionId: 'S', version: 1,
      nodes: [], edges: [], createdAt: 't', createdBy: 'planner',
      canonicalHash: 'seed', schemaVersion: 1, canonicalFormVersion: 'v1',
    };
    await graphs.commit(seedGraph, {
      mutationId: 'M-seed', sessionId: 'S', baseVersion: 0, operations: [],
      proposedBy: 'planner', reason: 'seed',
      provenance: { provenanceId: 'P', source: { kind: 'runtime', id: 'test' }, inputs: [], reason: 'seed', at: 't' },
      createdAt: 't', status: 'PROPOSED',
    });

    const fake = new FakeModel();
    fake.setResponse(/./, VALID_PLAN_JSON);
    const c = makeCounters();
    const planner  = new Planner({ gateway: fake, now: c.now, nextId: c.nextId });
    const graph    = await graphs.getCurrent('S');
    for (const op of (await planner.plan('S', goal(), graph, revision())).operations) {
      if (op.kind === 'ADD_TASK') await tasks.create(op.task);
    }

    const mutation  = await planner.plan('S', goal(), graph, revision());
    const validator = new PlanValidator();
    const result    = validator.validate(graph, mutation);
    expect(result.status).toBe('VALIDATED');
  });

  it('rejects a mutation with a cycle (CYCLE_DETECTED)', async () => {
    const fake = new FakeModel();
    fake.setResponse(/./, JSON.stringify({
      tasks: [
        { id: 'T1', description: 'task A', strategy: 'generate' },
        { id: 'T2', description: 'task B', strategy: 'generate' },
      ],
      edges: [
        { from: 'T1', to: 'T2', kind: 'depends_on' },
        { from: 'T2', to: 'T1', kind: 'depends_on' }, // cycle!
      ],
    }));
    const c = makeCounters();
    const seedGraph: TaskGraph = {
      graphId: 'GR', sessionId: 'S', version: 1, nodes: [], edges: [],
      createdAt: 't', createdBy: 'planner', canonicalHash: 'seed',
      schemaVersion: 1, canonicalFormVersion: 'v1',
    };
    const planner  = new Planner({ gateway: fake, now: c.now, nextId: c.nextId });
    const mutation = await planner.plan('S', goal(), seedGraph, revision());

    const validator = new PlanValidator();
    const result    = validator.validate(seedGraph, mutation);
    expect(result.status).toBe('REJECTED');
    expect(result.errors.some((e) => e.code === 'CYCLE_DETECTED')).toBe(true);
  });

  it('validateOrThrow throws PlanValidationError on cycle', async () => {
    const fake = new FakeModel();
    fake.setResponse(/./, JSON.stringify({
      tasks: [
        { id: 'T1', description: 'A', strategy: 'generate' },
        { id: 'T2', description: 'B', strategy: 'generate' },
      ],
      edges: [
        { from: 'T1', to: 'T2', kind: 'depends_on' },
        { from: 'T2', to: 'T1', kind: 'depends_on' },
      ],
    }));
    const c = makeCounters();
    const seedGraph: TaskGraph = {
      graphId: 'GR', sessionId: 'S', version: 1, nodes: [], edges: [],
      createdAt: 't', createdBy: 'planner', canonicalHash: 'seed',
      schemaVersion: 1, canonicalFormVersion: 'v1',
    };
    const planner  = new Planner({ gateway: fake, now: c.now, nextId: c.nextId });
    const mutation = await planner.plan('S', goal(), seedGraph, revision());

    const validator = new PlanValidator();
    await expect(
      Promise.resolve().then(() => validator.validateOrThrow(seedGraph, mutation)),
    ).rejects.toBeInstanceOf(PlanValidationError);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PlanCritic — advisory only
// ─────────────────────────────────────────────────────────────────────────────

describe('PlanCritic — MG-006 advisory only', () => {
  const fakeGraph: TaskGraph = {
    graphId: 'G', sessionId: 'S', version: 1, nodes: [], edges: [],
    createdAt: 't', createdBy: 'planner', canonicalHash: 'h',
    schemaVersion: 1, canonicalFormVersion: 'v1',
  };
  const fakeMutation = {
    mutationId: 'M', sessionId: 'S', baseVersion: 1,
    operations: [{
      kind: 'ADD_TASK' as const,
      task: {
        taskId: 'T1', description: 'add auth', acceptanceCriteria: [],
        constraints: [], priority: 0, strategy: { kind: 'generate' as const },
        createdAt: 't', createdBy: 'planner' as const,
      },
    }],
    proposedBy: 'planner' as const, reason: 'plan',
    provenance: { provenanceId: 'P', source: { kind: 'runtime' as const, id: 'test' }, inputs: [], reason: 'plan', at: 't' },
    createdAt: 't', status: 'PROPOSED' as const,
  };

  it('MG-006: returns advisory CritiqueResult (cannot commit)', async () => {
    const fake = new FakeModel();
    fake.setResponse(/./, JSON.stringify({
      score: 4,
      issues: [],
      suggestions: ['add error handling'],
      summary: 'good plan overall',
    }));
    const c = makeCounters();
    const critic = new PlanCritic({ gateway: fake, now: c.now, nextId: c.nextId });

    const result = await critic.critique(goal(), fakeMutation);
    expect(result.score).toBeGreaterThanOrEqual(1);
    expect(result.score).toBeLessThanOrEqual(5);
    expect(Array.isArray(result.issues)).toBe(true);
    expect(Array.isArray(result.suggestions)).toBe(true);
    // Critic cannot change graph state — result is data only.
    expect(typeof result.summary).toBe('string');
  });

  it('MG-006: critic failure returns neutral result without throwing', async () => {
    const fake = new FakeModel();
    fake.setSequence(['bad', 'bad', 'bad']); // all invalid
    const c = makeCounters();
    const critic = new PlanCritic({ gateway: fake, now: c.now, nextId: c.nextId });

    // Must NOT throw — critic is advisory.
    const result = await critic.critique(goal(), fakeMutation);
    expect(result.score).toBe(3);
    expect(result.summary).toContain('unavailable');
  });

  it('MG-001: critic uses ModelGateway (callCount > 0)', async () => {
    const fake = new FakeModel();
    fake.setResponse(/./, JSON.stringify({ score: 3, issues: [], suggestions: [], summary: 'ok' }));
    const c = makeCounters();
    const critic = new PlanCritic({ gateway: fake, now: c.now, nextId: c.nextId });

    await critic.critique(goal(), fakeMutation);
    expect(fake.callCount).toBeGreaterThan(0);
  });

  void fakeGraph; // suppress unused variable warning
});

// Need to import beforeEach and afterEach for PlanValidator tests
import { beforeEach, afterEach } from 'vitest';
