// ApprovalEngine — SECURITY_MODEL §5.4, DOMAIN_CONTRACTS §13, P1.5-TG2.
//
// Dedicated service for all human-interaction approval lifecycle:
//   - Approval creation with binding (HI-001 / TG-003).
//   - Forge-proof: only this service creates Approval records — model output
//     cannot bypass it (HI-002 / TG-004).
//   - Expiry enforcement: expired approvals are rejected at use (TG-003).
//   - Binding mismatch detection: reusing an approval for a different
//     argumentsHash is rejected (HI-002).
//   - Human override marker: HUMAN_OVERRIDE_COMPLETED is recorded as a
//     new, separate record that links to the original VerificationReport
//     without modifying it (HI-003 / HI-004).
//
// Pure + deterministic inputs (now, nextId injected). No LLM, no side-effects
// beyond EventLog + ApprovalRepository writes.

import type { Approval } from '../domain/tool-call.js';
import type { HumanOverride } from '../domain/human-override.js';
import type { DomainEvent, EventType } from '../domain/event.js';
import type { EventLog } from '../repositories/index.js';
import type { ApprovalRepository } from './tool-gateway.js';

// ── HumanOverrideRepository ───────────────────────────────────────────────────

export interface HumanOverrideRepository {
  create(override: HumanOverride): Promise<void>;
  getByTask(taskId: string): Promise<HumanOverride | null>;
  getById(overrideId: string): Promise<HumanOverride | null>;
}

// ── ApprovalEngineError ───────────────────────────────────────────────────────

export class ApprovalEngineError extends Error {
  public readonly code:
    | 'NOT_FOUND'
    | 'BINDING_MISMATCH'   // HI-002: argumentsHash does not match the call (TG-003)
    | 'APPROVAL_EXPIRED'   // expiresAt has passed
    | 'ALREADY_DECIDED'    // approval for this call already exists (idempotency)
    | 'OVERRIDE_EXISTS'    // task already has an override record
    | 'INVALID_DECISION';  // decision must be APPROVED or DENIED

  constructor(code: ApprovalEngineError['code'], message?: string) {
    super(message ?? code);
    this.name = 'ApprovalEngineError';
    this.code = code;
  }
}

// ── ApprovalRequest ───────────────────────────────────────────────────────────

export interface ApprovalRequest {
  readonly toolCallId: string;
  /** The argumentsHash the approval was computed for (HI-001/TG-003 binding). */
  readonly argumentsHash: string;
  readonly toolPolicyVersion: number;
  readonly decision: 'APPROVED' | 'DENIED';
  readonly decidedBy: Approval['decidedBy'];
  readonly reason?: string;
  /** ISO timestamp after which this approval expires. Optional. */
  readonly expiresAt?: string;
}

// ── OverrideRequest ───────────────────────────────────────────────────────────

export interface OverrideRequest {
  readonly taskId: string;
  /** The verificationId being overridden — stored as reference (HI-004: never mutate). */
  readonly verificationId: string;
  readonly reason: string;
  readonly decidedBy: 'user';
}

// ── Deps ──────────────────────────────────────────────────────────────────────

export interface ApprovalEngineDeps {
  readonly approvals: ApprovalRepository;
  readonly overrides: HumanOverrideRepository;
  readonly events: EventLog;
  readonly sessionId: string;
  readonly now: () => string;
  readonly nextId: () => string;
}

// ── ApprovalEngine ────────────────────────────────────────────────────────────

export class ApprovalEngine {
  constructor(private readonly deps: ApprovalEngineDeps) {}

  /**
   * Create an Approval record for a tool call.
   *
   * HI-001 / TG-003: binding is computed from the caller-supplied (toolCallId,
   *   argumentsHash, toolPolicyVersion). Mismatches detected at verify().
   * HI-002 / TG-004: only this method creates an Approval — model output cannot
   *   call this. The service is T0/T1 authority.
   * Idempotency: if an approval already exists for this toolCallId, rejects with
   *   ALREADY_DECIDED (no silent double-approval).
   */
  async createApproval(req: ApprovalRequest): Promise<Approval> {
    if (req.decision !== 'APPROVED' && req.decision !== 'DENIED') {
      throw new ApprovalEngineError(
        'INVALID_DECISION',
        `decision must be APPROVED or DENIED, got: ${String(req.decision)}`,
      );
    }

    // Idempotency: reject if an approval already exists (no overwrite).
    const existing = await this.deps.approvals.getByToolCall(req.toolCallId);
    if (existing !== null) {
      throw new ApprovalEngineError(
        'ALREADY_DECIDED',
        `approval for tool call ${req.toolCallId} already exists (decision: ${existing.decision})`,
      );
    }

    const approval: Approval = {
      approvalId: this.deps.nextId(),
      toolCallId: req.toolCallId,
      binding: {
        argumentsHash: req.argumentsHash,
        toolPolicyVersion: req.toolPolicyVersion,
      },
      decision: req.decision,
      decidedBy: req.decidedBy,
      decidedAt: this.deps.now(),
      ...(req.reason !== undefined ? { reason: req.reason } : {}),
      ...(req.expiresAt !== undefined ? { expiresAt: req.expiresAt } : {}),
    };

    await this.deps.approvals.create(approval);

    const eventType: EventType =
      req.decision === 'APPROVED' ? 'HUMAN_APPROVAL_GRANTED' : 'HUMAN_APPROVAL_DENIED';
    await this.emit(eventType, req.toolCallId, {
      approvalId: approval.approvalId,
      toolCallId: req.toolCallId,
      decision: req.decision,
      decidedBy: req.decidedBy,
    });

    return approval;
  }

  /**
   * Verify an Approval at the point of use (before execution).
   *
   * HI-001 / TG-003: checks that the stored approval's argumentsHash matches
   *   the supplied hash. A mismatch means the approval was for a different
   *   call → BINDING_MISMATCH.
   * Expiry: if expiresAt is set and now() > expiresAt → APPROVAL_EXPIRED.
   *
   * Returns the approval if valid; throws otherwise.
   */
  async verifyApproval(toolCallId: string, argumentsHash: string): Promise<Approval> {
    const approval = await this.deps.approvals.getByToolCall(toolCallId);
    if (approval === null) {
      throw new ApprovalEngineError('NOT_FOUND', `no approval for tool call ${toolCallId}`);
    }

    // HI-002: binding check — approval was for this exact argumentsHash.
    if (approval.binding.argumentsHash !== argumentsHash) {
      throw new ApprovalEngineError(
        'BINDING_MISMATCH',
        `approval argumentsHash "${approval.binding.argumentsHash}" ` +
          `does not match call argumentsHash "${argumentsHash}" (HI-002 / TG-003)`,
      );
    }

    // Expiry check.
    if (approval.expiresAt !== undefined && this.deps.now() > approval.expiresAt) {
      throw new ApprovalEngineError(
        'APPROVAL_EXPIRED',
        `approval for tool call ${toolCallId} expired at ${approval.expiresAt}`,
      );
    }

    return approval;
  }

  /**
   * Record a HUMAN_OVERRIDE_COMPLETED marker.
   *
   * HI-003: the override is recorded as an explicit, distinct record.
   * HI-004: the original VerificationReport is NEVER modified — the override
   *   only stores a reference (verificationId) to it.
   *
   * Idempotency: if an override already exists for the task, throws
   *   OVERRIDE_EXISTS (one override per task per verification).
   */
  async recordOverride(req: OverrideRequest): Promise<HumanOverride> {
    // One override per task — no silent duplicate.
    const existing = await this.deps.overrides.getByTask(req.taskId);
    if (existing !== null) {
      throw new ApprovalEngineError(
        'OVERRIDE_EXISTS',
        `task ${req.taskId} already has an override (overrideId: ${existing.overrideId})`,
      );
    }

    // HI-004: store only a reference to the report, never mutate it.
    const override: HumanOverride = {
      overrideId: this.deps.nextId(),
      taskId: req.taskId,
      verificationId: req.verificationId, // reference only — HI-004
      reason: req.reason,
      decidedBy: req.decidedBy,
      decidedAt: this.deps.now(),
      kind: 'HUMAN_OVERRIDE_COMPLETED',
    };

    await this.deps.overrides.create(override);

    // HI-003: emit the explicit marker event.
    await this.emit('HUMAN_OVERRIDE_COMPLETED', req.taskId, {
      overrideId: override.overrideId,
      taskId: req.taskId,
      verificationId: req.verificationId,
      decidedBy: req.decidedBy,
    });

    return override;
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private async emit(type: EventType, aggregateId: string, payload: unknown): Promise<void> {
    const event: DomainEvent = {
      eventId: this.deps.nextId(),
      sessionId: this.deps.sessionId,
      type,
      aggregate: { kind: 'tool_call', id: aggregateId },
      payload,
      at: this.deps.now(),
      sequenceNumber: 0, // EventLog is sequence authority (CP-008)
    };
    await this.deps.events.append(event);
  }
}
