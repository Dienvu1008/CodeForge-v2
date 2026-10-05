// RecoveryEngine — P5-RE1. Executes a chosen recovery action and records provenance.
//
// Enforces:
//   RC-004: ROLLBACK only when explicitly passed — engine does not re-check policy.
//           Caller (SessionOrchestrator) must call RecoveryPolicy.decide() first.
//   RC-006: every action writes a RecoveryAction record with provenance + reason.
//   RC-007: ESCALATE transitions session to AWAITING_HUMAN.
//
// Phase 5 implementations per action:
//   RETRY    — re-run the same task (caller triggers a new TaskExecutor run).
//   FIX      — request a fix context from model; caller re-runs with failure evidence.
//   REPLAN   — GraphMutation via Planner with failure context (Phase 5.5 — deferred).
//   ROLLBACK — revert workspace to last checkpoint revision (Phase 5.5 — deferred).
//   ESCALATE — session → AWAITING_HUMAN (RC-007).
//   ABORT    — session → ABORTED via CANCEL_REQUESTED.
//
// REPLAN and ROLLBACK return PENDING outcome — callers must implement the action
// themselves (Phase 5.5). RETRY and FIX return SUCCEEDED (the attempt was started).
import type { Failure, RecoveryAction, RecoveryKind, RecoveryOutcome } from '../domain/failure.js';
import type { DomainEvent, EventType } from '../domain/event.js';
import type { EventLog, RecoveryActionRepository } from '../repositories/index.js';
import type { SessionService } from '../session/session-service.js';
import type { BudgetConsumption } from '../domain/budget.js';

// ── RecoveryEngineError ───────────────────────────────────────────────────────

export class RecoveryEngineError extends Error {
  public readonly code:
    | 'ROLLBACK_NOT_IMPLEMENTED' // Phase 5.5 — placeholder
    | 'REPLAN_NOT_IMPLEMENTED'   // Phase 5.5 — placeholder
    | 'ESCALATE_FAILED'          // SessionService.transition threw
    | 'UNKNOWN_ACTION';

  constructor(code: RecoveryEngineError['code'], message?: string) {
    super(message ?? code);
    this.name = 'RecoveryEngineError';
    this.code = code;
  }
}

// ── RecoveryEngineDeps ────────────────────────────────────────────────────────

export interface RecoveryEngineDeps {
  readonly recoveryActions: RecoveryActionRepository;
  readonly events:          EventLog;
  readonly sessionService:  SessionService;
  readonly now:    () => string;
  readonly nextId: () => string;
}

// ── ExecuteInput ──────────────────────────────────────────────────────────────

export interface ExecuteInput {
  readonly failure:       Failure;
  readonly action:        RecoveryKind;
  readonly reason:        string;
  readonly policyVersion: number;
  readonly sessionId:     string;
}

// ── ExecuteResult ─────────────────────────────────────────────────────────────

export interface ExecuteResult {
  readonly recoveryAction:  RecoveryAction;
  /**
   * For RETRY/FIX: the caller should re-execute the task.
   * For ESCALATE/ABORT: session state changed.
   * For REPLAN/ROLLBACK: caller must implement the action (Phase 5.5).
   */
  readonly shouldRetry:     boolean;
  readonly sessionEscalated: boolean;
}

// ── RecoveryEngine ────────────────────────────────────────────────────────────

export class RecoveryEngine {
  constructor(private readonly deps: RecoveryEngineDeps) {}

  /**
   * Execute a recovery action for a failure. Writes a RecoveryAction record
   * (RC-006: provenance always set) and emits a domain event.
   *
   * RC-007: ESCALATE calls SessionService.transition('HUMAN_REQUIRED').
   */
  async execute(input: ExecuteInput): Promise<ExecuteResult> {
    const startedAt = this.deps.now();
    let outcome: RecoveryOutcome = 'PENDING';
    let shouldRetry = false;
    let sessionEscalated = false;

    switch (input.action) {
      case 'RETRY':
      case 'FIX':
        // Caller will re-run the task with or without fix context.
        // Engine just records the intent — outcome becomes SUCCEEDED
        // (the attempt was authorised; actual success is measured by next run).
        outcome = 'SUCCEEDED';
        shouldRetry = true;
        break;

      case 'ESCALATE':
        // RC-007: transition session to AWAITING_HUMAN.
        try {
          await this.deps.sessionService.transition(input.sessionId, 'HUMAN_REQUIRED');
          outcome = 'SUCCEEDED';
          sessionEscalated = true;
        } catch {
          outcome = 'FAILED';
          // Still record the action — do not silently swallow escalation failure.
        }
        break;

      case 'ABORT':
        try {
          await this.deps.sessionService.transition(input.sessionId, 'CANCEL_REQUESTED');
          outcome = 'SUCCEEDED';
        } catch {
          outcome = 'FAILED';
        }
        break;

      case 'REPLAN':
        // Phase 5.5: requires Replanner with LLM context — caller implements.
        outcome = 'PENDING';
        shouldRetry = false;
        break;

      case 'ROLLBACK':
        // Phase 5.5: requires workspace revert — caller implements.
        outcome = 'PENDING';
        shouldRetry = false;
        break;

      default:
        outcome = 'ABORTED';
        break;
    }

    const endedAt = this.deps.now();
    const zeroBudget: BudgetConsumption = {
      wallClockMs: 0, modelTokens: 0, toolCalls: 0, recoveryAttempts: 1,
    };

    // RC-006: record provenance + reason.
    const recoveryAction: RecoveryAction = {
      actionId:           this.deps.nextId(),
      failureId:          input.failure.failureId,
      action:             input.action,
      reason:             input.reason,
      policyVersion:      input.policyVersion,
      budgetConsumed:     zeroBudget,
      startedAt,
      endedAt,
      outcome,
    };

    await this.deps.recoveryActions.create(recoveryAction);

    // Emit event (RC-006: every action must be auditable).
    await this.emitRecoveryAction(input, recoveryAction);

    return { recoveryAction, shouldRetry, sessionEscalated };
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  private async emitRecoveryAction(
    input:  ExecuteInput,
    action: RecoveryAction,
  ): Promise<void> {
    const event: DomainEvent = {
      eventId:        this.deps.nextId(),
      sessionId:      input.sessionId,
      type:           'RECOVERY_ACTION_TAKEN' as EventType,
      aggregate:      { kind: 'task', id: input.failure.taskId },
      payload: {
        actionId:  action.actionId,
        failureId: action.failureId,
        action:    action.action,
        outcome:   action.outcome,
        reason:    action.reason,
      },
      at:             action.startedAt,
      sequenceNumber: 0,
    };
    await this.deps.events.append(event);
  }
}