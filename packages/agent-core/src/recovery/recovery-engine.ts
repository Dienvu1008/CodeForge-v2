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
//   REPLAN   — authorised here (shouldReplan=true); the caller commits a GraphMutation that
//              SUPERSEDEs the failing task with a fresh one carrying the failure evidence
//              (GI-009 via GraphCommitService; RC-005 a new version, never an overwrite).
//   ROLLBACK — authorised here (shouldRollback=true); the caller reverts the workspace to the last
//              clean checkpoint through an injected WorkspaceRollback port, then re-arms the task.
//   ESCALATE — session → AWAITING_HUMAN (RC-007).
//   ABORT    — session → ABORTED via CANCEL_REQUESTED.
//
// REPLAN returns PENDING + shouldReplan; ROLLBACK returns PENDING + shouldRollback (caller reverts).
// RETRY and FIX also return PENDING: the attempt is authorised but
// its success is unknown until the retried run is verified — the orchestrator retroactively
// finalizes the outcome (SUCCEEDED/FAILED) then (P11.6+). ESCALATE/ABORT return SUCCEEDED
// (the state transition itself is the action and it completed).
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
   * For RETRY/FIX: the caller should re-execute the SAME task.
   * For ESCALATE/ABORT: session state changed.
   * For ROLLBACK: caller must implement the workspace revert (still deferred).
   */
  readonly shouldRetry:     boolean;
  readonly sessionEscalated: boolean;
  /**
   * For REPLAN: the engine authorised a re-plan; the caller (SessionOrchestrator) must perform
   * it by committing a GraphMutation (GI-009: via GraphCommitService, never a direct graph write;
   * RC-005: a new mutation/version, not an overwrite). The engine stays domain-pure and does not
   * call the Planner / GraphCommitService itself. Outcome stays PENDING until the re-planned task
   * run is verified, exactly like RETRY/FIX.
   */
  readonly shouldReplan:    boolean;
  /**
   * For ROLLBACK: the engine authorised reverting the workspace to the last clean checkpoint;
   * the caller (SessionOrchestrator) performs the revert through an injected WorkspaceRollback
   * port (DC-002 — the engine stays domain-pure and never touches the filesystem). Like REPLAN,
   * the outcome stays PENDING: ROLLBACK re-arms the task to retry on the reverted baseline, and
   * the orchestrator finalizes SUCCEEDED/FAILED once that retry's verification is known.
   * RC-004: the engine only reaches this branch when decide() already allowed ROLLBACK.
   */
  readonly shouldRollback:  boolean;
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
    let shouldReplan = false;
    let shouldRollback = false;

    switch (input.action) {
      case 'RETRY':
      case 'FIX':
        // The caller will re-run the task (with or without fix context). We only AUTHORISE
        // the attempt here — we do NOT yet know whether it will pass. So the outcome stays
        // PENDING; the orchestrator retroactively sets it to SUCCEEDED or FAILED once the
        // retried run's verification is known (P11.6+). This makes RecoveryAction.outcome a
        // TRUTHFUL signal the learning layer can trust (previously it was eagerly SUCCEEDED,
        // which taught the advisor from noise). PENDING is excluded from success-rate stats.
        outcome = 'PENDING';
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
        // Authorise a re-plan. The caller performs it by committing a GraphMutation (lightweight
        // REPLAN = SUPERSEDE the failing task with a fresh one carrying the failure evidence; GI-009
        // via GraphCommitService; RC-005 a new version, not an overwrite). Outcome stays PENDING —
        // the orchestrator finalizes it when the re-planned run is verified (like RETRY/FIX).
        outcome = 'PENDING';
        shouldReplan = true;
        break;

      case 'ROLLBACK':
        // Authorise a workspace revert to the last clean checkpoint. The caller (orchestrator)
        // performs it through an injected WorkspaceRollback port — the engine never touches the
        // filesystem (DC-002, domain-pure). RC-004 is already satisfied: decide() only emits
        // ROLLBACK when the class's rollbackAllowed=true. Outcome stays PENDING: after the revert
        // the task is re-armed and the orchestrator finalizes the outcome when the retry on the
        // reverted baseline is verified (like RETRY/FIX/REPLAN).
        outcome = 'PENDING';
        shouldRollback = true;
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

    return { recoveryAction, shouldRetry, sessionEscalated, shouldReplan, shouldRollback };
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