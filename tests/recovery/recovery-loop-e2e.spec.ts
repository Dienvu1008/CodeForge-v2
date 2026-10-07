// P10.2 — Recovery loop end-to-end (SessionOrchestrator + real verification wiring).
//
// Proves the P10.2 contract WITHOUT a real model: the agent "succeeds" its run (model
// returns done) but VERIFICATION is red, so the task does NOT reach PASSED. The
// orchestrator must then:
//   1. classify the failure from the verification report (test → LOGIC),
//   2. persist a Failure (so no-progress history accrues),
//   3. retry (reset the task to READY) with the red output as prior evidence,
//   4. eventually PASS when the checks go green, OR
//   5. ESCALATE (session → AWAITING_HUMAN) when stuck (no-progress / max attempts).
//
// The "fix" between attempts is simulated by a verification supervisor whose check exit
// code follows a configured sequence (1,1,…,0). This is the frozen VerificationEngine's
// real path — only the spawn result is faked.
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
  Blake3GraphHasher,
  SqliteToolCallRepository,
  SqliteApprovalRepository,
  SqliteVerificationRepository,
  SqliteFailureRepository,
  SqliteRecoveryActionRepository,
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
  VerificationEngine,
  CompletionGate,
  ToolGateway,
  ContextBuilder,
  FailureAnalyzer,
  RecoveryEngine,
  buildVerificationPolicy,
} from '@codeforge/agent-core';
import type { Session, Goal, WorkspaceRevision, SpawnOptions, SpawnResult } from '@codeforge/agent-core';
import { FakeModel, FakeRevisionProvider } from '@codeforge/testing';

function makeCounters(): { now: () => string; nextId: () => string } {
  let t = 0; let n = 0;
  return {
    // Monotonic ISO time so Failure.detectedAt ordering is unambiguous across attempts.
    now:    () => '2026-01-01T00:' + String(Math.floor(t / 60)).padStart(2, '0') + ':' + String((t++) % 60).padStart(2, '0') + '.000Z',
    nextId: () => 'ID-' + String(n++).padStart(5, '0'),
  };
}

const REVISION: WorkspaceRevision = {
  revisionId: 'rev-1', canonicalFormVersion: 'v1', root: '/r',
  includedPaths: [], excludedScratchPaths: [],
  hashAlgorithm: 'blake3', hash: 'HASH-1', fileCount: 0, totalBytes: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  createdBy: { sessionId: 'S', reason: 'session_start' },
};

function makeGoal(): Goal {
  return {
    goalId: 'G', version: 1, description: 'Fix the failing test',
    constraints: [], acceptanceCriteria: [{ criterionId: 'AC1', description: 'tests pass', mandatory: true }],
    createdAt: '2026-01-01T00:00:00.000Z', createdBy: 'user',
  };
}

function makeSession(): Session {
  return {
    sessionId: 'S', workspaceId: 'W', workspaceRoot: '/r',
    goalId: 'G', graphVersion: 1, state: 'CREATED',
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    runtimeVersion: '0.10.0', schemaVersion: 1, budgetId: 'B', lockId: 'L',
    metadata: { hostname: 'h', processId: 1, ollamaEndpoint: 'http://localhost:11434',
      ollamaModels: { planner: 'p', critic: 'c', executor: 'e', analyzer: 'a' } },
  };
}

const PLAN_RESPONSE = JSON.stringify({
  tasks: [{ id: 'T1', description: 'make the test pass', strategy: 'generate' }],
  edges: [], reason: 'single fix task',
});

/**
 * A verification supervisor whose check exit code follows a configured sequence. Models
 * "the agent fixed it on attempt K": exitCodes[i] is used on the i-th check spawn; the
 * last entry repeats. Captures the failing output like WorkspaceProcessSupervisor does.
 */
class SequencedCheckSupervisor {
  private i = 0;
  private _lastFailure = '';
  constructor(private readonly exitCodes: readonly number[]) {}
  async spawn(options: SpawnOptions): Promise<SpawnResult> {
    const idx = Math.min(this.i, this.exitCodes.length - 1);
    const exitCode = this.exitCodes[idx]!;
    this.i++;
    const stderr = exitCode === 0 ? '' : `1 failed, 0 passed\nAssertionError: expected 3 got 5 (${options.command} ${options.args.join(' ')})`;
    this._lastFailure = exitCode === 0 ? '' : `$ ${options.command} ${options.args.join(' ')}\n(exit ${exitCode})\n${stderr}`;
    return { exitCode, stdout: '', stderr, timedOut: false, killed: false, durationMs: 1 };
  }
  lastFailureOutput(): string { return this._lastFailure; }
}

let db: SqliteDatabaseAdapter;
beforeEach(() => {
  db = new SqliteDatabaseAdapter(':memory:');
  db.open();
  runMigrations(db, createMigrationRegistry(), { now: () => '2026-01-01T00:00:00.000Z' });
});
afterEach(() => db.close());

async function wire(c: ReturnType<typeof makeCounters>, checkExitCodes: readonly number[]) {
  const model = new FakeModel();
  // Deterministic regardless of retry count: planner prompt vs executor prompt.
  model.setResponse(/PLANNING TASK/, PLAN_RESPONSE);
  model.setResponse(/Decide the next action/, JSON.stringify({ type: 'done', summary: 'edited the code' }));
  const revProvider = new FakeRevisionProvider(REVISION);

  const sessions = new SqliteSessionRepository(db);
  const events = new SqliteEventLog(db);
  const tasks = new SqliteTaskRepository(db);
  const taskRuns = new SqliteTaskRunRepository(db);
  const executions = new SqliteTaskExecutionRepository(db);
  const graphs = new SqliteTaskGraphRepository(db);
  const committer = new SqliteGraphCommitter(db);
  const checkpoints = new SqliteCheckpointRepository(db);
  const lock = new SqliteWorkspaceLockService(db);
  const toolCalls = new SqliteToolCallRepository(db);
  const approvals = new SqliteApprovalRepository(db);
  const verReports = new SqliteVerificationRepository(db);
  const failures = new SqliteFailureRepository(db);
  const recoveryActions = new SqliteRecoveryActionRepository(db);

  const hasher = new Blake3GraphHasher();
  const graphSvc = new GraphService({ hasher, now: c.now, nextId: c.nextId, canonicalFormVersion: 'v1', schemaVersion: 1 });
  const graphCommitSvc = new GraphCommitService({ graphs, committer, graphService: graphSvc, now: c.now, nextId: c.nextId });
  const sessionSvc = new SessionService({ sessions, events, lock, now: c.now, nextId: c.nextId });
  const coordinator = new ExecutionCoordinator({ executions, now: c.now });
  const taskRunSvc = new TaskRunService({ runs: taskRuns, events, reconciler: new NoopProcessReconciler(), now: c.now, nextId: c.nextId });
  const checkpointSvc = new CheckpointService({ checkpoints, events, now: c.now, nextId: c.nextId });
  const planner = new Planner({ gateway: model, now: c.now, nextId: c.nextId });

  const checkSupervisor = new SequencedCheckSupervisor(checkExitCodes);
  const verEngine = new VerificationEngine({ reports: verReports, events, supervisor: checkSupervisor, revisionProvider: revProvider, now: c.now, nextId: c.nextId });
  const completionGate = new CompletionGate({ reports: verReports });
  // A real derived policy with a single `test` check (LOGIC class → FIX/RETRY).
  const verificationPolicy = buildVerificationPolicy({ hasPackageJson: true, packageScripts: ['test'], hasTsconfig: false });

  const taskExec = new TaskExecutor({
    taskRunService: taskRunSvc, executionCoordinator: coordinator,
    contextBuilder: new ContextBuilder({ now: c.now, nextId: c.nextId }), gateway: model,
    toolGateway: new ToolGateway({ calls: toolCalls, approvals, events, policy: PERMISSIVE_TEST_POLICY, now: c.now, nextId: c.nextId }),
    executor: { execute: async () => ({ exitCode: 0, stdout: 'ok', stderr: '', timedOut: false }) },
    verificationEngine: verEngine, completionGate, verificationPolicy,
    now: c.now, nextId: c.nextId,
  });

  const failureAnalyzer = new FailureAnalyzer({ failures, events, now: c.now, nextId: c.nextId });
  const recoveryEngine = new RecoveryEngine({ recoveryActions, events, sessionService: sessionSvc, now: c.now, nextId: c.nextId });

  await sessionSvc.create({ session: makeSession(), hostname: 'h', processId: 1 });
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
    sessionService: sessionSvc, planner, graphCommitService: graphCommitSvc, graphRepository: graphs,
    taskRepository: tasks, executionRepository: executions, executionCoordinator: coordinator,
    taskExecutor: taskExec, checkpointService: checkpointSvc, maxIterations: 20,
    taskRunRepository: taskRuns,
    failureAnalyzer, recoveryEngine, failureRepository: failures,
    verificationEvidenceProvider: { lastFailureOutput: () => checkSupervisor.lastFailureOutput() },
    now: c.now, nextId: c.nextId,
  });

  return { orchestrator, sessions, executions, failures };
}

describe('P10.2 recovery loop — verification FAIL drives self-fix', () => {
  it('red test on attempt 1, green on attempt 2 → task eventually PASSED', async () => {
    const c = makeCounters();
    // First check spawn exits 1 (red), subsequent spawns exit 0 (fixed).
    const { orchestrator, executions, failures } = await wire(c, [1, 0]);

    const result = await orchestrator.run({ sessionId: 'S', goal: makeGoal(), revision: REVISION, graphVersion: 1 });

    // At least one failure was recorded and classified LOGIC (test kind).
    const allFailures = await failures.getBySession('S');
    expect(allFailures.length).toBeGreaterThanOrEqual(1);
    const taskId = allFailures[0]!.taskId;
    const hist = await failures.getByTask(taskId);
    expect(hist.length).toBeGreaterThanOrEqual(1);
    expect(hist[0]!.class).toBe('LOGIC');

    // The task reached PASSED after the retry.
    const proj = await executions.getByTask(taskId);
    expect(proj?.currentState).toBe('PASSED');
    expect(result.passedTaskIds).toContain(taskId);
  });

  it('always-red test → no-progress → ESCALATE (session AWAITING_HUMAN), bounded', async () => {
    const c = makeCounters();
    // Every check exits 1 — the agent can never make it green.
    const { orchestrator, sessions, failures } = await wire(c, [1]);

    const result = await orchestrator.run({ sessionId: 'S', goal: makeGoal(), revision: REVISION, graphVersion: 1 });

    // Session escalated to a human instead of looping forever.
    const s = await sessions.getById('S');
    expect(s?.state).toBe('AWAITING_HUMAN');

    // Bounded: failures were recorded but did not run away (LOGIC max 3 attempts + no-progress).
    const all = await failures.getBySession('S');
    expect(all.length).toBeGreaterThanOrEqual(1);
    expect(all.length).toBeLessThanOrEqual(6);
    expect(all.every((f) => f.class === 'LOGIC')).toBe(true);

    // Not PASSED.
    expect(result.passedTaskIds.length).toBe(0);
  });
});
