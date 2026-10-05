// P5-RE1 — RecoveryEngine: execute recovery actions with provenance (RC-006/007).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  RecoveryEngine, SessionService,
  type ExecuteInput, type Failure,
} from '@codeforge/agent-core';
import {
  SqliteDatabaseAdapter, SqliteEventLog, SqliteSessionRepository,
  SqliteWorkspaceLockService, SqliteRecoveryActionRepository,
  SqliteFailureRepository,
  runMigrations, createMigrationRegistry,
} from '@codeforge/infrastructure';

let n = 0;
function nextId(): string { return 'RE-' + String(++n).padStart(6, '0'); }
let t = 0;
function now(): string { return '2026-01-01T00:00:' + String(t++).padStart(2, '0') + '.000Z'; }


function makeFailure(): Failure {
  return {
    failureId: nextId(), sessionId: 'S', taskId: 'T', taskRunId: 'TR',
    stage: 'verify', class: 'LOGIC', signature: 'sig',
    evidence: { message: 'tests failed' }, detectedAt: now(),
    classifiedBy: 'deterministic', recoveryActionIds: [],
  };
}

describe('P5-RE1 — RecoveryEngine', () => {
  let db: SqliteDatabaseAdapter;
  let engine: RecoveryEngine;
  let sessionSvc: SessionService;
  let recoveryRepo: SqliteRecoveryActionRepository;
  let failureRepo: SqliteFailureRepository;

  beforeEach(() => {
    n = 0; t = 0;
    db = new SqliteDatabaseAdapter(':memory:'); db.open();
    runMigrations(db, createMigrationRegistry(), { now: () => 't' });
    db.execute("INSERT INTO sessions (session_id, workspace_id, workspace_root, goal_id, graph_version, state, created_at, updated_at, runtime_version, schema_version, budget_id, lock_id, metadata_json) VALUES ('S','W','/','G',1,'RUNNING','t','t','0.4.0',1,'B','L','{}')");
    db.execute("INSERT INTO tasks (task_id, description, acceptance_json, constraints_json, priority, strategy_json, created_at, created_by, schema_version) VALUES ('T','task','[]','[]',1,'{\"kind\":\"generate\"}','t','planner',1)");
    const events = new SqliteEventLog(db);
    const sessions = new SqliteSessionRepository(db);
    const lock = new SqliteWorkspaceLockService(db);
    recoveryRepo = new SqliteRecoveryActionRepository(db);
    failureRepo  = new SqliteFailureRepository(db);
    sessionSvc = new SessionService({ sessions, events, lock, now, nextId });
    engine = new RecoveryEngine({ recoveryActions: recoveryRepo, events, sessionService: sessionSvc, now, nextId });
  });
  afterEach(() => db.close());

  async function seedInput(action: ExecuteInput['action']): Promise<ExecuteInput> {
    const f = makeFailure();
    await failureRepo.create(f);
    return { failure: f, action, reason: 'test ' + action, policyVersion: 1, sessionId: 'S' };
  }

  // ── RC-006: every action writes provenance ────────────────────────────────

  it('RC-006: RETRY action creates RecoveryAction record with provenance', async () => {
    const r = await engine.execute(await seedInput('RETRY'));
    expect(r.recoveryAction.actionId).toBeDefined();
    expect(r.recoveryAction.action).toBe('RETRY');
    expect(r.recoveryAction.reason).toBe('test RETRY');
    expect(r.recoveryAction.policyVersion).toBe(1);
    expect(r.recoveryAction.startedAt).toBeDefined();
    expect(r.recoveryAction.endedAt).toBeDefined();
  });

  it('RC-006: FIX action persisted to DB', async () => {
    const r = await engine.execute(await seedInput('FIX'));
    const stored = await recoveryRepo.getById(r.recoveryAction.actionId);
    expect(stored?.action).toBe('FIX');
    expect(stored?.outcome).toBe('SUCCEEDED');
  });

  // ── shouldRetry flag ──────────────────────────────────────────────────────

  it('RETRY → shouldRetry=true', async () => {
    const r = await engine.execute(await seedInput('RETRY'));
    expect(r.shouldRetry).toBe(true);
    expect(r.sessionEscalated).toBe(false);
  });

  it('FIX → shouldRetry=true', async () => {
    const r = await engine.execute(await seedInput('FIX'));
    expect(r.shouldRetry).toBe(true);
  });

  it('REPLAN → shouldRetry=false, outcome=PENDING (Phase 5.5 deferred)', async () => {
    const r = await engine.execute(await seedInput('REPLAN'));
    expect(r.shouldRetry).toBe(false);
    expect(r.recoveryAction.outcome).toBe('PENDING');
  });

  it('ROLLBACK → shouldRetry=false, outcome=PENDING (Phase 5.5 deferred)', async () => {
    const r = await engine.execute(await seedInput('ROLLBACK'));
    expect(r.shouldRetry).toBe(false);
    expect(r.recoveryAction.outcome).toBe('PENDING');
  });

  // ── RC-007: ESCALATE → AWAITING_HUMAN ────────────────────────────────────

  it('RC-007: ESCALATE transitions session to AWAITING_HUMAN', async () => {
    const r = await engine.execute(await seedInput('ESCALATE'));
    expect(r.sessionEscalated).toBe(true);
    expect(r.recoveryAction.outcome).toBe('SUCCEEDED');
    // Verify session state in DB
    const sessions = db.query<{ state: string }>('SELECT state FROM sessions WHERE session_id = ?', ['S']);
    expect(sessions[0]?.state).toBe('AWAITING_HUMAN');
  });

  it('RC-006: ESCALATE action persisted with provenance', async () => {
    const r = await engine.execute(await seedInput('ESCALATE'));
    const stored = await recoveryRepo.getById(r.recoveryAction.actionId);
    expect(stored?.action).toBe('ESCALATE');
    expect(stored?.reason).toBe('test ESCALATE');
  });

  // ── ABORT ─────────────────────────────────────────────────────────────────

  it('ABORT transitions session to CANCELLING', async () => {
    await engine.execute(await seedInput('ABORT'));
    const sessions = db.query<{ state: string }>('SELECT state FROM sessions WHERE session_id = ?', ['S']);
    // RUNNING → CANCEL_REQUESTED → CANCELLING
    expect(sessions[0]?.state).toBe('CANCELLING');
  });

  // ── setOutcome ────────────────────────────────────────────────────────────

  it('setOutcome updates the outcome in DB', async () => {
    const r = await engine.execute(await seedInput('REPLAN'));
    await recoveryRepo.setOutcome(r.recoveryAction.actionId, 'SUCCEEDED', now());
    const updated = await recoveryRepo.getById(r.recoveryAction.actionId);
    expect(updated?.outcome).toBe('SUCCEEDED');
  });

  // ── getByFailure ──────────────────────────────────────────────────────────

  it('getByFailure returns actions for a failure', async () => {
    const f = makeFailure();
    await failureRepo.create(f);
    const inp: ExecuteInput = { failure: f, action: 'RETRY', reason: 'r', policyVersion: 1, sessionId: 'S' };
    const r = await engine.execute(inp);
    const actions = await recoveryRepo.getByFailure(f.failureId);
    expect(actions).toHaveLength(1);
    expect(actions[0]?.actionId).toBe(r.recoveryAction.actionId);
  });
});