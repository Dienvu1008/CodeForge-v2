// ToolGateway — SECURITY_MODEL §5, DOMAIN_CONTRACTS §12, P1.5-TG1.
//
// The single boundary through which the runtime executes any tool (TG-001).
// Enforces the full ToolCall lifecycle via the state machine:
//
//   request() → REQUESTED → [policy check] → APPROVED | APPROVAL_PENDING | DENIED
//   approve() → APPROVED
//   deny()    → DENIED
//   execute() → RUNNING → SUCCEEDED | FAILED | TIMEOUT
//
// Invariants enforced here:
//   TG-001: no tool execution outside ToolGateway.
//   TG-003: approval is bound to (toolCallId, argumentsHash, policyVersion).
//   TG-004: model output cannot create an Approval record (only approve/deny() can).
//   TG-005: DENIED tool calls never execute.
//   TG-007: DESTRUCTIVE/PRIVILEGED never auto-approve (delegated to determineAction).
//   TG-009: arguments pass schema validation before any state change.
//   TG-010: execution timeout → TIMEOUT state, not RUNNING-forever.
//
// The executor (ProcessSupervisor-based subprocess runner) is injected so the gateway
// is testable with a fake. In Phase 1.5 the executor interface is simple: receive
// a tool call and return a ToolResult. Real implementations delegate to ProcessSupervisor.

import type { ToolCall, Approval, ToolResult } from '../domain/tool-call.js';
import type { DomainEvent, EventType } from '../domain/event.js';
import type { EventLog } from '../repositories/index.js';
import { transitionToolCall, isToolCallTerminal } from './tool-call-machine.js';
import { determineAction, type ToolPolicy, DEFAULT_TOOL_POLICY } from './tool-policy.js';
import type { OutputSchema } from '../security/structured-output-validator.js';
import { validateModelOutput } from '../security/structured-output-validator.js';

// ── Repository interfaces ─────────────────────────────────────────────────────

export interface ToolCallRepository {
  create(call: ToolCall): Promise<void>;
  getById(toolCallId: string): Promise<ToolCall | null>;
  /** Transition state in place (only for non-terminal transitions). */
  transition(toolCallId: string, patch: ToolCallPatch): Promise<void>;
}

export interface ToolCallPatch {
  readonly state: ToolCall['state'];
  readonly startedAt?: string;
  readonly endedAt?: string;
  readonly approval?: Approval;
  readonly result?: ToolResult;
}

export interface ApprovalRepository {
  create(approval: Approval): Promise<void>;
  getByToolCall(toolCallId: string): Promise<Approval | null>;
}

// ── Executor contract ─────────────────────────────────────────────────────────

/**
 * The executor runs an approved tool call and returns a ToolResult.
 * Phase 1.5: implementors wrap ProcessSupervisor. FakeToolExecutor is in testing/.
 * TG-010: execution MUST honour the timeout; if exceeded, return { timedOut: true }.
 */
export interface ToolExecutor {
  execute(call: ToolCall): Promise<ExecutorResult>;
}

export interface ExecutorResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** True when the executor killed the process due to timeout (TG-010). */
  readonly timedOut: boolean;
}

// ── ToolGatewayError ──────────────────────────────────────────────────────────

export class ToolGatewayError extends Error {
  public readonly code:
    | 'NOT_FOUND'
    | 'ALREADY_TERMINAL'
    | 'INVALID_TRANSITION'
    | 'DENIED_BY_POLICY'
    | 'NOT_APPROVED'
    | 'APPROVAL_BINDING_MISMATCH' // TG-003/TG-004: binding does not match
    | 'SCHEMA_VALIDATION_FAILED'  // TG-009
    | 'EXECUTION_ERROR';

  constructor(code: ToolGatewayError['code'], message?: string) {
    super(message ?? code);
    this.name = 'ToolGatewayError';
    this.code = code;
  }
}

// ── Deps ──────────────────────────────────────────────────────────────────────

export interface ToolGatewayDeps {
  readonly calls: ToolCallRepository;
  readonly approvals: ApprovalRepository;
  readonly events: EventLog;
  readonly policy?: ToolPolicy;
  /** Argument schema registry: toolName → OutputSchema. Optional — unknown tools skip schema check. */
  readonly schemas?: Readonly<Record<string, OutputSchema>>;
  readonly now: () => string;
  readonly nextId: () => string;
}

// ── ToolGateway ───────────────────────────────────────────────────────────────

export class ToolGateway {
  private readonly policy: ToolPolicy;

  constructor(private readonly deps: ToolGatewayDeps) {
    this.policy = deps.policy ?? DEFAULT_TOOL_POLICY;
  }

  /**
   * Register a tool call proposal. Validates arguments (TG-009), checks policy
   * (TG-007/SE-009), persists the call, emits TOOL_CALL_REQUESTED.
   *
   * Returns the call in its initial state:
   *   APPROVED        if policy auto-approves.
   *   APPROVAL_PENDING if policy requires human decision.
   *   DENIED          if policy denies immediately (TG-005).
   */
  async request(call: ToolCall): Promise<ToolCall> {
    // TG-009: validate arguments schema before any state change.
    const schema = this.deps.schemas?.[call.toolName];
    if (schema !== undefined) {
      const raw = JSON.stringify(call.arguments);
      const validation = validateModelOutput(raw, { schema });
      if (!validation.ok) {
        throw new ToolGatewayError(
          'SCHEMA_VALIDATION_FAILED',
          `tool "${call.toolName}" argument schema validation failed: ${validation.error.message}`,
        );
      }
    }

    // Determine policy action.
    const action = determineAction(call.toolName, call.riskClass, this.policy);
    let nextState: ToolCall['state'];

    if (action === 'deny') {
      nextState = 'DENIED';
    } else if (action === 'allow') {
      nextState = 'APPROVED';
    } else {
      nextState = 'APPROVAL_PENDING';
    }

    const transitioned = { ...call, state: nextState };
    await this.deps.calls.create(transitioned);

    const eventType: EventType = action === 'deny'
      ? 'TOOL_CALL_DENIED'
      : action === 'allow'
        ? 'TOOL_CALL_APPROVED'
        : 'TOOL_CALL_REQUESTED';

    await this.emit(transitioned, eventType, {
      toolCallId: call.toolCallId,
      state: nextState,
      policyAction: action,
    });

    // If auto-denied, also emit TOOL_CALL_DENIED for observability.
    if (action === 'deny' && eventType !== 'TOOL_CALL_DENIED') {
      await this.emit(transitioned, 'TOOL_CALL_DENIED', { toolCallId: call.toolCallId });
    }

    return transitioned;
  }

  /**
   * Record a human APPROVED decision. TG-003: the approval binds to
   * (toolCallId, argumentsHash, policyVersion). TG-004: only this method creates
   * an Approval record — model output cannot call this directly.
   */
  async approve(
    toolCallId: string,
    decidedBy: Approval['decidedBy'],
    expiresAt?: string,
  ): Promise<ToolCall> {
    const call = await this.requireCall(toolCallId);
    this.requireNotTerminal(call);

    const result = transitionToolCall(call.state, 'HUMAN_APPROVED');
    if (!result.ok) {
      throw new ToolGatewayError('INVALID_TRANSITION', result.reason);
    }

    // TG-003: create approval record bound to this call's argumentsHash and policyVersion.
    const approval: Approval = {
      approvalId: this.deps.nextId(),
      toolCallId,
      binding: {
        argumentsHash: call.argumentsHash,
        toolPolicyVersion: this.policy.version,
      },
      decision: 'APPROVED',
      decidedBy,
      decidedAt: this.deps.now(),
      ...(expiresAt !== undefined ? { expiresAt } : {}),
    };
    await this.deps.approvals.create(approval);

    const patch: ToolCallPatch = { state: 'APPROVED', approval };
    await this.deps.calls.transition(toolCallId, patch);
    await this.emit(call, 'TOOL_CALL_APPROVED', { toolCallId, decidedBy });

    return { ...call, ...patch };
  }

  /**
   * Record a human DENIED decision. Transition to DENIED (terminal — TG-005).
   */
  async deny(
    toolCallId: string,
    decidedBy: Approval['decidedBy'],
    reason?: string,
  ): Promise<ToolCall> {
    const call = await this.requireCall(toolCallId);
    this.requireNotTerminal(call);

    const result = transitionToolCall(call.state, 'HUMAN_DENIED');
    if (!result.ok) {
      throw new ToolGatewayError('INVALID_TRANSITION', result.reason);
    }

    const approval: Approval = {
      approvalId: this.deps.nextId(),
      toolCallId,
      binding: {
        argumentsHash: call.argumentsHash,
        toolPolicyVersion: this.policy.version,
      },
      decision: 'DENIED',
      decidedBy,
      decidedAt: this.deps.now(),
      ...(reason !== undefined ? { reason } : {}),
    };
    await this.deps.approvals.create(approval);

    const patch: ToolCallPatch = { state: 'DENIED', approval };
    await this.deps.calls.transition(toolCallId, patch);
    await this.emit(call, 'TOOL_CALL_DENIED', { toolCallId, decidedBy, reason });

    return { ...call, ...patch };
  }

  /**
   * Execute an APPROVED tool call via the injected executor.
   *
   * TG-001: no bypass — only APPROVED calls reach this method.
   * TG-005: transitions from APPROVED only (DENIED is already terminal).
   * TG-010: executor timeout → TIMEOUT state (not RUNNING-forever).
   */
  async execute(toolCallId: string, executor: ToolExecutor): Promise<ToolCall> {
    const call = await this.requireCall(toolCallId);

    // TG-005: DENIED is terminal and never reaches execute().
    if (call.state !== 'APPROVED') {
      throw new ToolGatewayError(
        'NOT_APPROVED',
        `tool call ${toolCallId} is in state ${call.state}, not APPROVED`,
      );
    }

    // Verify approval binding is present and consistent (TG-003 integrity check).
    const existingApproval = await this.deps.approvals.getByToolCall(toolCallId);
    if (
      existingApproval !== null &&
      existingApproval.binding.argumentsHash !== call.argumentsHash
    ) {
      throw new ToolGatewayError(
        'APPROVAL_BINDING_MISMATCH',
        `approval argumentsHash does not match call argumentsHash (TG-003)`,
      );
    }

    const startedAt = this.deps.now();
    await this.deps.calls.transition(toolCallId, { state: 'RUNNING', startedAt });
    await this.emit(call, 'TOOL_CALL_STARTED', { toolCallId, startedAt });

    // Run the executor. TG-010: timeout produces timedOut=true.
    let execResult: ExecutorResult;
    try {
      execResult = await executor.execute({ ...call, state: 'RUNNING', startedAt });
    } catch (err) {
      // Infrastructure error — fail the call.
      const endedAt = this.deps.now();
      const result: ToolResult = {
        durationMs: 0,
      };
      await this.deps.calls.transition(toolCallId, { state: 'FAILED', endedAt, result });
      await this.emit(call, 'TOOL_CALL_ENDED', { toolCallId, state: 'FAILED', endedAt });
      throw new ToolGatewayError(
        'EXECUTION_ERROR',
        `executor threw: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const endedAt = this.deps.now();
    const terminalState = execResult.timedOut
      ? 'TIMEOUT'
      : execResult.exitCode === 0
        ? 'SUCCEEDED'
        : 'FAILED';

    const exitCode = execResult.exitCode;
    const result: ToolResult = {
      durationMs: 0,
      ...(exitCode !== null ? { exitCode } : {}),
    };

    await this.deps.calls.transition(toolCallId, { state: terminalState, endedAt, result });
    await this.emit(call, 'TOOL_CALL_ENDED', { toolCallId, state: terminalState, endedAt });

    return { ...call, state: terminalState, startedAt, endedAt, result };
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private async requireCall(toolCallId: string): Promise<ToolCall> {
    const call = await this.deps.calls.getById(toolCallId);
    if (!call) throw new ToolGatewayError('NOT_FOUND', `tool call ${toolCallId} not found`);
    return call;
  }

  private requireNotTerminal(call: ToolCall): void {
    if (isToolCallTerminal(call.state)) {
      throw new ToolGatewayError('ALREADY_TERMINAL', `tool call ${call.toolCallId} is terminal: ${call.state}`);
    }
  }

  private async emit(call: ToolCall, type: EventType, payload: unknown): Promise<void> {
    const event: DomainEvent = {
      eventId: this.deps.nextId(),
      sessionId: call.sessionId,
      type,
      aggregate: { kind: 'tool_call', id: call.toolCallId },
      payload,
      at: this.deps.now(),
      sequenceNumber: 0, // EventLog is the sequence authority (CP-008)
    };
    await this.deps.events.append(event);
  }
}
