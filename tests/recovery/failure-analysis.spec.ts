// P5-FA1/RP1/NPD1 — FailureClassifier + FailureAnalyzer + RecoveryPolicy + NoProgressDetector.
// Also covers RC-001..RC-008 invariants.
import { describe, it, expect, beforeEach } from 'vitest';
import {
  classifyFailure, FailureAnalyzer, decide, detectNoProgress,
  DEFAULT_RECOVERY_POLICY, RECOVERY_POLICY_VERSION,
  type ClassifierInput, type DecisionInput, type AnalyzeInput,
} from '@codeforge/agent-core';
import type { Failure, VerificationReport, TaskRun, VerificationScope } from '@codeforge/agent-core';
import {
  SqliteDatabaseAdapter, SqliteEventLog, runMigrations, createMigrationRegistry,
} from '@codeforge/infrastructure';

// ── helpers ───────────────────────────────────────────────────────────────────

let n = 0;
function nextId(): string { return 'FA-' + String(++n).padStart(6, '0'); }
let t = 0;
function now(): string { return '2026-01-01T00:00:' + String(t++).padStart(2,'0') + '.000Z'; }

function makeReport(status: VerificationReport['status'], checkStatus?: 'PASS'|'FAIL'|'ERROR'): VerificationReport {
  return {
    verificationId: nextId(), sessionId: 'S', taskId: 'T', taskRunId: 'TR',
    targetWorkspaceRevision: { revisionId: 'r', canonicalFormVersion: 'v1', root: '/', includedPaths: [], excludedScratchPaths: [], hashAlgorithm: 'blake3', hash: 'H', fileCount: 0, totalBytes: 0, createdAt: 't', createdBy: { sessionId: 'S', reason: 'session_start' } },
    canonicalFormVersion: 'v1', scope: 'SMOKE' as VerificationScope,
    checks: checkStatus ? [{ checkId: 'c1', kind: 'test', name: 'suite', command: 'vitest', args: [], scope: 'SMOKE' as VerificationScope, exitCode: checkStatus === 'PASS' ? 0 : 1, durationMs: 1, status: checkStatus, executedBy: 'deterministic' }] : [],
    status, startedAt: 't', endedAt: 't', toolVersions: {}, artifacts: [], invariantsChecked: [], schemaVersion: 1,
  };
}

function makeRun(state: TaskRun['state']): TaskRun {
  return {
    taskRunId: nextId(), taskId: 'T', sessionId: 'S', attemptNumber: 1, state,
    graphVersionAtStart: 1, workspaceRevisionAtStart: { revisionId: 'r', canonicalFormVersion: 'v1', root: '/', includedPaths: [], excludedScratchPaths: [], hashAlgorithm: 'blake3', hash: 'H', fileCount: 0, totalBytes: 0, createdAt: 't', createdBy: { sessionId: 'S', reason: 'session_start' } },
    strategyUsed: { kind: 'generate' }, startedAt: 't', toolCalls: [], failures: [],
    budgetConsumed: { wallClockMs: 0, modelTokens: 0, toolCalls: 0, recoveryAttempts: 0 },
  };
}

function makeFailure(cls: Failure['class']): Failure {
  return {
    failureId: nextId(), sessionId: 'S', taskId: 'T', taskRunId: 'TR',
    stage: 'verify', class: cls, signature: 'sig-' + nextId(),
    evidence: { message: 'test failure' }, detectedAt: now(),
    classifiedBy: 'deterministic', recoveryActionIds: [],
  };
}

// ── In-memory FailureRepository for tests ─────────────────────────────────────

class FakeFailureRepo {
  private store: Map<string, Failure> = new Map();
  async create(f: Failure) { this.store.set(f.failureId, f); }
  async getById(id: string) { return this.store.get(id) ?? null; }
  async getByTask(taskId: string) { return [...this.store.values()].filter(f => f.taskId === taskId); }
  async getBySession(sid: string) { return [...this.store.values()].filter(f => f.sessionId === sid); }
}

// ── FailureClassifier ─────────────────────────────────────────────────────────

describe('FailureClassifier (P5-FA1)', () => {
  it('TIMEOUT state → FailureClass TIMEOUT', () => {
    expect(classifyFailure({ taskRunState: 'TIMEOUT' })).toBe('TIMEOUT');
  });

  it('FAILED + build check FAIL → SYNTAX', () => {
    const base = makeReport('FAIL', 'FAIL');
    const buildReport = { ...base, checks: [{ ...base.checks[0]!, kind: 'build' as const }] };
    expect(classifyFailure({ taskRunState: 'FAILED', verificationReport: buildReport })).toBe('SYNTAX');
  });

  it('FAILED + test check FAIL → LOGIC', () => {
    expect(classifyFailure({ taskRunState: 'FAILED', verificationReport: makeReport('FAIL', 'FAIL') })).toBe('LOGIC');
  });

  it('FAILED + report INVALID → ENVIRONMENT', () => {
    expect(classifyFailure({ taskRunState: 'FAILED', verificationReport: makeReport('INVALID') })).toBe('ENVIRONMENT');
  });

  it('FAILED + no report + "error TS" stderr → SYNTAX', () => {
    expect(classifyFailure({ taskRunState: 'FAILED', lastStderr: 'error TS2345: ...' })).toBe('SYNTAX');
  });

  it('FAILED + no report + "FAIL " stderr → LOGIC', () => {
    expect(classifyFailure({ taskRunState: 'FAILED', lastStderr: 'FAIL  tests/foo.spec.ts' })).toBe('LOGIC');
  });

  it('FAILED + no report + no stderr → UNKNOWN', () => {
    expect(classifyFailure({ taskRunState: 'FAILED' })).toBe('UNKNOWN');
  });

  it('classifyFailure is deterministic — same input → same output (RC-003)', () => {
    const input: ClassifierInput = { taskRunState: 'FAILED', lastStderr: 'error TS1234' };
    expect(classifyFailure(input)).toBe(classifyFailure(input));
    expect(classifyFailure(input)).toBe(classifyFailure(input));
  });
});

// ── FailureAnalyzer ───────────────────────────────────────────────────────────

describe('FailureAnalyzer (P5-FA1)', () => {
  let db: SqliteDatabaseAdapter;
  let events: SqliteEventLog;
  let analyzer: FailureAnalyzer;
  let failures: FakeFailureRepo;

  beforeEach(() => {
    n = 0; t = 0;
    db = new SqliteDatabaseAdapter(':memory:'); db.open();
    runMigrations(db, createMigrationRegistry(), { now: () => 't' });
    db.execute("INSERT INTO sessions (session_id, workspace_id, workspace_root, goal_id, graph_version, state, created_at, updated_at, runtime_version, schema_version, budget_id, lock_id, metadata_json) VALUES ('S','W','/','G',1,'RUNNING','t','t','0.4.0',1,'B','L','{}')");
    events = new SqliteEventLog(db);
    failures = new FakeFailureRepo();
    analyzer = new FailureAnalyzer({ failures, events, now, nextId });
  });
  afterEach(() => db.close());

  it('analyze() creates and returns a Failure record (RC-006)', async () => {
    const run = makeRun('FAILED');
    const input: AnalyzeInput = { sessionId: 'S', taskRun: run };
    const f = await analyzer.analyze(input);
    expect(f.failureId).toBeDefined();
    expect(f.sessionId).toBe('S');
    expect(f.classifiedBy).toBe('deterministic');
    expect(f.class).toBe('UNKNOWN'); // no report, no stderr
    expect(f.evidence.message).toBeDefined();
  });

  it('analyze() with TIMEOUT taskRunState → class=TIMEOUT', async () => {
    const f = await analyzer.analyze({ sessionId: 'S', taskRun: makeRun('TIMEOUT') });
    expect(f.class).toBe('TIMEOUT');
  });

  it('analyze() persists to FailureRepository', async () => {
    const run = makeRun('FAILED');
    const f = await analyzer.analyze({ sessionId: 'S', taskRun: run });
    const stored = await failures.getById(f.failureId);
    expect(stored?.failureId).toBe(f.failureId);
  });

  it('signature is deterministic for same taskId + class + stderr', async () => {
    const run = makeRun('FAILED');
    const f1 = await analyzer.analyze({ sessionId: 'S', taskRun: run, lastStderr: 'error TS' });
    n = 0;
    const f2 = await analyzer.analyze({ sessionId: 'S', taskRun: run, lastStderr: 'error TS' });
    expect(f1.signature).toBe(f2.signature);
  });
});

// ── RecoveryPolicy (RC-001..004, RC-008) ─────────────────────────────────────

describe('RecoveryPolicy (P5-RP1)', () => {
  it('RC-001: action is in the allowed set for SYNTAX class', () => {
    const r = decide({ failureClass: 'SYNTAX', attemptsSoFar: 0 });
    expect(DEFAULT_RECOVERY_POLICY.SYNTAX.actions).toContain(r.action);
  });

  it('RC-001: action is in the allowed set for LOGIC class', () => {
    const r = decide({ failureClass: 'LOGIC', attemptsSoFar: 0 });
    expect(DEFAULT_RECOVERY_POLICY.LOGIC.actions).toContain(r.action);
  });

  it('RC-002: UNKNOWN failure → ESCALATE on first attempt', () => {
    const r = decide({ failureClass: 'UNKNOWN', attemptsSoFar: 0 });
    expect(r.action).toBe('ESCALATE');
  });

  it('RC-002: maxAttempts exhausted → ESCALATE regardless of class', () => {
    const r = decide({ failureClass: 'SYNTAX', attemptsSoFar: 10 });
    expect(r.action).toBe('ESCALATE');
  });

  it('RC-004: ROLLBACK not in default policy → skip to next action', () => {
    // None of the default rules allow ROLLBACK, so it can never be returned.
    for (const cls of Object.keys(DEFAULT_RECOVERY_POLICY) as Array<keyof typeof DEFAULT_RECOVERY_POLICY>) {
      for (let i = 0; i < 5; i++) {
        const r = decide({ failureClass: cls, attemptsSoFar: i });
        // ROLLBACK is not in any default actions list
        expect(r.action).not.toBe('ROLLBACK');
      }
    }
  });

  it('RC-008: budget with recoveryAttempts exhausted → ESCALATE', () => {
    const budget = {
      budgetId: 'B', scope: 'session' as const, scopeId: 'S',
      limits:   { wallClockMs: 9999, modelTokens: 9999, toolCalls: 9999, recoveryAttempts: 2 },
      consumed: { wallClockMs: 0, modelTokens: 0, toolCalls: 0, recoveryAttempts: 2 },
      createdAt: 't', updatedAt: 't',
    };
    const r = decide({ failureClass: 'SYNTAX', attemptsSoFar: 0, budget });
    expect(r.action).toBe('ESCALATE');
    expect(r.reason).toMatch('budget');
  });

  it('budget not exhausted → normal action', () => {
    const budget = {
      budgetId: 'B', scope: 'session' as const, scopeId: 'S',
      limits:   { wallClockMs: 9999, modelTokens: 9999, toolCalls: 9999, recoveryAttempts: 10 },
      consumed: { wallClockMs: 0, modelTokens: 0, toolCalls: 0, recoveryAttempts: 1 },
      createdAt: 't', updatedAt: 't',
    };
    const r = decide({ failureClass: 'SYNTAX', attemptsSoFar: 0, budget });
    expect(r.action).not.toBe('ESCALATE');
  });

  it('policyVersion is set on every decision (RC-006)', () => {
    const r = decide({ failureClass: 'LOGIC', attemptsSoFar: 0 });
    expect(r.policyVersion).toBe(RECOVERY_POLICY_VERSION);
  });

  it('decide() is deterministic — same input → same result (RC-003 spirit)', () => {
    const input: DecisionInput = { failureClass: 'SYNTAX', attemptsSoFar: 1 };
    expect(decide(input).action).toBe(decide(input).action);
  });

  it('attempts progress through action list', () => {
    const a0 = decide({ failureClass: 'SYNTAX', attemptsSoFar: 0 }).action;
    const a1 = decide({ failureClass: 'SYNTAX', attemptsSoFar: 1 }).action;
    const a2 = decide({ failureClass: 'SYNTAX', attemptsSoFar: 2 }).action;
    // Should be FIX → REPLAN → ESCALATE
    expect(a0).toBe('FIX');
    expect(a1).toBe('REPLAN');
    expect(a2).toBe('ESCALATE');
  });
});

// ── NoProgressDetector (RC-002, RC-003) ──────────────────────────────────────

describe('NoProgressDetector (P5-NPD1)', () => {
  it('fewer than threshold failures → noProgress=false', () => {
    const r = detectNoProgress([makeFailure('SYNTAX'), makeFailure('SYNTAX')], 3);
    expect(r.noProgress).toBe(false);
  });

  it('N consecutive same class (non-UNKNOWN) → noProgress=true (RC-002)', () => {
    const failures = [makeFailure('LOGIC'), makeFailure('LOGIC'), makeFailure('LOGIC')];
    const r = detectNoProgress(failures, 3);
    expect(r.noProgress).toBe(true);
    expect(r.repeatingClass).toBe('LOGIC');
  });

  it('mixed classes → noProgress=false', () => {
    const failures = [makeFailure('SYNTAX'), makeFailure('LOGIC'), makeFailure('SYNTAX')];
    const r = detectNoProgress(failures, 3);
    expect(r.noProgress).toBe(false);
  });

  it('RC-003: all UNKNOWN → noProgress=false (inconclusive signal)', () => {
    const failures = [makeFailure('UNKNOWN'), makeFailure('UNKNOWN'), makeFailure('UNKNOWN')];
    const r = detectNoProgress(failures, 3);
    expect(r.noProgress).toBe(false);
    expect(r.reason).toMatch('inconclusive');
  });

  it('RC-003: same input → same output (deterministic)', () => {
    const failures = [makeFailure('SYNTAX'), makeFailure('SYNTAX'), makeFailure('SYNTAX')];
    const r1 = detectNoProgress(failures, 3);
    const r2 = detectNoProgress(failures, 3);
    expect(r1.noProgress).toBe(r2.noProgress);
    expect(r1.repeatingClass).toBe(r2.repeatingClass);
  });

  it('TIMEOUT class detected as no-progress', () => {
    const failures = [makeFailure('TIMEOUT'), makeFailure('TIMEOUT'), makeFailure('TIMEOUT')];
    const r = detectNoProgress(failures, 3);
    expect(r.noProgress).toBe(true);
    expect(r.repeatingClass).toBe('TIMEOUT');
  });

  it('custom threshold respected', () => {
    const failures = [makeFailure('LOGIC'), makeFailure('LOGIC')];
    expect(detectNoProgress(failures, 2).noProgress).toBe(true);
    expect(detectNoProgress(failures, 3).noProgress).toBe(false);
  });

  it('returns consecutiveCount matching threshold when no-progress', () => {
    const failures = [makeFailure('SYNTAX'), makeFailure('SYNTAX'), makeFailure('SYNTAX'), makeFailure('SYNTAX')];
    const r = detectNoProgress(failures, 3);
    expect(r.consecutiveCount).toBe(3);
  });
});