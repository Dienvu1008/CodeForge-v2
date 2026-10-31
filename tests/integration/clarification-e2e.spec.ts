// Goal Clarification Gate — end-to-end seam: SessionOrchestrator + real MissionIntelligence +
// a manually-resolved fake ClarificationGate, through to the real TaskExecutor prompt.
//
// What is real: SessionOrchestrator, MissionIntelligence (deterministic analyzers + gate branch),
// SqliteEventLog on SQLite :memory: (the SAME log the mission stage and the TaskExecutor's
// TaskRunService write to — mirroring runtime-cli, where one `events` is shared), and the real
// TaskExecutor (FakeModel gateway) so the STATED_ASSUMPTIONS section is asserted on the actual
// prompt. What is faked: the orchestrator's session/graph/planner plumbing — copied from
// tests/invariants/mission/mi-b2-assumptions.spec.ts (single-node graph so one task executes).
//
// Validates: Requirements 3.3, 7.9, 7.10, 9.1
import { describe, it, expect } from 'vitest';
import {
  SessionOrchestrator,
  MissionIntelligence,
  TaskExecutor,
  ExecutionCoordinator,
  TaskRunService,
  ContextBuilder,
  ToolGateway,
  NoopProcessReconciler,
  PERMISSIVE_TEST_POLICY,
  type Goal,
  type WorkspaceRevision,
  type TaskGraph,
  type GraphMutation,
  type Task,
  type TaskExecutorRequest,
  type SessionOrchestratorDeps,
  type SessionOrchestratorResult,
  type ClarificationGate,
  type ClarificationRequest,
  type ClarificationOutcome,
  type ToolExecutor,
} from '@codeforge/agent-core';
import {
  SqliteDatabaseAdapter,
  SqliteEventLog,
  SqliteTaskRunRepository,
  SqliteTaskExecutionRepository,
  SqliteToolCallRepository,
  SqliteApprovalRepository,
  runMigrations,
  createMigrationRegistry,
} from '@codeforge/infrastructure';
import { FakeModel } from '@codeforge/testing';

const SESSION = 'S';
const T0 = '2026-01-01T00:00:00.000Z';

// Vague goal → UNKNOWN with open questions (same fixture as mission-intelligence-clarify.spec.ts).
const GOAL: Goal = {
  goalId: 'G', version: 1, description: 'create a script that multiplies two matrices',
  constraints: [], acceptanceCriteria: [], createdAt: T0, createdBy: 'user',
};

const REVISION: WorkspaceRevision = {
  revisionId: 'rev-1', canonicalFormVersion: 'v1', root: '/r',
  includedPaths: [], excludedScratchPaths: [],
  hashAlgorithm: 'blake3', hash: 'HASH', fileCount: 0, totalBytes: 0,
  createdAt: T0, createdBy: { sessionId: SESSION, reason: 'session_start' },
};

const TASK: Task = {
  taskId: 'T1', description: 'do the thing',
  acceptanceCriteria: [{ criterionId: 'c', description: 'done', mandatory: true }],
  constraints: [], priority: 1, strategy: { kind: 'generate' },
  createdAt: T0, createdBy: 'planner',
};

function oneNodeGraph(): TaskGraph {
  return {
    graphId: 'GR', sessionId: SESSION, version: 1,
    nodes: [{ taskId: 'T1', addedInVersion: 1 }],
    edges: [],
    createdAt: T0, createdBy: 'planner', canonicalHash: 'h',
    schemaVersion: 1, canonicalFormVersion: 'v1',
  } as unknown as TaskGraph;
}

function mutationWithTask(): GraphMutation {
  return {
    mutationId: 'M', sessionId: SESSION, baseVersion: 1,
    operations: [{ kind: 'ADD_TASK', task: TASK } as never],
    proposedBy: 'planner', reason: 'plan',
    provenance: { provenanceId: 'P', source: { kind: 'runtime', id: 't' }, inputs: [], reason: 'r', at: T0 },
    createdAt: T0, status: 'PROPOSED',
  } as unknown as GraphMutation;
}

// ── SQLite :memory: (shared event log) ────────────────────────────────────────

function makeDb(): SqliteDatabaseAdapter {
  const db = new SqliteDatabaseAdapter(':memory:');
  db.open();
  runMigrations(db, createMigrationRegistry(), { now: () => T0 });
  // FK rows (session + task) required by events / task_runs / task_executions.
  db.execute(
    `INSERT OR IGNORE INTO sessions
       (session_id, workspace_id, workspace_root, goal_id, graph_version, state,
        created_at, updated_at, runtime_version, schema_version, budget_id, lock_id, metadata_json)
     VALUES (?,?,?,?,1,'RUNNING',?,?,'0.4.0',1,'B','L','{}')`,
    [SESSION, 'WS-001', '/r', GOAL.goalId, T0, T0],
  );
  db.execute(
    `INSERT OR IGNORE INTO tasks
       (task_id, description, acceptance_json, constraints_json, priority,
        strategy_json, created_at, created_by, schema_version)
     VALUES (?,?,?,?,1,'{"kind":"generate"}',?,'planner',1)`,
    [TASK.taskId, TASK.description, '[]', '[]', T0],
  );
  return db;
}

// ── Manually-resolved gate ────────────────────────────────────────────────────

class DeferredGate implements ClarificationGate {
  public readonly calls: { sessionId: string; request: ClarificationRequest }[] = [];
  private resolver: ((o: ClarificationOutcome) => void) | undefined;
  private onCalled: (() => void) | undefined;
  public readonly called = new Promise<void>((r) => { this.onCalled = r; });

  constructor(private readonly timeline: string[]) {}

  awaitAnswers(sessionId: string, request: ClarificationRequest): Promise<ClarificationOutcome> {
    this.calls.push({ sessionId, request });
    this.timeline.push('gate:await');
    return new Promise<ClarificationOutcome>((resolve) => {
      this.resolver = resolve;
      this.onCalled?.();
    });
  }

  resolve(outcome: ClarificationOutcome): void {
    if (this.resolver === undefined) throw new Error('gate not awaiting');
    this.timeline.push('gate:resolved');
    this.resolver(outcome);
  }
}

// ── Harness (copied from mi-b2-assumptions.spec.ts; executor delegates to the real one) ──

function makeHarness() {
  let n = 0;
  const nextId = () => `id-${++n}`;
  const now = () => T0;
  const timeline: string[] = [];
  const captured: TaskExecutorRequest[] = [];
  const states = new Map<string, string>([['T1', 'PENDING']]);

  const db = makeDb();
  const events = new SqliteEventLog(db);

  // Real TaskExecutor (FakeModel) — the prompt it builds is what we assert STATED_ASSUMPTIONS on.
  const model = new FakeModel();
  model.setSequence([JSON.stringify({ type: 'done', summary: 'done' }), JSON.stringify({ type: 'done', summary: 'done' })]);
  const fakeTools: ToolExecutor = { execute: async () => ({ exitCode: 0, stdout: 'ok', stderr: '', timedOut: false }) };
  const realCoordinator = new ExecutionCoordinator({ executions: new SqliteTaskExecutionRepository(db), now });
  const realExecutor = new TaskExecutor({
    taskRunService: new TaskRunService({
      runs: new SqliteTaskRunRepository(db), events, reconciler: new NoopProcessReconciler(), now, nextId,
    }),
    executionCoordinator: realCoordinator,
    contextBuilder: new ContextBuilder({ now, nextId }),
    gateway: model,
    toolGateway: new ToolGateway({
      calls: new SqliteToolCallRepository(db), approvals: new SqliteApprovalRepository(db),
      events, policy: PERMISSIVE_TEST_POLICY, now, nextId,
    }),
    executor: fakeTools,
    now, nextId,
  });

  const sessionService = {
    async transition(_s: string, t: string) { timeline.push(`session:${t}`); return {} as never; },
    async complete() { return {} as never; },
  };
  let plannerCalls = 0;
  const planner = {
    async plan(): Promise<GraphMutation> { plannerCalls++; timeline.push('planner'); return mutationWithTask(); },
  };
  const graphCommitService = {
    async commit() { return { status: 'COMMITTED' as const, version: 1, validation: { status: 'VALIDATED' as const, errors: [] } }; },
  };
  const graphRepository = { async getCurrent(): Promise<TaskGraph> { return oneNodeGraph(); } };
  const taskRepository = { async create() {}, async getById() { return TASK; } };
  const executionRepository = {
    async getByTask(id: string) {
      const s = states.get(id);
      return s === undefined ? null : { currentState: s, attempts: 0 };
    },
  };
  const executionCoordinator = {
    async init(id: string) { if (!states.has(id)) states.set(id, 'PENDING'); },
    async setState(id: string, s: string) { states.set(id, s); },
  };
  const taskExecutor = {
    async execute(req: TaskExecutorRequest) {
      captured.push(req);
      timeline.push('executor');
      await realCoordinator.init(req.task.taskId);
      const result = await realExecutor.execute(req);
      states.set(req.task.taskId, 'PASSED');
      return { ...result, taskPassed: true } as never;
    },
  };
  const checkpointService = { async capture() {} };

  const deps = {
    sessionService, planner, graphCommitService, graphRepository,
    taskRepository, executionRepository, executionCoordinator, taskExecutor,
    checkpointService,
  } as unknown as Omit<SessionOrchestratorDeps, 'now' | 'nextId' | 'missionStage'>;

  return { deps, now, nextId, timeline, captured, events, model, plannerCalls: () => plannerCalls };
}

// ── Test ──────────────────────────────────────────────────────────────────────

describe('Goal clarification — orchestrator end-to-end (gate → planning → executor prompt)', () => {
  it('waits for answers before planning, threads [user-provided] statements to the prompt, logs GOAL_CLARIFICATION_*', async () => {
    const h = makeHarness();
    const gate = new DeferredGate(h.timeline);
    const missionStage = new MissionIntelligence({ events: h.events, now: h.now, newId: h.nextId, clarificationGate: gate });
    const orch = new SessionOrchestrator({ ...h.deps, missionStage, now: h.now, nextId: h.nextId });

    let settled = false;
    const run: Promise<SessionOrchestratorResult> = orch.run({ sessionId: SESSION, goal: GOAL, revision: REVISION, graphVersion: 1 })
      .finally(() => { settled = true; });

    // ── While the gate is pending: no planning, REQUESTED already in the shared log ──
    await gate.called;
    await new Promise((r) => setTimeout(r, 20)); // give any wrongly-unblocked work a chance to run
    expect(settled).toBe(false);
    expect(h.plannerCalls()).toBe(0);
    expect(h.captured).toHaveLength(0);
    expect(gate.calls).toHaveLength(1);
    expect(gate.calls[0]!.sessionId).toBe(SESSION);

    const pendingTypes = (await h.events.query({ sessionId: SESSION })).map((e) => e.type);
    expect(pendingTypes).toContain('GOAL_CLARIFICATION_REQUESTED');
    expect(pendingTypes).not.toContain('GOAL_CLARIFICATION_ANSWERED');

    // ── Resolve: answer q1 only (others skipped; no advisor wired → no defaults) ──
    const req = gate.calls[0]!.request;
    expect(req.openQuestions.length).toBeGreaterThanOrEqual(2);
    const q1 = req.openQuestions[0]!;
    const statement = `[user-provided] ${q1.text} → nested Python lists`;
    gate.resolve({ kind: 'answered', answers: { q1: '  nested\nPython lists ' } });

    const result = await run;
    expect(result.sessionState).toBe('COMPLETED');

    // Planner ran strictly after the gate resolved (Requirement 3.3).
    expect(h.timeline.indexOf('gate:await')).toBeLessThan(h.timeline.indexOf('gate:resolved'));
    expect(h.timeline.indexOf('gate:resolved')).toBeLessThan(h.timeline.indexOf('planner'));
    expect(h.timeline.indexOf('planner')).toBeLessThan(h.timeline.indexOf('executor'));
    expect(h.plannerCalls()).toBe(1);

    // TaskExecutorRequest carries the user statement (Requirement 7.9).
    expect(h.captured).toHaveLength(1);
    expect(h.captured[0]!.goalAssumptions).toEqual([statement]);

    // The real TaskExecutor prompt has STATED_ASSUMPTIONS with that statement (Requirement 7.10).
    const prompt = h.model.lastPrompt ?? '';
    expect(prompt).toContain('STATED_ASSUMPTIONS');
    expect(prompt).toContain(statement);

    // Both GOAL_CLARIFICATION_* events are in the shared SQLite log, in order (Requirement 9.1).
    const all = await h.events.query({ sessionId: SESSION });
    const types = all.map((e) => e.type);
    const iReq = types.indexOf('GOAL_CLARIFICATION_REQUESTED');
    const iAns = types.indexOf('GOAL_CLARIFICATION_ANSWERED');
    expect(iReq).toBeGreaterThanOrEqual(0);
    expect(iAns).toBeGreaterThan(iReq);
    expect(types.filter((t) => t.startsWith('GOAL_CLARIFICATION_'))).toHaveLength(2);
    const answered = all[iAns]!.payload as Record<string, unknown>;
    expect(answered).toMatchObject({
      requestId: req.requestId,
      source: 'user',
      answers: [{ questionId: 'q1', question: q1.text, answer: 'nested Python lists' }],
      skippedQuestionIds: req.openQuestions.slice(1).map((q) => q.id),
      assumptions: [statement],
    });
    const requested = all[iReq]!.payload as Record<string, unknown>;
    expect(requested).toMatchObject({ requestId: req.requestId, goalId: 'G', level: 'UNKNOWN' });
  });
});
