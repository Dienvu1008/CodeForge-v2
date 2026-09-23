// P1.5-TG2 — ApprovalEngine + HumanOverride
// Covers: HI-001/TG-003 (binding), HI-002/TG-004 (forge-proof), HI-003 (override
//         marker explicit), HI-004 (override does not mutate VerificationReport).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  SqliteDatabaseAdapter,
  SqliteEventLog,
  SqliteApprovalRepository,
  runMigrations,
  createMigrationRegistry,
} from '@codeforge/infrastructure';
import {
  ApprovalEngine,
  ApprovalEngineError,
  type HumanOverrideRepository,
  type ApprovalRequest,
  type OverrideRequest,
} from '@codeforge/agent-core';
import type { HumanOverride } from '@codeforge/agent-core';

// ── In-memory HumanOverrideRepository (no SQLite impl yet) ───────────────────

class InMemoryOverrideRepository implements HumanOverrideRepository {
  private readonly store = new Map<string, HumanOverride>();

  async create(override: HumanOverride): Promise<void> {
    this.store.set(override.overrideId, override);
  }
  async getByTask(taskId: string): Promise<HumanOverride | null> {
    for (const o of this.store.values()) {
      if (o.taskId === taskId) return o;
    }
    return null;
  }
  async getById(overrideId: string): Promise<HumanOverride | null> {
    return this.store.get(overrideId) ?? null;
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────

function makeCounters(): { now: () => string; nextId: () => string } {
  let t = 0; let n = 0;
  return {
    now:    () => `2026-01-01T00:00:${String(t++).padStart(2, '0')}.000Z`,
    nextId: () => `ID-${String(n++).padStart(4, '0')}`,
  };
}

function approvalReq(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    toolCallId:        'TC1',
    argumentsHash:     'HASH-ARGS',
    toolPolicyVersion: 1,
    decision:          'APPROVED',
    decidedBy:         'user',
    ...overrides,
  };
}

let db: SqliteDatabaseAdapter;
let approvals: SqliteApprovalRepository;
let overrides: InMemoryOverrideRepository;
let events: SqliteEventLog;
let engine: ApprovalEngine;

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
  // Seed tool_call row so FK on approvals table is satisfied.
  db.execute(
    `INSERT INTO tool_calls
       (tool_call_id, session_id, tool_name, tool_version, risk_class,
        arguments_json, arguments_hash, state, proposed_by, provenance_json,
        requested_at, schema_version)
     VALUES ('TC1','S','read_file','1.0','READ_ONLY','{}','HASH-ARGS',
             'REQUESTED','model','{}','2026-01-01T00:00:00.000Z',1)`,
  );

  approvals = new SqliteApprovalRepository(db);
  overrides = new InMemoryOverrideRepository();
  events    = new SqliteEventLog(db);
  const c   = makeCounters();
  engine    = new ApprovalEngine({
    approvals, overrides, events,
    sessionId: 'S',
    now: c.now,
    nextId: c.nextId,
  });
});
afterEach(() => db.close());

// ─────────────────────────────────────────────────────────────────────────────
// createApproval — HI-001 / TG-003 (binding) + HI-002 / TG-004 (forge-proof)
// ─────────────────────────────────────────────────────────────────────────────

describe('ApprovalEngine.createApproval — HI-001/TG-003: binding', () => {
  it('persists approval with the exact binding triple (toolCallId, argumentsHash, policyVersion)', async () => {
    const approval = await engine.createApproval(approvalReq());
    expect(approval.binding.argumentsHash).toBe('HASH-ARGS');
    expect(approval.binding.toolPolicyVersion).toBe(1);
    expect(approval.toolCallId).toBe('TC1');

    // Approval is retrievable by toolCallId.
    const stored = await approvals.getByToolCall('TC1');
    expect(stored?.approvalId).toBe(approval.approvalId);
    expect(stored?.decision).toBe('APPROVED');
  });

  it('emits HUMAN_APPROVAL_GRANTED for APPROVED decision', async () => {
    await engine.createApproval(approvalReq({ decision: 'APPROVED' }));
    const evts = await events.query({ sessionId: 'S' });
    expect(evts.map((e) => e.type)).toContain('HUMAN_APPROVAL_GRANTED');
  });

  it('emits HUMAN_APPROVAL_DENIED for DENIED decision', async () => {
    await engine.createApproval(approvalReq({ decision: 'DENIED', decidedBy: 'user' }));
    const evts = await events.query({ sessionId: 'S' });
    expect(evts.map((e) => e.type)).toContain('HUMAN_APPROVAL_DENIED');
  });

  it('stores optional reason and expiresAt', async () => {
    const approval = await engine.createApproval(
      approvalReq({ reason: 'reviewed', expiresAt: '2026-12-31T23:59:59.000Z' }),
    );
    expect(approval.reason).toBe('reviewed');
    expect(approval.expiresAt).toBe('2026-12-31T23:59:59.000Z');
  });

  it('HI-002 / TG-004: only createApproval creates records — no record without it', async () => {
    // Before calling createApproval, no approval exists (model output cannot create one).
    expect(await approvals.getByToolCall('TC1')).toBeNull();
    await engine.createApproval(approvalReq());
    expect(await approvals.getByToolCall('TC1')).not.toBeNull();
  });

  it('idempotency: second createApproval for same toolCall throws ALREADY_DECIDED', async () => {
    await engine.createApproval(approvalReq());
    const err = await engine.createApproval(approvalReq()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApprovalEngineError);
    expect((err as ApprovalEngineError).code).toBe('ALREADY_DECIDED');
  });

  it('rejects invalid decision value with INVALID_DECISION', async () => {
    const err = await engine
      .createApproval(approvalReq({ decision: 'MAYBE' as 'APPROVED' }))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApprovalEngineError);
    expect((err as ApprovalEngineError).code).toBe('INVALID_DECISION');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// verifyApproval — HI-002 / TG-003 (binding mismatch) + expiry
// ─────────────────────────────────────────────────────────────────────────────

describe('ApprovalEngine.verifyApproval — HI-002/TG-003: binding + expiry', () => {
  it('returns approval when binding matches and not expired', async () => {
    await engine.createApproval(approvalReq());
    const result = await engine.verifyApproval('TC1', 'HASH-ARGS');
    expect(result.toolCallId).toBe('TC1');
    expect(result.decision).toBe('APPROVED');
  });

  it('HI-002 / TG-003: throws BINDING_MISMATCH when argumentsHash differs', async () => {
    await engine.createApproval(approvalReq());
    const err = await engine.verifyApproval('TC1', 'DIFFERENT-HASH').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApprovalEngineError);
    expect((err as ApprovalEngineError).code).toBe('BINDING_MISMATCH');
    // Error message is informative enough for forensics.
    expect((err as ApprovalEngineError).message).toContain('HASH-ARGS');
    expect((err as ApprovalEngineError).message).toContain('DIFFERENT-HASH');
  });

  it('throws NOT_FOUND when no approval exists', async () => {
    const err = await engine.verifyApproval('TC1', 'HASH-ARGS').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApprovalEngineError);
    expect((err as ApprovalEngineError).code).toBe('NOT_FOUND');
  });

  it('throws APPROVAL_EXPIRED when expiresAt is in the past', async () => {
    // expiresAt in the past relative to the deterministic clock (starts at 00:00:00).
    await engine.createApproval(
      approvalReq({ expiresAt: '2025-01-01T00:00:00.000Z' }), // well before 2026
    );
    const err = await engine.verifyApproval('TC1', 'HASH-ARGS').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApprovalEngineError);
    expect((err as ApprovalEngineError).code).toBe('APPROVAL_EXPIRED');
  });

  it('does NOT expire when expiresAt is in the future', async () => {
    await engine.createApproval(
      approvalReq({ expiresAt: '2027-12-31T00:00:00.000Z' }),
    );
    const result = await engine.verifyApproval('TC1', 'HASH-ARGS');
    expect(result.decision).toBe('APPROVED');
  });

  it('does NOT expire when expiresAt is absent', async () => {
    await engine.createApproval(approvalReq()); // no expiresAt
    const result = await engine.verifyApproval('TC1', 'HASH-ARGS');
    expect(result.decision).toBe('APPROVED');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// recordOverride — HI-003 (explicit marker) + HI-004 (report untouched)
// ─────────────────────────────────────────────────────────────────────────────

describe('ApprovalEngine.recordOverride — HI-003/004: human override', () => {
  const overrideReq: OverrideRequest = {
    taskId:         'T1',
    verificationId: 'VR1',
    reason:         'manual review passed',
    decidedBy:      'user',
  };

  it('HI-003: creates a HUMAN_OVERRIDE_COMPLETED record with explicit kind tag', async () => {
    const result = await engine.recordOverride(overrideReq);
    expect(result.kind).toBe('HUMAN_OVERRIDE_COMPLETED');
    expect(result.taskId).toBe('T1');
    expect(result.verificationId).toBe('VR1'); // reference only — HI-004
    expect(result.reason).toBe('manual review passed');
    expect(result.decidedBy).toBe('user');
  });

  it('HI-003: emits HUMAN_OVERRIDE_COMPLETED event (explicit marker)', async () => {
    await engine.recordOverride(overrideReq);
    const evts = await events.query({ sessionId: 'S' });
    expect(evts.map((e) => e.type)).toContain('HUMAN_OVERRIDE_COMPLETED');
  });

  it('HI-004: recordOverride stores a reference, not the report itself', async () => {
    const result = await engine.recordOverride(overrideReq);
    // The override record holds the verificationId string (reference), not the
    // VerificationReport object. This is the structural proof that HI-004 holds.
    expect(typeof result.verificationId).toBe('string');
    expect(result.verificationId).toBe('VR1');
    // There is NO verificationReport or report field on the HumanOverride type.
    expect('verificationReport' in result).toBe(false);
  });

  it('override is retrievable by taskId', async () => {
    await engine.recordOverride(overrideReq);
    const stored = await overrides.getByTask('T1');
    expect(stored?.kind).toBe('HUMAN_OVERRIDE_COMPLETED');
    expect(stored?.verificationId).toBe('VR1');
  });

  it('idempotency: second override for same task throws OVERRIDE_EXISTS', async () => {
    await engine.recordOverride(overrideReq);
    const err = await engine.recordOverride(overrideReq).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApprovalEngineError);
    expect((err as ApprovalEngineError).code).toBe('OVERRIDE_EXISTS');
  });

  it('different tasks can each have one override', async () => {
    await engine.recordOverride(overrideReq);
    const second = await engine.recordOverride({ ...overrideReq, taskId: 'T2' });
    expect(second.taskId).toBe('T2');
    // Each task's override is independent.
    expect(await overrides.getByTask('T1')).not.toBeNull();
    expect(await overrides.getByTask('T2')).not.toBeNull();
  });
});
