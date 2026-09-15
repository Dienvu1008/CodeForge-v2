// P1-I3 — Adversarial E2E (PHASE_1_ROADMAP §4.7).
//
// Proves runtime safety does NOT depend on the model behaving (SECURITY_MODEL §0): each
// adversary emits malicious RAW output through the ModelGateway, and the DETERMINISTIC
// runtime blocks the malicious INTENT at its own guards. In Phase 1 the model's raw string
// is inert — it is never authority (MG-006/GI-009/GL-002/SC-005/SM-006). The runtime only
// acts on domain objects IT constructs, and those pass the deterministic validators/policies.
//
// Scenarios (roadmap):
//   - MaliciousPlanner   → graph with a cycle → GraphValidator REJECTS (GI-002, CYCLE_DETECTED)
//   - MaliciousReplanner → supersede a PASSED task → policy REJECTS (GI-007, POLICY_VIOLATION)
//   - MaliciousFailureAnalyzer → unbounded retries → Budget BLOCKS (BU-002, BUDGET_EXHAUSTED)
//   - PromptInjection / model-as-authority → runtime never mutates goal/graph from raw output
//     (GL-002 LLM_MUTATION; graph version unchanged unless a VALIDATED commit runs).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  SqliteDatabaseAdapter,
  SqliteGoalRepository,
  SqliteTaskRepository,
  SqliteTaskGraphRepository,
  SqliteGraphCommitter,
  SqliteBudgetRepository,
  SqliteEventLog,
  Blake3GraphHasher,
  runMigrations,
  createMigrationRegistry,
} from '@codeforge/infrastructure';
import {
  GoalService,
  GoalError,
  TaskService,
  GraphService,
  GraphCommitService,
  recoveryExhausted,
} from '@codeforge/agent-core';
import type {
  Goal,
  Task,
  TaskGraph,
  GraphMutation,
  GraphOperation,
  Budget,
  Provenance,
} from '@codeforge/agent-core';
import {
  MaliciousPlanner,
  MaliciousReplanner,
  MaliciousFailureAnalyzer,
  PromptInjectionContent,
} from '@codeforge/testing';

function makeCounters(): { now: () => string; nextId: () => string } {
  let n = 0;
  return { now: () => '2026-01-01T00:00:00.000Z', nextId: () => `ID-${String(n++).padStart(4, '0')}` };
}

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
    description: `task ${id}`,
    acceptanceCriteria: [],
    constraints: [],
    priority: 0,
    strategy: { kind: 'generate' },
    createdAt: '2026-01-01T00:00:00.000Z',
    createdBy: 'planner',
  };
}
function mutation(ops: GraphOperation[], baseVersion: number, id: string): GraphMutation {
  return {
    mutationId: id,
    sessionId: 'S',
    baseVersion,
    operations: ops,
    proposedBy: 'planner',
    reason: 'plan',
    provenance: PROVENANCE,
    createdAt: '2026-01-01T00:00:00.000Z',
    status: 'PROPOSED',
  };
}
function budget(limitRecovery: number): Budget {
  return {
    budgetId: 'B',
    scope: 'session',
    scopeId: 'S',
    limits: { wallClockMs: 1e6, modelTokens: 1e6, toolCalls: 1000, recoveryAttempts: limitRecovery },
    consumed: { wallClockMs: 0, modelTokens: 0, toolCalls: 0, recoveryAttempts: 0 },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

let db: SqliteDatabaseAdapter;
let graphs: SqliteTaskGraphRepository;
let tasks: SqliteTaskRepository;
let budgets: SqliteBudgetRepository;
let events: SqliteEventLog;
let graphCommit: GraphCommitService;
let goalSvc: GoalService;
let taskSvc: TaskService;

beforeEach(async () => {
  db = new SqliteDatabaseAdapter(':memory:');
  db.open();
  runMigrations(db, createMigrationRegistry(), { now: () => '2026-01-01T00:00:00.000Z' });
  db.execute(
    `INSERT INTO sessions
      (session_id, workspace_id, workspace_root, goal_id, graph_version, state,
       created_at, updated_at, runtime_version, schema_version, budget_id, lock_id, metadata_json)
     VALUES ('S','W','/r','G',1,'RUNNING','t','t','0.1.0',1,'B','L','{}')`,
  );

  graphs = new SqliteTaskGraphRepository(db);
  tasks = new SqliteTaskRepository(db);
  budgets = new SqliteBudgetRepository(db);
  events = new SqliteEventLog(db);
  const c = makeCounters();
  const graphSvc = new GraphService({
    hasher: new Blake3GraphHasher(),
    now: c.now,
    nextId: c.nextId,
    canonicalFormVersion: 'v1',
    schemaVersion: 1,
  });
  graphCommit = new GraphCommitService({ graphs, committer: new SqliteGraphCommitter(db), graphService: graphSvc, now: c.now, nextId: c.nextId });
  goalSvc = new GoalService({ goals: new SqliteGoalRepository(db), events, sessionId: 'S', now: c.now, nextId: c.nextId });
  taskSvc = new TaskService({ tasks, events, sessionId: 'S', now: c.now, nextId: c.nextId });
});
afterEach(() => db.close());

/** Seed a v1 graph containing the given tasks (as isolated nodes) so getCurrent works. */
async function seedGraph(taskIds: readonly string[]): Promise<void> {
  for (const id of taskIds) await taskSvc.create(task(id));
  const seed: TaskGraph = {
    graphId: 'G',
    sessionId: 'S',
    version: 1,
    nodes: taskIds.map((taskId) => ({ taskId, addedInVersion: 1 })),
    edges: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    createdBy: 'planner',
    canonicalHash: 'seed',
    schemaVersion: 1,
    canonicalFormVersion: 'v1',
  };
  await graphs.commit(seed, mutation([{ kind: 'ADD_TASK', task: task(taskIds[0] ?? 'A') }], 0, 'M-seed'));
}

describe('P1-I3 — MaliciousPlanner: invalid graph (cycle) → GraphValidator rejects (GI-002)', () => {
  it('rejects a cyclic dependency mutation; the raw model output is inert', async () => {
    // The adversary declares the attack (raw output it would emit). It is armed as a gateway
    // but the runtime NEVER parses its raw output into a mutation — it builds its own.
    const planner = new MaliciousPlanner().arm();
    expect(planner.attacks().some((a) => a.id === 'invalid-graph')).toBe(true);
    const raw = (await planner.generate({ purpose: 'plan', systemPrompt: 's', taskPrompt: 'plan', maxOutputTokens: 100, temperature: 0 })).raw;
    expect(typeof raw).toBe('string'); // untrusted string; not authority

    await seedGraph(['A', 'B']);
    // The runtime translates the (malicious) intent into a real mutation and validates it.
    const result = await graphCommit.commit(
      mutation(
        [
          { kind: 'ADD_EDGE', fromTaskId: 'A', toTaskId: 'B', edgeKind: 'depends_on' },
          { kind: 'ADD_EDGE', fromTaskId: 'B', toTaskId: 'A', edgeKind: 'depends_on' },
        ],
        1,
        'M-cycle',
      ),
    );

    expect(result.status).toBe('REJECTED');
    expect(result.validation.errors.some((e) => e.code === 'CYCLE_DETECTED')).toBe(true);
    // GI-002: no new graph version was created by a rejected mutation.
    expect((await graphs.getCurrent('S')).version).toBe(1);
    // The rejection was recorded as an event.
    expect((await events.query({ sessionId: 'S' })).map((e) => e.type)).toContain('GRAPH_MUTATION_REJECTED');
  });
});

describe('P1-I3 — MaliciousReplanner: supersede a PASSED task → policy rejects (GI-007)', () => {
  it('rejects superseding a PASSED task via the deterministic policy stage', async () => {
    const replanner = new MaliciousReplanner().arm();
    expect(replanner.attacks().some((a) => a.id === 'supersede-passed')).toBe(true);

    await seedGraph(['A']);
    await taskSvc.create(task('A2'));
    // Mark A as PASSED (policy context the validator reads — SM state is authority, not the model).
    const result = await graphCommit.commit(
      mutation([{ kind: 'SUPERSEDE_TASK', oldTaskId: 'A', newTask: task('A2'), rewire: true }], 1, 'M-supersede'),
      { passedTaskIds: new Set(['A']) },
    );

    expect(result.status).toBe('REJECTED');
    expect(result.validation.errors.some((e) => e.code === 'POLICY_VIOLATION')).toBe(true);
    expect((await graphs.getCurrent('S')).version).toBe(1); // unchanged
  });

  it('also rejects a replanned cycle (defense is structural, not model-trust)', async () => {
    new MaliciousReplanner().arm();
    await seedGraph(['A', 'B']);
    const result = await graphCommit.commit(
      mutation(
        [
          { kind: 'ADD_EDGE', fromTaskId: 'A', toTaskId: 'B', edgeKind: 'depends_on' },
          { kind: 'ADD_EDGE', fromTaskId: 'B', toTaskId: 'A', edgeKind: 'depends_on' },
        ],
        1,
        'M-replan-cycle',
      ),
    );
    expect(result.status).toBe('REJECTED');
    expect(result.validation.errors.some((e) => e.code === 'CYCLE_DETECTED')).toBe(true);
  });
});

describe('P1-I3 — MaliciousFailureAnalyzer: retry forever → Budget blocks (BU-002)', () => {
  it('caps recovery attempts at the budget limit; the proposed count is ignored', async () => {
    const analyzer = new MaliciousFailureAnalyzer().arm();
    const attack = analyzer.attacks().find((a) => a.id === 'retry-forever');
    expect(attack).toBeDefined(); // proposes {"recovery":"RETRY","max":999999}

    // Bounded recovery budget: 2 attempts allowed.
    await budgets.create(budget(2));

    // The runtime consumes ONE recoveryAttempt per real retry — the model's "999999" is inert.
    await budgets.consume('B', { recoveryAttempts: 1 });
    let after = await budgets.consume('B', { recoveryAttempts: 1 });
    expect(recoveryExhausted(after)).toBe(true); // BU-002: at the bound now

    // The 3rd attempt (the adversary wants unbounded) is BLOCKED atomically (BU-005/BU-002).
    await expect(budgets.consume('B', { recoveryAttempts: 1 })).rejects.toMatchObject({
      code: 'BUDGET_EXHAUSTED',
    });
    // Consumed never exceeded the limit.
    after = (await budgets.getById('B'))!;
    expect(after.consumed.recoveryAttempts).toBe(2);
  });
});

describe('P1-I3 — model output is never authority (GL-002 / GI-009 / MG-006, SE-007/008 phase-1 frame)', () => {
  it('rejects an LLM-originated goal mutation (GL-002 LLM_MUTATION)', async () => {
    const injector = new PromptInjectionContent().arm();
    const raw = (await injector.generate({ purpose: 'plan', systemPrompt: 's', taskPrompt: 'x', maxOutputTokens: 50, temperature: 0 })).raw;
    // A goal whose creator is the model must be refused — goals come from user/import only.
    const llmGoal: Goal = {
      goalId: 'G',
      version: 1,
      description: raw, // the injected instruction text — inert content, not authority
      constraints: [],
      acceptanceCriteria: [{ criterionId: 'AC1', description: 'x', mandatory: true }],
      createdAt: '2026-01-01T00:00:00.000Z',
      createdBy: 'planner' as unknown as Goal['createdBy'], // LLM origin
    };
    await expect(goalSvc.create(llmGoal)).rejects.toBeInstanceOf(GoalError);
    await expect(goalSvc.create(llmGoal)).rejects.toMatchObject({ code: 'LLM_MUTATION' });
  });

  it('does not change the committed graph merely because an adversary emitted output', async () => {
    const combined = new PromptInjectionContent().arm();
    await seedGraph(['A']);
    const before = (await graphs.getCurrent('S')).version;

    // Draining the adversary's malicious output has zero effect on runtime state — the graph
    // only ever changes through a VALIDATED GraphCommit (GI-009: LLM cannot mutate the graph).
    for (let i = 0; i < 3; i++) {
      await combined.generate({ purpose: 'plan', systemPrompt: 's', taskPrompt: 'go', maxOutputTokens: 50, temperature: 0 });
    }
    expect((await graphs.getCurrent('S')).version).toBe(before);
    // No graph mutation events were produced by model calls (the seed uses the raw repo
    // commit which emits nothing; only a VALIDATED GraphCommitService.commit would).
    const types = (await events.query({ sessionId: 'S' })).map((e) => e.type);
    expect(types.filter((t) => t === 'GRAPH_VERSION_CREATED')).toHaveLength(0);
  });
});
