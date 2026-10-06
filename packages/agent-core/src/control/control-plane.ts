// ControlPlane (P9.7) — the single admission point for every external control action
// (dashboard button, Telegram command, VS Code, CLI). Enforces OB-006.
//
// NOT AUTHORITY, NO I/O: admit() is a pure, total function of (ControlRequest, current
// plain-data runtime state, policy). It decides whether a control intent is admissible
// and, if so, returns an AdmittedControl describing EXACTLY which existing kernel method
// the caller must invoke (a session-machine event, or a ToolGateway approve/deny) — it
// never calls that method itself. The adapter that submitted the request executes the
// admitted action through the authoritative service.
//
// Why one plane: a dashboard "Pause" and a Telegram "/pause" build the SAME ControlRequest
// (UI-agnostic shape), so they admit identically — no UI holds private authority. A
// request that is not admissible against the current state/policy is rejected here, before
// it can reach any kernel mutator.
import type { SessionState, ToolCallState } from '../state-machine/states.js';
import type { SessionEvent } from '../session/session-machine.js';

// ── Control intents + requests ──────────────────────────────────────────────────

export type ControlIntent =
  | 'pause'
  | 'resume'
  | 'cancel'
  | 'approve'
  | 'deny'
  | 'retry'
  | 'checkpoint';

/** Who issued the control request. Adapter-agnostic — a user via any surface. */
export interface ControlActor {
  readonly kind: 'user' | 'system';
  readonly id: string;
  /** The surface the request arrived through (audit only — never affects admission). */
  readonly surface?: 'dashboard' | 'telegram' | 'vscode' | 'cli' | 'api';
}

export interface ControlRequest {
  readonly intent: ControlIntent;
  readonly sessionId: string;
  readonly requestedBy: ControlActor;
  /** Target tool call for approve/deny. */
  readonly toolCallId?: string;
  /** Target task for retry. */
  readonly taskId?: string;
  /**
   * Optional optimistic-concurrency guard: the session state the requester believed was
   * current. If present and it disagrees with the actual state, the request is rejected
   * as stale (prevents acting on an out-of-date view).
   */
  readonly expectedSessionState?: SessionState;
  /** Optional reason (carried into the admitted action, e.g. deny reason). */
  readonly reason?: string;
}

// ── Current state the plane reads (plain data — assembled by the caller) ──────────

export interface ControlStateInput {
  readonly sessionId: string;
  readonly sessionState: SessionState;
  /** Present only when the request targets a tool call (approve/deny). */
  readonly toolCallState?: ToolCallState;
}

// ── Admission result ──────────────────────────────────────────────────────────

/** A session-machine control action: the caller must call SessionService.transition. */
export interface SessionControlAction {
  readonly kind: 'session_transition';
  readonly sessionId: string;
  readonly event: SessionEvent;
}

/** A tool approval/denial action: the caller must call ToolGateway.approve/deny. */
export interface ToolControlAction {
  readonly kind: 'tool_decision';
  readonly toolCallId: string;
  readonly decision: 'approve' | 'deny';
  readonly decidedBy: 'user';
  readonly reason?: string;
}

/** A retry action: the caller re-enqueues the task for another run (recovery path). */
export interface RetryControlAction {
  readonly kind: 'retry_task';
  readonly sessionId: string;
  readonly taskId: string;
}

/** A checkpoint action: the caller must call CheckpointService.capture. */
export interface CheckpointControlAction {
  readonly kind: 'checkpoint';
  readonly sessionId: string;
}

export type ControlAction =
  | SessionControlAction
  | ToolControlAction
  | RetryControlAction
  | CheckpointControlAction;

export type ControlRejectReason =
  | 'STALE_STATE'           // expectedSessionState disagreed with actual
  | 'NOT_APPLICABLE'        // intent illegal from the current session/tool state
  | 'MISSING_TARGET'        // approve/deny without toolCallId, retry without taskId
  | 'SESSION_TERMINAL'      // session already COMPLETED/ABORTED
  | 'TOOL_NOT_PENDING';     // approve/deny on a tool call not awaiting a decision

export type AdmissionResult =
  | { readonly admitted: true; readonly action: ControlAction }
  | { readonly admitted: false; readonly reason: ControlRejectReason };

// ── ControlPlane ──────────────────────────────────────────────────────────────

const TERMINAL_SESSION: ReadonlySet<SessionState> = new Set(['COMPLETED', 'ABORTED']);

export class ControlPlane {
  /**
   * Admit (or reject) a control request against the current runtime state. Pure + total:
   * same (request, state) → same result, regardless of which UI submitted it (OB-006).
   * Returns the exact kernel action the caller must perform; never performs it.
   */
  admit(req: ControlRequest, state: ControlStateInput): AdmissionResult {
    // Optimistic-concurrency: reject a request built against a stale view.
    if (req.expectedSessionState !== undefined && req.expectedSessionState !== state.sessionState) {
      return reject('STALE_STATE');
    }

    switch (req.intent) {
      case 'pause':
        return state.sessionState === 'RUNNING'
          ? admit({ kind: 'session_transition', sessionId: req.sessionId, event: 'PAUSE_REQUESTED' })
          : reject(TERMINAL_SESSION.has(state.sessionState) ? 'SESSION_TERMINAL' : 'NOT_APPLICABLE');

      case 'resume':
        return state.sessionState === 'PAUSED'
          ? admit({ kind: 'session_transition', sessionId: req.sessionId, event: 'RESUME_REQUESTED' })
          : reject(TERMINAL_SESSION.has(state.sessionState) ? 'SESSION_TERMINAL' : 'NOT_APPLICABLE');

      case 'cancel':
        // Cancel is admissible from any live, cancel-reachable state.
        if (TERMINAL_SESSION.has(state.sessionState)) return reject('SESSION_TERMINAL');
        if (state.sessionState === 'RUNNING' || state.sessionState === 'AWAITING_HUMAN' || state.sessionState === 'PAUSED') {
          return admit({ kind: 'session_transition', sessionId: req.sessionId, event: 'CANCEL_REQUESTED' });
        }
        return reject('NOT_APPLICABLE');

      case 'approve':
      case 'deny': {
        if (req.toolCallId === undefined) return reject('MISSING_TARGET');
        // Only a call awaiting a decision may be approved/denied.
        if (state.toolCallState !== 'APPROVAL_PENDING') return reject('TOOL_NOT_PENDING');
        return admit({
          kind: 'tool_decision',
          toolCallId: req.toolCallId,
          decision: req.intent,
          decidedBy: 'user',
          ...(req.reason !== undefined ? { reason: req.reason } : {}),
        });
      }

      case 'retry': {
        if (req.taskId === undefined) return reject('MISSING_TARGET');
        if (TERMINAL_SESSION.has(state.sessionState)) return reject('SESSION_TERMINAL');
        return admit({ kind: 'retry_task', sessionId: req.sessionId, taskId: req.taskId });
      }

      case 'checkpoint':
        if (TERMINAL_SESSION.has(state.sessionState)) return reject('SESSION_TERMINAL');
        return admit({ kind: 'checkpoint', sessionId: req.sessionId });

      default:
        return reject('NOT_APPLICABLE');
    }
  }
}

function admit(action: ControlAction): AdmissionResult {
  return { admitted: true, action };
}
function reject(reason: ControlRejectReason): AdmissionResult {
  return { admitted: false, reason };
}
