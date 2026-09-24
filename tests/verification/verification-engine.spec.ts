// P1.5-VR1/VR2 — VerificationEngine + CompletionGate
// Covers: VR-001 (report bound to revision), VR-002 (stale evidence),
//         VR-004 (scope ≥ required), VR-006 (append-only), VR-007 (R_before before checks),
//         VR-008 (non-scratch drift → INVALID), VR-010 (deterministic scope),
//         TI-005 (VERIFYING→PASSED only with valid evidence).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  SqliteDatabaseAdapter,
  SqliteVerificationRepository,
  SqliteEventLog,
  runMigrations,
  createMigrationRegistry,
} from '@codeforge/infrastructure';
import {
  VerificationEngine,
  VerificationError,
  CompletionGate,
  CompletionGateError,
  computeScope,
  computeAffectedDirect,
  computeAffectedFromChanges,
  scopeIncludes,
  promoteScope,
  isFresh,
  isUsableForCompletion,
  isPassing,
  DEFAULT_VERIFICATION_POLICY,
  GRAPH_FINAL_VERIFICATION_POLICY,
  resolvePolicy,
  type VerificationPolicy,
  type VerifyRequest,
} from '@codeforge/agent-core';
import {
  FakeProcessSupervisor,
  FakeRevisionProvider,
} from '@codeforge/testing';
import type { WorkspaceRevision, VerificationReport } from '@codeforge/agent-core';

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

function request(over: Partial<VerifyRequest> = {}): VerifyRequest {
  return {
    sessionId: 'S',
    taskId:    'T1',
    taskRunId: 'R1',
    targetRevision: revision(),
    policy: DEFAULT_VERIFICATION_POLICY,
    reason: 'task_completion',
    ...over,
  };
}

let db: SqliteDatabaseAdapter;
let reports: SqliteVerificationRepository;
let events: SqliteEventLog;
let supervisor: FakeProcessSupervisor;
let revProvider: FakeRevisionProvider;
let engine: VerificationEngine;
let gate: CompletionGate;

beforeEach(() => {
  db = new SqliteDatabaseAdapter(':memory:');
  db.open();
  runMigrations(db, createMigrationRegistry(), { now: () => '2026-01-01T00:00:00.000Z' });
  db.execute(
    `INSERT INTO sessions
       (session_id, workspace_id, workspace_root, goal_id, graph_version, state,
        created_at, updated_at, runtime_version, schema_version, budget_id, lock_id, metadata_json)
     VALUES ('S','W','/r','G',1,'RUNNING','t','t','0.1.0',1,'B','L','{}')`,
  );
  db.execute(
    `INSERT INTO tasks
       (task_id, description, acceptance_json, constraints_json, priority,
        strategy_json, created_at, created_by, schema_version)
     VALUES ('T1','task','[]','[]',0,'{"kind":"generate"}','t','planner',1)`,
  );
  db.execute(
    `INSERT INTO task_runs
       (task_run_id, task_id, session_id, attempt_number, state, graph_version_at_start,
        workspace_revision_start_json, strategy_used_json, started_at,
        tool_calls_json, failures_json, budget_consumed_json, schema_version)
     VALUES ('R1','T1','S',1,'RUNNING',1,'{}','{"kind":"generate"}','t','[]','[]','{}',1)`,
  );

  reports    = new SqliteVerificationRepository(db);
  events     = new SqliteEventLog(db);
  supervisor = new FakeProcessSupervisor();
  revProvider = new FakeRevisionProvider(revision()); // R_after = same hash by default
  const c    = makeCounters();
  engine = new VerificationEngine({
    reports, events, supervisor, revisionProvider: revProvider,
    now: c.now, nextId: c.nextId,
  });
  gate = new CompletionGate({ reports });
});
afterEach(() => db.close());

// ─────────────────────────────────────────────────────────────────────────────
// Pure functions: scope, affected set, freshness
// ─────────────────────────────────────────────────────────────────────────────

describe('computeScope — VR-010 deterministic', () => {
  it('returns policy.minimumScope when no promotion triggers', () => {
    expect(computeScope({ policy: DEFAULT_VERIFICATION_POLICY, affectedClosureSize: 0, totalTestablePaths: 100 }))
      .toBe('AFFECTED_DIRECT');
  });
  it('promotes to AFFECTED_CLOSURE when isFinalGraph=true (VR-004)', () => {
    expect(computeScope({ policy: DEFAULT_VERIFICATION_POLICY, affectedClosureSize: 0, totalTestablePaths: 100, isFinalGraph: true }))
      .toBe('AFFECTED_CLOSURE');
  });
  it('promotes to FULL when affectedClosure fraction > threshold', () => {
    expect(computeScope({ policy: DEFAULT_VERIFICATION_POLICY, affectedClosureSize: 60, totalTestablePaths: 100 }))
      .toBe('FULL');
  });
  it('stays at minimum when fraction <= threshold', () => {
    expect(computeScope({ policy: DEFAULT_VERIFICATION_POLICY, affectedClosureSize: 49, totalTestablePaths: 100 }))
      .toBe('AFFECTED_DIRECT');
  });
  it('promoteScope never demotes', () => {
    expect(promoteScope('FULL', 'SMOKE')).toBe('FULL');
    expect(promoteScope('SMOKE', 'FULL')).toBe('FULL');
  });
  it('scopeIncludes respects lattice order', () => {
    expect(scopeIncludes('FULL', 'SMOKE')).toBe(true);
    expect(scopeIncludes('SMOKE', 'AFFECTED_DIRECT')).toBe(false);
    expect(scopeIncludes('AFFECTED_DIRECT', 'AFFECTED_DIRECT')).toBe(true);
  });
});

describe('computeAffectedDirect — diff-based', () => {
  it('detects added files', () => {
    const atStart = { includedPaths: ['src/a.ts'], excludedScratchPaths: [] };
    const atEnd   = { includedPaths: ['src/a.ts', 'src/b.ts'], excludedScratchPaths: [] };
    expect([...computeAffectedDirect(atStart, atEnd)]).toContain('src/b.ts');
  });
  it('detects deleted files', () => {
    const atStart = { includedPaths: ['src/a.ts', 'src/b.ts'], excludedScratchPaths: [] };
    const atEnd   = { includedPaths: ['src/a.ts'], excludedScratchPaths: [] };
    expect([...computeAffectedDirect(atStart, atEnd)]).toContain('src/b.ts');
  });
  it('excludes scratch paths', () => {
    const atStart = { includedPaths: [], excludedScratchPaths: ['tmp/'] };
    const atEnd   = { includedPaths: ['tmp/x.ts'], excludedScratchPaths: ['tmp/'] };
    expect([...computeAffectedDirect(atStart, atEnd)]).not.toContain('tmp/x.ts');
  });
  it('computeAffectedFromChanges filters scratch + agent-only', () => {
    const changes = [
      { relpath: 'src/a.ts', ownedBy: 'agent' as const, inScratchZone: false },
      { relpath: 'tmp/x.ts', ownedBy: 'agent' as const, inScratchZone: true },
      { relpath: 'src/b.ts', ownedBy: 'verification' as const, inScratchZone: false },
    ];
    const result = computeAffectedFromChanges(changes);
    expect([...result]).toEqual(['src/a.ts']);
  });
});

describe('isFresh / isUsableForCompletion / isPassing', () => {
  it('isFresh: same hash + canonicalFormVersion → true', () => {
    expect(isFresh(revision(), revision())).toBe(true);
  });
  it('isFresh: different hash → false (VR-011)', () => {
    expect(isFresh(revision('A'), revision('B'))).toBe(false);
  });
  it('isUsableForCompletion: PASS + fresh → true', () => {
    const r = { targetWorkspaceRevision: revision(), status: 'PASS' as const };
    expect(isUsableForCompletion(r, revision())).toBe(true);
  });
  it('isUsableForCompletion: INVALID + fresh → false', () => {
    const r = { targetWorkspaceRevision: revision(), status: 'INVALID' as const };
    expect(isUsableForCompletion(r, revision())).toBe(false);
  });
  it('isPassing: PASS + fresh → true (TI-005 gate)', () => {
    const r = { targetWorkspaceRevision: revision(), status: 'PASS' as const };
    expect(isPassing(r, revision())).toBe(true);
  });
  it('isPassing: PASS + stale → false (VR-002)', () => {
    const r = { targetWorkspaceRevision: revision('OLD'), status: 'PASS' as const };
    expect(isPassing(r, revision('NEW'))).toBe(false);
  });
});

describe('resolvePolicy', () => {
  it('returns base when no override', () => {
    expect(resolvePolicy(DEFAULT_VERIFICATION_POLICY).policyId).toBe('default-task-v1');
  });
  it('uses override when supplied', () => {
    const custom: VerificationPolicy = { ...DEFAULT_VERIFICATION_POLICY, policyId: 'custom' };
    expect(resolvePolicy(DEFAULT_VERIFICATION_POLICY, { override: custom }).policyId).toBe('custom');
  });
  it('promotes to AFFECTED_CLOSURE for final graph (VR-004)', () => {
    const result = resolvePolicy(DEFAULT_VERIFICATION_POLICY, { isFinalGraph: true });
    expect(result.requiredScope).toBe('AFFECTED_CLOSURE');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// VerificationEngine.verify — pipeline (VR-001/006/007/008/010)
// ─────────────────────────────────────────────────────────────────────────────

describe('VerificationEngine.verify — pipeline', () => {
  it('produces a PASS report when all checks pass (VR-001: bound to revision)', async () => {
    const policy: VerificationPolicy = {
      ...DEFAULT_VERIFICATION_POLICY,
      checks: [
        { name: 'typecheck', kind: 'typecheck', command: 'tsc', args: ['--noEmit'],
          minScope: 'AFFECTED_DIRECT', timeoutMs: 5000 },
      ],
    };
    supervisor.setSequence([{ exitCode: 0, stdout: '', stderr: '' }]);

    const report = await engine.verify(request({ policy }));

    expect(report.status).toBe('PASS');
    expect(report.taskId).toBe('T1');
    // VR-001: report is bound to the supplied revision.
    expect(report.targetWorkspaceRevision.revisionId).toBe('rev-1');
    // VR-006: persisted (append-only).
    expect(await reports.getById(report.verificationId)).not.toBeNull();
    // Events emitted.
    const types = (await events.query({ sessionId: 'S' })).map((e) => e.type);
    expect(types).toContain('VERIFICATION_STARTED');
    expect(types).toContain('VERIFICATION_ENDED');
  });

  it('produces FAIL when a check exits non-zero', async () => {
    const policy: VerificationPolicy = {
      ...DEFAULT_VERIFICATION_POLICY,
      checks: [
        { name: 'test', kind: 'test', command: 'vitest', args: ['run'],
          minScope: 'AFFECTED_DIRECT', timeoutMs: 5000 },
      ],
    };
    supervisor.setSequence([{ exitCode: 1, stdout: '', stderr: 'test failed' }]);

    const report = await engine.verify(request({ policy }));
    expect(report.status).toBe('FAIL');
    expect(report.checks[0]?.status).toBe('FAIL');
  });

  it('VR-008: non-scratch workspace drift → INVALID', async () => {
    // R_after has a different hash (workspace mutated during verification).
    revProvider.setCurrent(revision('HASH-DRIFTED', 'rev-2'));

    const report = await engine.verify(request());
    expect(report.status).toBe('INVALID');
  });

  it('VR-010: no checks → status based on drift only (PASS when no drift, no checks)', async () => {
    // Policy with no checks — R_after same as R_before → PASS.
    const report = await engine.verify(request({ policy: DEFAULT_VERIFICATION_POLICY }));
    expect(report.status).toBe('PASS'); // no checks, no drift → PASS
  });

  it('skips checks below the computed scope', async () => {
    const policy: VerificationPolicy = {
      ...DEFAULT_VERIFICATION_POLICY,
      minimumScope: 'SMOKE',
      requiredScope: 'SMOKE',
      checks: [
        { name: 'full-suite', kind: 'test', command: 'vitest', args: [],
          minScope: 'FULL', timeoutMs: 5000 }, // won't run at SMOKE scope
      ],
    };
    supervisor.setSequence([{ exitCode: 0 }]);

    const report = await engine.verify(request({ policy }));
    expect(report.checks[0]?.status).toBe('SKIP');
    expect(report.status).toBe('PASS');
  });

  it('stores toolVersions from policy (VR-009)', async () => {
    const policy: VerificationPolicy = {
      ...DEFAULT_VERIFICATION_POLICY,
      toolVersions: { tsc: '5.4.0', vitest: '2.1.9' },
    };
    const report = await engine.verify(request({ policy }));
    expect(report.toolVersions['tsc']).toBe('5.4.0');
  });

  it('fail-fast stops after first failing check', async () => {
    const policy: VerificationPolicy = {
      ...DEFAULT_VERIFICATION_POLICY,
      failFast: true,
      checks: [
        { name: 'check-1', kind: 'typecheck', command: 'tsc', args: [],
          minScope: 'AFFECTED_DIRECT', timeoutMs: 5000 },
        { name: 'check-2', kind: 'test', command: 'vitest', args: [],
          minScope: 'AFFECTED_DIRECT', timeoutMs: 5000 },
      ],
    };
    supervisor.setSequence([{ exitCode: 1 }]); // first check fails, second never runs

    const report = await engine.verify(request({ policy }));
    expect(report.status).toBe('FAIL');
    // Only 1 check ran (fail-fast).
    const ranChecks = report.checks.filter((c) => c.status !== 'SKIP');
    expect(ranChecks).toHaveLength(1);
  });

  it('GRAPH_FINAL_VERIFICATION_POLICY enforces AFFECTED_CLOSURE scope (VR-004)', async () => {
    const report = await engine.verify(
      request({ policy: GRAPH_FINAL_VERIFICATION_POLICY, reason: 'graph_final' }),
    );
    expect(['AFFECTED_CLOSURE', 'FULL']).toContain(report.scope);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CompletionGate.canComplete — TI-005 + VR-002/004
// ─────────────────────────────────────────────────────────────────────────────

describe('CompletionGate.canComplete — TI-005', () => {
  it('TI-005: no report → canComplete=false with NO_VERIFICATION_REPORT', async () => {
    const result = await gate.canComplete('T1', revision());
    expect(result.canComplete).toBe(false);
    expect(result.reason).toBe('NO_VERIFICATION_REPORT');
  });

  it('returns canComplete=true with a PASS fresh report', async () => {
    supervisor.setSequence([{ exitCode: 0 }]);
    const policy: VerificationPolicy = {
      ...DEFAULT_VERIFICATION_POLICY,
      checks: [{ name: 'test', kind: 'test', command: 'v', args: [],
                 minScope: 'AFFECTED_DIRECT', timeoutMs: 1000 }],
    };
    await engine.verify(request({ policy }));

    const result = await gate.canComplete('T1', revision());
    expect(result.canComplete).toBe(true);
    expect(result.report?.status).toBe('PASS');
  });

  it('VR-002: stale evidence → STALE_EVIDENCE (revision changed since report)', async () => {
    supervisor.setSequence([{ exitCode: 0 }]);
    const policy: VerificationPolicy = {
      ...DEFAULT_VERIFICATION_POLICY,
      checks: [{ name: 't', kind: 'test', command: 'v', args: [],
                 minScope: 'AFFECTED_DIRECT', timeoutMs: 1000 }],
    };
    await engine.verify(request({ policy })); // report bound to HASH-1

    // Workspace revision changed after the report was made.
    const result = await gate.canComplete('T1', revision('HASH-CHANGED'));
    expect(result.canComplete).toBe(false);
    expect(result.reason).toBe('STALE_EVIDENCE');
  });

  it('FAIL report → VERIFICATION_NOT_PASSED', async () => {
    supervisor.setSequence([{ exitCode: 1 }]);
    const policy: VerificationPolicy = {
      ...DEFAULT_VERIFICATION_POLICY,
      checks: [{ name: 't', kind: 'test', command: 'v', args: [],
                 minScope: 'AFFECTED_DIRECT', timeoutMs: 1000 }],
    };
    await engine.verify(request({ policy }));

    const result = await gate.canComplete('T1', revision());
    expect(result.canComplete).toBe(false);
    expect(result.reason).toBe('VERIFICATION_NOT_PASSED');
  });

  it('VR-004: scope below required → SCOPE_INSUFFICIENT', async () => {
    // Engine produces SMOKE-scope PASS, gate requires AFFECTED_CLOSURE.
    supervisor.setSequence([{ exitCode: 0 }]);
    const policy: VerificationPolicy = {
      ...DEFAULT_VERIFICATION_POLICY,
      minimumScope: 'SMOKE',
      requiredScope: 'SMOKE',
      checks: [{ name: 't', kind: 'test', command: 'v', args: [],
                 minScope: 'SMOKE', timeoutMs: 1000 }],
    };
    await engine.verify(request({ policy }));

    const result = await gate.canComplete('T1', revision(), 'AFFECTED_CLOSURE');
    expect(result.canComplete).toBe(false);
    expect(result.reason).toBe('SCOPE_INSUFFICIENT');
  });

  it('adversarial guard: PASS report with 0 checks → NO_CHECKS_EXECUTED', async () => {
    // Directly insert a fake PASS report with 0 checks (MaliciousVerifier scenario).
    const fakeReport: VerificationReport = {
      verificationId: 'VR-FAKE',
      sessionId: 'S',
      taskId: 'T1',
      taskRunId: 'R1',
      targetWorkspaceRevision: revision(),
      canonicalFormVersion: 'v1',
      scope: 'AFFECTED_DIRECT',
      checks: [], // adversarial: no checks
      status: 'PASS',
      startedAt: '2026-01-01T00:00:00.000Z',
      endedAt: '2026-01-01T00:00:01.000Z',
      toolVersions: {},
      artifacts: [],
      invariantsChecked: [],
      schemaVersion: 1,
    };
    await reports.create(fakeReport);

    const result = await gate.canComplete('T1', revision());
    expect(result.canComplete).toBe(false);
    expect(result.reason).toBe('NO_CHECKS_EXECUTED');
  });

  it('assertCanComplete throws CompletionGateError on failure (TI-005)', async () => {
    const err = await gate.assertCanComplete('T1', revision()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CompletionGateError);
    expect((err as CompletionGateError).code).toBe('NO_VERIFICATION_REPORT');
  });

  it('assertCanComplete returns report on success', async () => {
    supervisor.setSequence([{ exitCode: 0 }]);
    const policy: VerificationPolicy = {
      ...DEFAULT_VERIFICATION_POLICY,
      checks: [{ name: 't', kind: 'test', command: 'v', args: [],
                 minScope: 'AFFECTED_DIRECT', timeoutMs: 1000 }],
    };
    await engine.verify(request({ policy }));

    const report = await gate.assertCanComplete('T1', revision());
    expect(report.status).toBe('PASS');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// VerificationError exported
// ─────────────────────────────────────────────────────────────────────────────
describe('VerificationError is exported', () => {
  it('can be constructed with a code', () => {
    const e = new VerificationError('NOT_FOUND', 'test');
    expect(e.code).toBe('NOT_FOUND');
    expect(e).toBeInstanceOf(VerificationError);
  });
});
