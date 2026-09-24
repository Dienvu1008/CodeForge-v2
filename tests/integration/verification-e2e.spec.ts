// P1.5-I1 — VerificationEngine E2E (PHASE_1_5_ROADMAP §4.7).
//
// Full lifecycle: TaskRun SUCCEEDED → VerificationEngine runs checks via
// FakeProcessSupervisor → report PASS fresh → CompletionGate passes → Task PASSED.
//
// Verifies TI-005 is enforced: VERIFYING → PASSED only with valid evidence.
// Adversarial: no report → cannot complete. Stale evidence → cannot complete.
// Scope check: SMOKE-scope report cannot satisfy AFFECTED_DIRECT requirement.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  SqliteDatabaseAdapter,
  SqliteVerificationRepository,
  SqliteTaskRepository,
  SqliteTaskRunRepository,
  SqliteTaskExecutionRepository,
  SqliteEventLog,
  runMigrations,
  createMigrationRegistry,
} from '@codeforge/infrastructure';
import {
  VerificationEngine,
  CompletionGate,
  CompletionGateError,
  ExecutionCoordinator,
  TaskRunService,
  NoopProcessReconciler,
  transitionTask,
  DEFAULT_VERIFICATION_POLICY,
  SMOKE_VERIFICATION_POLICY,
  type VerificationPolicy,
} from '@codeforge/agent-core';
import type { Task, TaskRun, WorkspaceRevision } from '@codeforge/agent-core';
import { FakeProcessSupervisor, FakeRevisionProvider } from '@codeforge/testing';

// ── helpers ───────────────────────────────────────────────────────────────────

function makeCounters(): { now: () => string; nextId: () => string } {
  let t = 0; let n = 0;
  return {
    now:    () => `2026-01-01T00:00:${String(t++).padStart(2, '0')}.000Z`,
    nextId: () => `ID-${String(n++).padStart(4, '0')}`,
  };
}

function revision(hash = 'HASH-1', id = 'rev-1'): WorkspaceRevision {
  return {
    revisionId: id,
    canonicalFormVersion: 'v1',
    root: '/r',
    includedPaths: ['src/a.ts'],
    excludedScratchPaths: [],
    hashAlgorithm: 'blake3',
    hash,
    fileCount: 1,
    totalBytes: 100,
    createdAt: '2026-01-01T00:00:00.000Z',
    createdBy: { sessionId: 'S', reason: 'pre_verify' },
  };
}

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

function run(taskId: string, runId: string): TaskRun {
  return {
    taskRunId: runId,
    taskId,
    sessionId: 'S',
    attemptNumber: 1,
    state: 'RUNNING',
    graphVersionAtStart: 1,
    workspaceRevisionAtStart: revision(),
    strategyUsed: { kind: 'generate' },
    startedAt: '2026-01-01T00:00:00.000Z',
    toolCalls: [],
    failures: [],
    budgetConsumed: { wallClockMs: 0, modelTokens: 0, toolCalls: 0, recoveryAttempts: 0 },
  };
}

const POLICY_WITH_CHECK: VerificationPolicy = {
  ...DEFAULT_VERIFICATION_POLICY,
  checks: [
    { name: 'typecheck', kind: 'typecheck', command: 'tsc', args: ['--noEmit'],
      minScope: 'AFFECTED_DIRECT', timeoutMs: 5000 },
  ],
};

let db: SqliteDatabaseAdapter;
let verReports: SqliteVerificationRepository;
let events: SqliteEventLog;
let supervisor: FakeProcessSupervisor;
let revProvider: FakeRevisionProvider;
let engine: VerificationEngine;
let gate: CompletionGate;
let exec: ExecutionCoordinator;
let taskRuns: SqliteTaskRunRepository;

beforeEach(async () => {
  db = new SqliteDatabaseAdapter(':memory:');
  db.open();
  runMigrations(db, createMigrationRegistry(), { now: () => '2026-01-01T00:00:00.000Z' });
  // Seed session + task + task_run rows for FK.
  db.execute(
    `INSERT INTO sessions
       (session_id, workspace_id, workspace_root, goal_id, graph_version, state,
        created_at, updated_at, runtime_version, schema_version, budget_id, lock_id, metadata_json)
     VALUES ('S','W','/r','G',1,'RUNNING','t','t','0.1.0',1,'B','L','{}')`,
  );
  const tasks = new SqliteTaskRepository(db);
  await tasks.create(task('T1'));
  taskRuns = new SqliteTaskRunRepository(db);
  verReports = new SqliteVerificationRepository(db);
  events     = new SqliteEventLog(db);
  supervisor = new FakeProcessSupervisor();
  revProvider = new FakeRevisionProvider(revision()); // R_after = same hash → no drift
  const c     = makeCounters();
  engine = new VerificationEngine({
    reports: verReports, events, supervisor, revisionProvider: revProvider,
    now: c.now, nextId: c.nextId,
  });
  gate  = new CompletionGate({ reports: verReports });
  exec  = new ExecutionCoordinator({
    executions: new SqliteTaskExecutionRepository(db), now: c.now,
  });
  const taskRunSvc = new TaskRunService({
    runs: taskRuns, events, reconciler: new NoopProcessReconciler(),
    now: c.now, nextId: c.nextId,
  });
  // Initialize projection + start run.
  await exec.init('T1');
  await exec.setState('T1', 'READY');
  await taskRunSvc.start(run('T1', 'R1'));
  await exec.onRunStarted('T1', 'R1');
  // Finalize run SUCCEEDED → projection moves to VERIFYING.
  await taskRunSvc.finalize('R1', 'RUN_SUCCEEDED', revision());
  await exec.onRunEnded('T1', 'R1', 'SUCCEEDED');
  // Confirm projection is VERIFYING.
  expect((await exec.get('T1'))?.currentState).toBe('VERIFYING');
});
afterEach(() => db.close());

// ─────────────────────────────────────────────────────────────────────────────
// Happy path: VerificationEngine → PASS → CompletionGate → Task PASSED
// ─────────────────────────────────────────────────────────────────────────────

describe('P1.5-I1 VerificationEngine E2E — happy path', () => {
  it('drives VERIFYING → PASSED via VerificationEngine + CompletionGate (TI-005)', async () => {
    supervisor.setSequence([{ exitCode: 0, stdout: 'ok', stderr: '' }]);

    // Step 1: VerificationEngine runs checks and produces a PASS report.
    const report = await engine.verify({
      sessionId: 'S',
      taskId: 'T1',
      taskRunId: 'R1',
      targetRevision: revision(),
      policy: POLICY_WITH_CHECK,
      reason: 'task_completion',
    });
    expect(report.status).toBe('PASS');
    expect(report.checks).toHaveLength(1);
    expect(report.checks[0]?.status).toBe('PASS');

    // Step 2: CompletionGate confirms canComplete (TI-005 northstar).
    const check = await gate.canComplete('T1', revision());
    expect(check.canComplete).toBe(true);
    expect(check.report?.verificationId).toBe(report.verificationId);

    // Step 3: Wire into TaskStateMachine — VERIFYING → PASSED.
    const transition = transitionTask('VERIFYING', 'VERIFICATION_PASSED', {
      reportValid: true,
      fresh: true,
    });
    expect(transition).toMatchObject({ ok: true, next: 'PASSED' });
    await exec.setState('T1', 'PASSED');
    expect((await exec.get('T1'))?.currentState).toBe('PASSED');

    // Events: VERIFICATION_STARTED + VERIFICATION_ENDED must be present.
    const types = (await events.query({ sessionId: 'S' })).map((e) => e.type);
    expect(types).toContain('VERIFICATION_STARTED');
    expect(types).toContain('VERIFICATION_ENDED');
  });

  it('VerificationEngine.verify() with FAIL check → FAIL report → canComplete=false', async () => {
    supervisor.setSequence([{ exitCode: 1, stderr: 'type error' }]);

    const report = await engine.verify({
      sessionId: 'S', taskId: 'T1', taskRunId: 'R1',
      targetRevision: revision(), policy: POLICY_WITH_CHECK, reason: 'task_completion',
    });
    expect(report.status).toBe('FAIL');

    const check = await gate.canComplete('T1', revision());
    expect(check.canComplete).toBe(false);
    expect(check.reason).toBe('VERIFICATION_NOT_PASSED');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TI-005 enforcement: no shortcut to PASSED
// ─────────────────────────────────────────────────────────────────────────────

describe('P1.5-I1 TI-005 enforcement — no shortcut to PASSED', () => {
  it('TI-005: without a verification report, canComplete=false (NO_VERIFICATION_REPORT)', async () => {
    const check = await gate.canComplete('T1', revision());
    expect(check.canComplete).toBe(false);
    expect(check.reason).toBe('NO_VERIFICATION_REPORT');
  });

  it('TI-005: transitionTask VERIFYING→PASSED without ctx fails (SM-002 guard)', () => {
    const r = transitionTask('VERIFYING', 'VERIFICATION_PASSED', {});
    expect(r).toMatchObject({ ok: false, code: 'GUARD_FAILED' });
  });

  it('VR-002: stale evidence (hash changed) → STALE_EVIDENCE', async () => {
    supervisor.setSequence([{ exitCode: 0 }]);
    await engine.verify({
      sessionId: 'S', taskId: 'T1', taskRunId: 'R1',
      targetRevision: revision('HASH-OLD'), policy: POLICY_WITH_CHECK, reason: 'task_completion',
    });

    const check = await gate.canComplete('T1', revision('HASH-NEW'));
    expect(check.canComplete).toBe(false);
    expect(check.reason).toBe('STALE_EVIDENCE');
  });

  it('VR-004: SMOKE report cannot satisfy AFFECTED_DIRECT requirement (SCOPE_INSUFFICIENT)', async () => {
    const smokePolicy: VerificationPolicy = {
      ...SMOKE_VERIFICATION_POLICY,
      checks: [{ name: 's', kind: 'build', command: 'tsc', args: [],
                 minScope: 'SMOKE', timeoutMs: 1000 }],
    };
    supervisor.setSequence([{ exitCode: 0 }]);
    await engine.verify({
      sessionId: 'S', taskId: 'T1', taskRunId: 'R1',
      targetRevision: revision(), policy: smokePolicy, reason: 'task_completion',
    });

    const check = await gate.canComplete('T1', revision(), 'AFFECTED_DIRECT');
    expect(check.canComplete).toBe(false);
    expect(check.reason).toBe('SCOPE_INSUFFICIENT');
  });

  it('assertCanComplete throws CompletionGateError (TI-005 hard enforcement)', async () => {
    const err = await gate.assertCanComplete('T1', revision()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CompletionGateError);
    expect((err as CompletionGateError).code).toBe('NO_VERIFICATION_REPORT');
  });
});
