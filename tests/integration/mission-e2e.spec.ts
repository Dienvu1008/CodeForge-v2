// Phase 12 E2E (§31) — the MissionIntelligence stage wired into a REAL SessionOrchestrator over
// a REAL SQLite kernel (no fakes at the seam). Proves end-to-end:
//   MI-002: --mission off (no stage) and a proceed=true stage reach the SAME terminal state
//           (COMPLETED) and emit NO extra authority — flag-off parity against the real kernel.
//   MI-001/MI-007: a complex goal whose architecture needs an UNVERIFIED capability makes the
//           ArchitectureGate BLOCK → the session ends AWAITING_HUMAN and NO task graph is built.
//   MI-004: on BLOCK the graph stays at the empty seed (v1, 0 nodes) — the stage created no Tasks.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  SqliteDatabaseAdapter,
  SqliteSessionRepository,
  SqliteTaskRepository,
  SqliteTaskRunRepository,
  SqliteTaskExecutionRepository,
  SqliteTaskGraphRepository,
  SqliteGraphCommitter,
  SqliteCheckpointRepository,
  SqliteWorkspaceLockService,
  SqliteEventLog,
  SqliteToolCallRepository,
  SqliteApprovalRepository,
  SqliteVerificationRepository,
  Blake3GraphHasher,
  runMigrations,
  createMigrationRegistry,
} from '@codeforge/infrastructure';
import {
  SessionService,
  SessionOrchestrator,
  Planner,
  GraphCommitService,
  GraphService,
  ExecutionCoordinator,
  TaskRunService,
  TaskExecutor,
  CheckpointService,
  NoopProcessReconciler,
  PERMISSIVE_TEST_POLICY,
  DEFAULT_VERIFICATION_POLICY,
  VerificationEngine,
  CompletionGate,
  ToolGateway,
  ContextBuilder,
  MissionIntelligence,
  MissionArchitect,
} from '@codeforge/agent-core';
import type { Session, Goal, WorkspaceRevision } from '@codeforge/agent-core';
import { FakeModel, FakeRevisionProvider } from '@codeforge/testing';

function counters() {
  let t = 0; let n = 0;
  return {
    now:    () => '2026-01-01T00:00:' + String(t++ % 60).padStart(2, '0') + '.000Z',
    nextId: () => 'ID-' + String(n++).padStart(5, '0'),
  };
}

const REVISION: WorkspaceRevision = {
  revisionId: 'rev-1', canonicalFormVersion: 'v1', root: '/r',
  includedPaths: [], excludedScratchPaths: [],
  hashAlgorithm: 'blake3', hash: 'HASH-1', fileCount: 0, totalBytes: 0,
  createdAt: '2026-01-01T00:00:00.000Z', createdBy: { sessionId: 'S', reason: 'session_start' },
};

function goal(description: string): Goal {
  return {
    goalId: 'G', version: 1, description,
    constraints: [], acceptanceCriteria: [{ criterionId: 'AC1', description: 'done', mandatory: true }],
    createdAt: '2026-01-01T00:00:00.000Z', createdBy: 'user',
  };
}

function session(): Session {
  return {
    sessionId: 'S', workspaceId: 'W', workspaceRoot: '/r',
    goalId: 'G', graphVersion: 1, state: 'CREATED',
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    runtimeVersion: '0.12.0', schemaVersion: 1, budgetId: 'B', lockId: 'L',
    metadata: { hostname: 'h', processId: 1, ollamaEndpoint: 'http://localhost:11434',
      ollamaModels: { planner: 'p', critic: 'c', executor: 'e', analyzer: 'a' } },
  };
}

const PLAN_RESPONSE = JSON.stringify({
  tasks: [{ id: 'T1', description: 'Write greeting.ts', strategy: 'generate' }],
  edges: [], reason: 'minimal plan',
});

let db: SqliteDatabaseAdapter;

/** Build a fully-wired real kernel + orchestrator. `missionStage` optional (MI-002 flag). */
async function buildRuntime(opts: { missionStage?: MissionIntelligence } = {}) {
  const c = counters();
  const model = new FakeModel();
  model.setSequence([PLAN_RESPONSE, JSON.stringify({ type: 'done', summary: 'greeting.ts created' })]);
  const revProvider = new FakeRevisionProvider(REVISION);

  const sessions   = new SqliteSessionRepository(db);
  const events     = new SqliteEventLog(db);
  const tasks      = new SqliteTaskRepository(db);
  const taskRuns   = new SqliteTaskRunRepository(db);
  const executions = new SqliteTaskExecutionRepository(db);
  const graphs     = new SqliteTaskGraphRepository(db);
  const committer  = new SqliteGraphCommitter(db);
  const checkpoints = new SqliteCheckpointRepository(db);
  const lock       = new SqliteWorkspaceLockService(db);
  const toolCalls  = new SqliteToolCallRepository(db);
  const approvals  = new SqliteApprovalRepository(db);
  const verReports = new SqliteVerificationRepository(db);

  const hasher     = new Blake3GraphHasher();
  const graphSvc   = new GraphService({ hasher, now: c.now, nextId: c.nextId, canonicalFormVersion: 'v1', schemaVersion: 1 });
  const graphCommitSvc = new GraphCommitService({ graphs, committer, graphService: graphSvc, now: c.now, nextId: c.nextId });
  const sessionSvc = new SessionService({ sessions, events, lock, now: c.now, nextId: c.nextId });
  const coordinator = new ExecutionCoordinator({ executions, now: c.now });
  const taskRunSvc = new TaskRunService({ runs: taskRuns, events, reconciler: new NoopProcessReconciler(), now: c.now, nextId: c.nextId });
  const checkpointSvc = new CheckpointService({ checkpoints, events, now: c.now, nextId: c.nextId });
  const planner = new Planner({ gateway: model, now: c.now, nextId: c.nextId });

  const verEngine = new VerificationEngine({
    reports: verReports, events,
    supervisor: { spawn: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false, killed: false, durationMs: 0 }) },
    revisionProvider: revProvider, now: c.now, nextId: c.nextId,
  });
  const completionGate = new CompletionGate({ reports: verReports });
  const tg = new ToolGateway({ calls: toolCalls, approvals, events, policy: PERMISSIVE_TEST_POLICY, now: c.now, nextId: c.nextId });
  const ctxBuilder = new ContextBuilder({ now: c.now, nextId: c.nextId });
  const taskExec = new TaskExecutor({
    taskRunService: taskRunSvc, executionCoordinator: coordinator,
    contextBuilder: ctxBuilder, gateway: model, toolGateway: tg,
    executor: { execute: async () => ({ exitCode: 0, stdout: 'ok', stderr: '', timedOut: false }) },
    verificationEngine: verEngine, completionGate, verificationPolicy: DEFAULT_VERIFICATION_POLICY,
    now: c.now, nextId: c.nextId,
  });

  await sessionSvc.create({ session: session(), hostname: 'h', processId: 1 });
  await graphs.commit({
    graphId: 'GR', sessionId: 'S', version: 1, nodes: [], edges: [],
    createdAt: 't', createdBy: 'planner', canonicalHash: 'seed', schemaVersion: 1, canonicalFormVersion: 'v1',
  }, {
    mutationId: 'M0', sessionId: 'S', baseVersion: 0, operations: [],
    proposedBy: 'planner', reason: 'seed',
    provenance: { provenanceId: 'P', source: { kind: 'runtime', id: 'init' }, inputs: [], reason: 'seed', at: 't' },
    createdAt: 't', status: 'COMMITTED',
  });

  const orchestrator = new SessionOrchestrator({
    sessionService: sessionSvc, planner, graphCommitService: graphCommitSvc,
    graphRepository: graphs, taskRepository: tasks, executionRepository: executions,
    executionCoordinator: coordinator, taskExecutor: taskExec, checkpointService: checkpointSvc,
    maxIterations: 10,
    ...(opts.missionStage !== undefined ? { missionStage: opts.missionStage } : {}),
    now: c.now, nextId: c.nextId,
  });

  return { orchestrator, sessions, graphs, events, model, now: c.now, nextId: c.nextId };
}

beforeEach(() => {
  db = new SqliteDatabaseAdapter(':memory:');
  db.open();
  runMigrations(db, createMigrationRegistry(), { now: () => '2026-01-01T00:00:00.000Z' });
});
afterEach(() => db.close());

describe('Phase 12 E2E — MissionIntelligence over the real kernel', () => {
  it('MI-002: --mission off completes the session normally (baseline)', async () => {
    const rt = await buildRuntime();
    const result = await rt.orchestrator.run({ sessionId: 'S', goal: goal('Add a greeting function'), revision: REVISION, graphVersion: 1 });
    expect(result.sessionState).toBe('COMPLETED');
    const s = await rt.sessions.getById('S');
    expect(s?.state).toBe('COMPLETED');
    // No MISSION_* events were emitted (stage absent).
    const evs = await rt.events.query({ sessionId: 'S' });
    expect(evs.filter((e) => e.type.startsWith('MISSION_'))).toHaveLength(0);
  });

  it('MI-002: a proceed=true stage reaches the SAME terminal state (parity) and emits MISSION_* events', async () => {
    // A trivial goal → the stage proceeds (no architecture) → control flow identical to baseline.
    let n = 0;
    const rt = await buildRuntimeWithStageFactory((events) =>
      new MissionIntelligence({ events, now: () => 't', newId: () => `mid-${++n}` }));
    const result = await rt.orchestrator.run({ sessionId: 'S', goal: goal('rename count to total'), revision: REVISION, graphVersion: 1 });
    expect(result.sessionState).toBe('COMPLETED'); // identical terminal state to the baseline
    const evs = await rt.events.query({ sessionId: 'S' });
    expect(evs.some((e) => e.type === 'MISSION_RECEIVED')).toBe(true);
    expect(evs.some((e) => e.type === 'MISSION_CLASSIFIED')).toBe(true);
  });

  it('MI-001/004/007: a gate BLOCK ends the session AWAITING_HUMAN with NO task graph built', async () => {
    // Architect proposes a blueprint requiring an UNVERIFIED capability (no probe wired) → BLOCK.
    const gateway = new FakeModel();
    gateway.setResponse(/.*/, JSON.stringify({
      summary: 'needs docker', requirements: ['containerize'],
      moduleBoundaries: [{ name: 'app', responsibility: 'app', dependsOn: [] }],
      roadmap: [{ name: 'build', outcome: 'image', requiresCapabilities: ['docker'] }],
      verificationStrategy: ['build'], requiredCapabilities: ['docker'], openQuestions: [],
    }));
    let n = 0;
    const buildStage = (events: SqliteEventLog) => new MissionIntelligence({
      events, now: () => 't', newId: () => `mid-${++n}`,
      architect: new MissionArchitect({ gateway, now: () => 't', newProvenanceId: () => `p-${++n}` }),
    });

    const rt = await buildRuntimeWithStageFactory(buildStage);
    const result = await rt.orchestrator.run({
      sessionId: 'S',
      goal: goal('build a new app from scratch with multiple subsystems and a web and android target'),
      revision: REVISION, graphVersion: 1,
    });

    expect(result.sessionState).toBe('AWAITING_HUMAN');  // MI-007 BLOCK path
    const s = await rt.sessions.getById('S');
    expect(s?.state).toBe('AWAITING_HUMAN');
    // MI-004: the planner never ran → the graph is still the empty seed (v1, 0 nodes).
    const g = await rt.graphs.getCurrent('S');
    expect(g.version).toBe(1);
    expect(g.nodes).toHaveLength(0);
    const evs = await rt.events.query({ sessionId: 'S' });
    expect(evs.some((e) => e.type === 'MISSION_ARCHITECTURE_GATE_BLOCKED')).toBe(true);
  });
});

// ── helper: build the runtime with a stage sharing the SAME db/log ───────────────
async function buildRuntimeWithStageFactory(factory: (events: SqliteEventLog) => MissionIntelligence) {
  const events = new SqliteEventLog(db);
  const stage = factory(events);
  return buildRuntime({ missionStage: stage });
}
