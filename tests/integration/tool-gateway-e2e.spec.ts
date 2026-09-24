// P1.5-I2 — ToolGateway E2E (PHASE_1_5_ROADMAP §4.8).
//
// Full lifecycle: model proposes call → ToolGateway classifies risk →
// policy auto-approve READ_ONLY / require_approval MODIFY_WORKSPACE →
// ApprovalEngine approve/deny → execute via FakeProcessSupervisor →
// SUCCEEDED or DENIED.
//
// Verifies:
//   TG-001: no tool execution outside ToolGateway.
//   TG-005: DENIED never executes.
//   HI-001/002: approval binding forge-proof.
//   TG-010: timeout → TIMEOUT state.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  SqliteDatabaseAdapter,
  SqliteToolCallRepository,
  SqliteApprovalRepository,
  SqliteEventLog,
  runMigrations,
  createMigrationRegistry,
} from '@codeforge/infrastructure';
import {
  ToolGateway,
  ToolGatewayError,
  ApprovalEngine,
  ApprovalEngineError,
  PERMISSIVE_TEST_POLICY,
  DEFAULT_TOOL_POLICY,
  type HumanOverrideRepository,
} from '@codeforge/agent-core';
import type { ToolCall, HumanOverride, ToolExecutor, ExecutorResult } from '@codeforge/agent-core';
import { FakeProcessSupervisor } from '@codeforge/testing';

// ── helpers ───────────────────────────────────────────────────────────────────

function makeCounters(): { now: () => string; nextId: () => string } {
  let t = 0; let n = 0;
  return {
    now:    () => `2026-01-01T00:00:${String(t++).padStart(2, '0')}.000Z`,
    nextId: () => `ID-${String(n++).padStart(4, '0')}`,
  };
}

function toolCall(id: string, riskClass: ToolCall['riskClass'] = 'READ_ONLY'): ToolCall {
  return {
    toolCallId:    id,
    sessionId:     'S',
    toolName:      'read_file',
    toolVersion:   '1.0',
    riskClass,
    arguments:     { path: 'src/main.ts' },
    argumentsHash: `HASH-${id}`,
    state:         'REQUESTED',
    proposedBy:    'model',
    provenance:    { provenanceId: 'P', source: { kind: 'model', id: 'executor' },
                     inputs: [], reason: 'execute', at: '2026-01-01T00:00:00.000Z' },
    requestedAt:   '2026-01-01T00:00:00.000Z',
    toolCalls:     [],
    failures:      [],
  };
}

class InMemoryOverrideRepository implements HumanOverrideRepository {
  private readonly store = new Map<string, HumanOverride>();
  async create(o: HumanOverride): Promise<void> { this.store.set(o.overrideId, o); }
  async getByTask(taskId: string): Promise<HumanOverride | null> {
    for (const o of this.store.values()) if (o.taskId === taskId) return o;
    return null;
  }
  async getById(id: string): Promise<HumanOverride | null> { return this.store.get(id) ?? null; }
}

let db: SqliteDatabaseAdapter;
let callsRepo: SqliteToolCallRepository;
let approvalsRepo: SqliteApprovalRepository;
let events: SqliteEventLog;
let supervisor: FakeProcessSupervisor;
let gateway: ToolGateway;
let approvalEngine: ApprovalEngine;

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
  callsRepo    = new SqliteToolCallRepository(db);
  approvalsRepo = new SqliteApprovalRepository(db);
  events       = new SqliteEventLog(db);
  supervisor   = new FakeProcessSupervisor();
  const c = makeCounters();

  gateway = new ToolGateway({
    calls: callsRepo, approvals: approvalsRepo, events,
    policy: PERMISSIVE_TEST_POLICY, // allow READ_ONLY auto-approve
    now: c.now, nextId: c.nextId,
  });
  approvalEngine = new ApprovalEngine({
    approvals: approvalsRepo,
    overrides: new InMemoryOverrideRepository(),
    events,
    sessionId: 'S',
    now: c.now,
    nextId: c.nextId,
  });
});
afterEach(() => db.close());

// ─────────────────────────────────────────────────────────────────────────────
// Happy path: READ_ONLY auto-approve → execute → SUCCEEDED
// ─────────────────────────────────────────────────────────────────────────────

describe('P1.5-I2 ToolGateway E2E — auto-approve + execute', () => {
  it('READ_ONLY: request → auto-APPROVED → execute → SUCCEEDED (TG-001/005)', async () => {
    supervisor.setSequence([{ exitCode: 0, stdout: 'file content', stderr: '' }]);

    const requested = await gateway.request(toolCall('TC1'));
    expect(requested.state).toBe('APPROVED'); // PERMISSIVE_TEST_POLICY: READ_ONLY → allow

    const executor: ToolExecutor = {
      async execute(_call): Promise<ExecutorResult> {
        return supervisor.spawn({
          command: 'cat', args: ['src/main.ts'],
          cwd: '/r', env: {}, timeoutMs: 5000,
        });
      },
    };

    const finished = await gateway.execute('TC1', executor);
    expect(finished.state).toBe('SUCCEEDED');

    const types = (await events.query({ sessionId: 'S' })).map((e) => e.type);
    expect(types).toContain('TOOL_CALL_APPROVED');
    expect(types).toContain('TOOL_CALL_STARTED');
    expect(types).toContain('TOOL_CALL_ENDED');
  });

  it('TG-010: executor timeout → TIMEOUT state (not left RUNNING)', async () => {
    supervisor.setSequence([{ exitCode: null, timedOut: true }]);

    await gateway.request(toolCall('TC2'));
    const executor: ToolExecutor = {
      async execute(_call): Promise<ExecutorResult> {
        return supervisor.spawn({ command: 'slow', args: [], cwd: '/r', env: {}, timeoutMs: 100 });
      },
    };
    const finished = await gateway.execute('TC2', executor);
    expect(finished.state).toBe('TIMEOUT');
    // RUNNING is not the terminal state.
    const stored = await callsRepo.getById('TC2');
    expect(stored?.state).toBe('TIMEOUT');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// require_approval path → ApprovalEngine → execute or deny
// ─────────────────────────────────────────────────────────────────────────────

describe('P1.5-I2 ToolGateway E2E — approval path', () => {
  it('MODIFY_WORKSPACE → APPROVAL_PENDING → human approve → execute → SUCCEEDED', async () => {
    const gw = new ToolGateway({
      calls: callsRepo, approvals: approvalsRepo, events,
      policy: DEFAULT_TOOL_POLICY, // MODIFY_WORKSPACE → require_approval
      now: makeCounters().now, nextId: makeCounters().nextId,
    });

    const requested = await gw.request(toolCall('TC3', 'MODIFY_WORKSPACE'));
    expect(requested.state).toBe('APPROVAL_PENDING');

    // Human reviews and approves via ToolGateway.approve().
    const approved = await gw.approve('TC3', 'user');
    expect(approved.state).toBe('APPROVED');
    expect(approved.approval?.binding.argumentsHash).toBe('HASH-TC3');

    supervisor.setSequence([{ exitCode: 0 }]);
    const executor: ToolExecutor = {
      async execute(_call): Promise<ExecutorResult> {
        return supervisor.spawn({ command: 'tsc', args: [], cwd: '/r', env: {}, timeoutMs: 5000 });
      },
    };
    const finished = await gw.execute('TC3', executor);
    expect(finished.state).toBe('SUCCEEDED');
  });

  it('TG-005: DENIED call cannot be executed (NOT_APPROVED)', async () => {
    const gw = new ToolGateway({
      calls: callsRepo, approvals: approvalsRepo, events,
      policy: DEFAULT_TOOL_POLICY, // DESTRUCTIVE → deny
      now: makeCounters().now, nextId: makeCounters().nextId,
    });

    const requested = await gw.request(toolCall('TC4', 'DESTRUCTIVE'));
    expect(requested.state).toBe('DENIED');

    const err = await gw.execute('TC4', { execute: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }) })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ToolGatewayError);
    expect((err as ToolGatewayError).code).toBe('NOT_APPROVED');

    // Verify DENIED is terminal (TG-005).
    expect((await callsRepo.getById('TC4'))?.state).toBe('DENIED');
  });

  it('HI-002/TG-003: ApprovalEngine.verifyApproval rejects binding mismatch', async () => {
    await gateway.request(toolCall('TC5', 'MODIFY_WORKSPACE'));
    // Create an approval with the correct argumentsHash.
    await approvalEngine.createApproval({
      toolCallId:        'TC5',
      argumentsHash:     'HASH-TC5', // correct hash
      toolPolicyVersion: 1,
      decision:          'APPROVED',
      decidedBy:         'user',
    });

    // Verify with a DIFFERENT hash → binding mismatch.
    const err = await approvalEngine
      .verifyApproval('TC5', 'HASH-DIFFERENT')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApprovalEngineError);
    expect((err as ApprovalEngineError).code).toBe('BINDING_MISMATCH');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TG-001: no bypass — only ToolGateway executes
// ─────────────────────────────────────────────────────────────────────────────

describe('P1.5-I2 TG-001 no bypass', () => {
  it('execute() on non-existent call throws NOT_FOUND', async () => {
    const err = await gateway.execute('NOEXIST', {
      execute: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }),
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ToolGatewayError);
    expect((err as ToolGatewayError).code).toBe('NOT_FOUND');
  });

  it('execute() on APPROVAL_PENDING call throws NOT_APPROVED', async () => {
    const gw = new ToolGateway({
      calls: callsRepo, approvals: approvalsRepo, events,
      policy: DEFAULT_TOOL_POLICY, now: makeCounters().now, nextId: makeCounters().nextId,
    });
    await gw.request(toolCall('TC6', 'MODIFY_WORKSPACE'));
    // No approve() called — state is APPROVAL_PENDING.
    const err = await gw.execute('TC6', {
      execute: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }),
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ToolGatewayError);
    expect((err as ToolGatewayError).code).toBe('NOT_APPROVED');
  });
});
