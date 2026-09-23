// P1.5-TG1 — ToolGateway + ToolPolicy + ToolCallStateMachine
// Covers: TG-001 (no bypass), TG-002 (lifecycle FSM), TG-003/004 (approval binding),
//         TG-005 (DENIED never executes), TG-007/SE-009 (DESTRUCTIVE/PRIVILEGED policy),
//         TG-009 (schema validation), TG-010 (timeout→TIMEOUT state).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  SqliteDatabaseAdapter,
  SqliteEventLog,
  SqliteToolCallRepository,
  SqliteApprovalRepository,
  runMigrations,
  createMigrationRegistry,
} from '@codeforge/infrastructure';
import {
  ToolGateway,
  ToolGatewayError,
  transitionToolCall,
  isToolCallTerminal,
  determineAction,
  DEFAULT_TOOL_POLICY,
  PERMISSIVE_TEST_POLICY,
  PolicyError,
} from '@codeforge/agent-core';
import type {
  ToolCall,
  Approval,
  ToolExecutor,
  ExecutorResult,
  ToolPolicy,
  OutputSchema,
} from '@codeforge/agent-core';

// ── helpers ───────────────────────────────────────────────────────────────────

function makeCounters(): { now: () => string; nextId: () => string } {
  let t = 0; let n = 0;
  return {
    now:    () => `2026-01-01T00:00:${String(t++).padStart(2, '0')}.000Z`,
    nextId: () => `ID-${String(n++).padStart(4, '0')}`,
  };
}

function call(overrides: Partial<ToolCall> = {}): ToolCall {
  return {
    toolCallId:    'TC1',
    sessionId:     'S',
    toolName:      'read_file',
    toolVersion:   '1.0',
    riskClass:     'READ_ONLY',
    arguments:     { path: 'src/main.ts' },
    argumentsHash: 'HASH-ARGS',
    state:         'REQUESTED',
    proposedBy:    'model',
    provenance:    { provenanceId: 'P', source: { kind: 'model', id: 'executor' }, inputs: [], reason: 'execute', at: '2026-01-01T00:00:00.000Z' },
    requestedAt:   '2026-01-01T00:00:00.000Z',
    toolCalls:     [],
    failures:      [],
    ...overrides,
  };
}

const SUCCESS_EXECUTOR: ToolExecutor = {
  async execute(_call): Promise<ExecutorResult> {
    return { exitCode: 0, stdout: 'ok', stderr: '', timedOut: false };
  },
};
const FAIL_EXECUTOR: ToolExecutor = {
  async execute(_call): Promise<ExecutorResult> {
    return { exitCode: 1, stdout: '', stderr: 'err', timedOut: false };
  },
};
const TIMEOUT_EXECUTOR: ToolExecutor = {
  async execute(_call): Promise<ExecutorResult> {
    return { exitCode: null, stdout: '', stderr: '', timedOut: true };
  },
};

let db: SqliteDatabaseAdapter;
let calls: SqliteToolCallRepository;
let approvals: SqliteApprovalRepository;
let events: SqliteEventLog;

function makeGateway(policy?: ToolPolicy, schemas?: Record<string, OutputSchema>): ToolGateway {
  const c = makeCounters();
  return new ToolGateway({ calls, approvals, events, policy, schemas, now: c.now, nextId: c.nextId });
}

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
  calls    = new SqliteToolCallRepository(db);
  approvals = new SqliteApprovalRepository(db);
  events   = new SqliteEventLog(db);
});
afterEach(() => db.close());

// ─────────────────────────────────────────────────────────────────────────────
// ToolCallStateMachine (TG-002)
// ─────────────────────────────────────────────────────────────────────────────

describe('transitionToolCall — TG-002: lifecycle FSM', () => {
  it('REQUESTED → APPROVED via AUTO_APPROVED', () => {
    expect(transitionToolCall('REQUESTED', 'AUTO_APPROVED')).toMatchObject({ ok: true, next: 'APPROVED' });
  });
  it('REQUESTED → APPROVAL_PENDING via SCHEMA_VALID', () => {
    expect(transitionToolCall('REQUESTED', 'SCHEMA_VALID')).toMatchObject({ ok: true, next: 'APPROVAL_PENDING' });
  });
  it('REQUESTED → DENIED via DENIED_BY_POLICY', () => {
    expect(transitionToolCall('REQUESTED', 'DENIED_BY_POLICY')).toMatchObject({ ok: true, next: 'DENIED' });
  });
  it('APPROVAL_PENDING → APPROVED via HUMAN_APPROVED', () => {
    expect(transitionToolCall('APPROVAL_PENDING', 'HUMAN_APPROVED')).toMatchObject({ ok: true, next: 'APPROVED' });
  });
  it('APPROVAL_PENDING → DENIED via HUMAN_DENIED', () => {
    expect(transitionToolCall('APPROVAL_PENDING', 'HUMAN_DENIED')).toMatchObject({ ok: true, next: 'DENIED' });
  });
  it('APPROVAL_PENDING → DENIED via APPROVAL_EXPIRED', () => {
    expect(transitionToolCall('APPROVAL_PENDING', 'APPROVAL_EXPIRED')).toMatchObject({ ok: true, next: 'DENIED' });
  });
  it('APPROVED → RUNNING via EXECUTION_STARTED', () => {
    expect(transitionToolCall('APPROVED', 'EXECUTION_STARTED')).toMatchObject({ ok: true, next: 'RUNNING' });
  });
  it('RUNNING → SUCCEEDED / FAILED / TIMEOUT', () => {
    expect(transitionToolCall('RUNNING', 'EXECUTION_SUCCEEDED')).toMatchObject({ ok: true, next: 'SUCCEEDED' });
    expect(transitionToolCall('RUNNING', 'EXECUTION_FAILED')).toMatchObject({ ok: true, next: 'FAILED' });
    expect(transitionToolCall('RUNNING', 'EXECUTION_TIMEOUT')).toMatchObject({ ok: true, next: 'TIMEOUT' });
  });
  it('CANCELLED from any non-terminal state', () => {
    for (const s of ['REQUESTED', 'APPROVAL_PENDING', 'APPROVED', 'RUNNING'] as const) {
      expect(transitionToolCall(s, 'CANCELLED')).toMatchObject({ ok: true, next: 'CANCELLED' });
    }
  });
  it('terminal states are absorbing (SM-003)', () => {
    for (const s of ['DENIED', 'SUCCEEDED', 'FAILED', 'TIMEOUT', 'CANCELLED'] as const) {
      expect(transitionToolCall(s, 'EXECUTION_SUCCEEDED')).toMatchObject({ ok: false, code: 'TERMINAL_STATE' });
      expect(isToolCallTerminal(s)).toBe(true);
    }
    expect(isToolCallTerminal('RUNNING')).toBe(false);
  });
  it('TG-005: DENIED → cannot transition to RUNNING', () => {
    expect(transitionToolCall('DENIED', 'EXECUTION_STARTED')).toMatchObject({ ok: false, code: 'TERMINAL_STATE' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ToolPolicy / determineAction (TG-007 / SE-009)
// ─────────────────────────────────────────────────────────────────────────────

describe('determineAction — TG-007/SE-009: DESTRUCTIVE/PRIVILEGED never auto', () => {
  it('READ_ONLY → allow (default policy)', () => {
    expect(determineAction('read_file', 'READ_ONLY', DEFAULT_TOOL_POLICY)).toBe('allow');
  });
  it('LOW_RISK → allow', () => {
    expect(determineAction('write_scratch', 'LOW_RISK', DEFAULT_TOOL_POLICY)).toBe('allow');
  });
  it('MODIFY_WORKSPACE → require_approval', () => {
    expect(determineAction('write_file', 'MODIFY_WORKSPACE', DEFAULT_TOOL_POLICY)).toBe('require_approval');
  });
  it('DESTRUCTIVE → deny (TG-007)', () => {
    expect(determineAction('rm', 'DESTRUCTIVE', DEFAULT_TOOL_POLICY)).toBe('deny');
  });
  it('PRIVILEGED → deny always, even with permissive policy (SE-009 hard override)', () => {
    expect(determineAction('sudo', 'PRIVILEGED', PERMISSIVE_TEST_POLICY)).toBe('deny');
    expect(determineAction('sudo', 'PRIVILEGED', DEFAULT_TOOL_POLICY)).toBe('deny');
  });
  it('DESTRUCTIVE cannot be allow even if a rule says allow (TG-007 coercion)', () => {
    const broken: ToolPolicy = {
      ...DEFAULT_TOOL_POLICY,
      rules: [{ toolName: '*', riskClass: 'DESTRUCTIVE', action: 'allow' }],
      defaultAction: 'allow',
    };
    expect(determineAction('rm', 'DESTRUCTIVE', broken)).toBe('require_approval');
  });
  it('PERMISSIVE_TEST_POLICY: READ_ONLY/MODIFY_WORKSPACE → allow', () => {
    expect(determineAction('read_file', 'READ_ONLY', PERMISSIVE_TEST_POLICY)).toBe('allow');
    expect(determineAction('write_file', 'MODIFY_WORKSPACE', PERMISSIVE_TEST_POLICY)).toBe('allow');
  });
  it('PolicyError is exported', () => {
    expect(PolicyError).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ToolGateway.request — TG-001 / TG-007 / TG-009
// ─────────────────────────────────────────────────────────────────────────────

describe('ToolGateway.request — policy + events', () => {
  it('READ_ONLY auto-approves (allow path)', async () => {
    const gw = makeGateway();
    const result = await gw.request(call());
    expect(result.state).toBe('APPROVED');
    const evts = await events.query({ sessionId: 'S' });
    expect(evts.map((e) => e.type)).toContain('TOOL_CALL_APPROVED');
  });

  it('MODIFY_WORKSPACE requires approval', async () => {
    const gw = makeGateway();
    const result = await gw.request(call({ riskClass: 'MODIFY_WORKSPACE', toolCallId: 'TC2' }));
    expect(result.state).toBe('APPROVAL_PENDING');
    const evts = await events.query({ sessionId: 'S' });
    expect(evts.map((e) => e.type)).toContain('TOOL_CALL_REQUESTED');
  });

  it('DESTRUCTIVE is denied immediately (TG-007)', async () => {
    const gw = makeGateway();
    const result = await gw.request(call({ riskClass: 'DESTRUCTIVE', toolCallId: 'TC3' }));
    expect(result.state).toBe('DENIED');
    const evts = await events.query({ sessionId: 'S' });
    expect(evts.map((e) => e.type)).toContain('TOOL_CALL_DENIED');
  });

  it('PRIVILEGED is denied immediately (SE-009)', async () => {
    const gw = makeGateway();
    const result = await gw.request(call({ riskClass: 'PRIVILEGED', toolCallId: 'TC4' }));
    expect(result.state).toBe('DENIED');
  });

  it('TG-009: schema validation failure throws SCHEMA_VALIDATION_FAILED', async () => {
    const schema: OutputSchema = {
      path: { type: 'string', required: true },
    };
    const gw = makeGateway(undefined, { read_file: schema });
    // Missing required 'path' field.
    const err = await gw.request(call({ arguments: { other: 'x' } })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ToolGatewayError);
    expect((err as ToolGatewayError).code).toBe('SCHEMA_VALIDATION_FAILED');
  });

  it('TG-009: valid schema passes through', async () => {
    const schema: OutputSchema = {
      path: { type: 'string', required: true },
    };
    const gw = makeGateway(undefined, { read_file: schema });
    const result = await gw.request(call({ arguments: { path: 'src/a.ts' } }));
    expect(result.state).toBe('APPROVED');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ToolGateway.approve / deny — TG-003 / TG-004
// ─────────────────────────────────────────────────────────────────────────────

describe('ToolGateway.approve / deny — TG-003/004: approval binding', () => {
  it('approve() transitions APPROVAL_PENDING → APPROVED and creates bound approval (TG-003)', async () => {
    const gw = makeGateway();
    const initial = await gw.request(call({ riskClass: 'MODIFY_WORKSPACE', toolCallId: 'TC5' }));
    expect(initial.state).toBe('APPROVAL_PENDING');

    const approved = await gw.approve('TC5', 'user');
    expect(approved.state).toBe('APPROVED');
    expect(approved.approval?.binding.argumentsHash).toBe('HASH-ARGS');
    expect(approved.approval?.decision).toBe('APPROVED');

    // Approval record persisted with binding.
    const storedApproval = await approvals.getByToolCall('TC5');
    expect(storedApproval?.binding.argumentsHash).toBe('HASH-ARGS');
    expect(storedApproval?.decidedBy).toBe('user');
  });

  it('deny() transitions APPROVAL_PENDING → DENIED (TG-005: terminal, no execute)', async () => {
    const gw = makeGateway();
    await gw.request(call({ riskClass: 'MODIFY_WORKSPACE', toolCallId: 'TC6' }));
    const denied = await gw.deny('TC6', 'user', 'too risky');
    expect(denied.state).toBe('DENIED');
    expect(denied.approval?.decision).toBe('DENIED');
  });

  it('approve() on DENIED call throws ALREADY_TERMINAL', async () => {
    const gw = makeGateway();
    await gw.request(call({ riskClass: 'DESTRUCTIVE', toolCallId: 'TC7' }));
    await expect(gw.approve('TC7', 'user')).rejects.toMatchObject({ code: 'ALREADY_TERMINAL' });
  });

  it('approve() on non-existent call throws NOT_FOUND', async () => {
    const gw = makeGateway();
    await expect(gw.approve('NO-SUCH', 'user')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('TG-004: only approve()/deny() create Approval records — no record without gateway call', async () => {
    const gw = makeGateway();
    await gw.request(call({ riskClass: 'MODIFY_WORKSPACE', toolCallId: 'TC8' }));
    // No approve/deny called — no approval record.
    expect(await approvals.getByToolCall('TC8')).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ToolGateway.execute — TG-001 / TG-005 / TG-010
// ─────────────────────────────────────────────────────────────────────────────

describe('ToolGateway.execute — TG-001/005/010', () => {
  it('succeeds with exitCode 0 → SUCCEEDED state', async () => {
    const gw = makeGateway(PERMISSIVE_TEST_POLICY);
    await gw.request(call({ toolCallId: 'TC9' }));
    const result = await gw.execute('TC9', SUCCESS_EXECUTOR);
    expect(result.state).toBe('SUCCEEDED');
    const evts = await events.query({ sessionId: 'S' });
    expect(evts.map((e) => e.type)).toContain('TOOL_CALL_ENDED');
  });

  it('exitCode non-zero → FAILED state', async () => {
    const gw = makeGateway(PERMISSIVE_TEST_POLICY);
    await gw.request(call({ toolCallId: 'TCA' }));
    const result = await gw.execute('TCA', FAIL_EXECUTOR);
    expect(result.state).toBe('FAILED');
  });

  it('TG-010: executor timeout → TIMEOUT state (not RUNNING-forever)', async () => {
    const gw = makeGateway(PERMISSIVE_TEST_POLICY);
    await gw.request(call({ toolCallId: 'TCB' }));
    const result = await gw.execute('TCB', TIMEOUT_EXECUTOR);
    expect(result.state).toBe('TIMEOUT');
  });

  it('TG-005: DENIED call cannot be executed (NOT_APPROVED)', async () => {
    const gw = makeGateway();
    await gw.request(call({ riskClass: 'DESTRUCTIVE', toolCallId: 'TCC' }));
    await expect(gw.execute('TCC', SUCCESS_EXECUTOR)).rejects.toMatchObject({ code: 'NOT_APPROVED' });
  });

  it('TG-001: call in APPROVAL_PENDING cannot be executed (NOT_APPROVED)', async () => {
    const gw = makeGateway();
    await gw.request(call({ riskClass: 'MODIFY_WORKSPACE', toolCallId: 'TCD' }));
    await expect(gw.execute('TCD', SUCCESS_EXECUTOR)).rejects.toMatchObject({ code: 'NOT_APPROVED' });
  });

  it('TOOL_CALL_STARTED event emitted before execution', async () => {
    const gw = makeGateway(PERMISSIVE_TEST_POLICY);
    await gw.request(call({ toolCallId: 'TCE' }));
    await gw.execute('TCE', SUCCESS_EXECUTOR);
    const evts = await events.query({ sessionId: 'S' });
    const types = evts.map((e) => e.type);
    expect(types).toContain('TOOL_CALL_STARTED');
    // STARTED must come before ENDED.
    expect(types.indexOf('TOOL_CALL_STARTED')).toBeLessThan(types.indexOf('TOOL_CALL_ENDED'));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SqliteToolCallRepository + SqliteApprovalRepository (persistence)
// ─────────────────────────────────────────────────────────────────────────────

describe('SqliteToolCallRepository persistence', () => {
  it('creates and retrieves a tool call', async () => {
    await calls.create(call());
    const found = await calls.getById('TC1');
    expect(found?.toolName).toBe('read_file');
    expect(found?.riskClass).toBe('READ_ONLY');
    expect(found?.state).toBe('REQUESTED');
  });

  it('returns null for unknown id', async () => {
    expect(await calls.getById('NOPE')).toBeNull();
  });

  it('transition() updates state', async () => {
    await calls.create(call());
    await calls.transition('TC1', { state: 'APPROVED' });
    expect((await calls.getById('TC1'))?.state).toBe('APPROVED');
  });

  it('transition() with startedAt preserves it on subsequent updates', async () => {
    await calls.create(call());
    await calls.transition('TC1', { state: 'RUNNING', startedAt: '2026-01-01T00:00:01.000Z' });
    await calls.transition('TC1', { state: 'SUCCEEDED', endedAt: '2026-01-01T00:00:02.000Z' });
    const found = await calls.getById('TC1');
    expect(found?.state).toBe('SUCCEEDED');
    expect(found?.startedAt).toBe('2026-01-01T00:00:01.000Z');
  });
});

describe('SqliteApprovalRepository persistence', () => {
  it('creates and retrieves approval by tool call', async () => {
    await calls.create(call());
    const approval: Approval = {
      approvalId: 'A1',
      toolCallId: 'TC1',
      binding: { argumentsHash: 'HASH-ARGS', toolPolicyVersion: 1 },
      decision: 'APPROVED',
      decidedBy: 'user',
      decidedAt: '2026-01-01T00:00:01.000Z',
    };
    await approvals.create(approval);
    const found = await approvals.getByToolCall('TC1');
    expect(found?.approvalId).toBe('A1');
    expect(found?.binding.argumentsHash).toBe('HASH-ARGS');
    expect(found?.decision).toBe('APPROVED');
  });

  it('returns null when no approval exists', async () => {
    await calls.create(call());
    expect(await approvals.getByToolCall('TC1')).toBeNull();
  });
});
