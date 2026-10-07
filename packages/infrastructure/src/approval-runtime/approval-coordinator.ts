// NodeApprovalCoordinator (P10.5) — the human-in-the-loop bridge for tool approval.
//
// When the ToolPolicy flags a tool call as APPROVAL_PENDING (e.g. run_command under
// autonomy='edits'), the TaskExecutor asks this coordinator to wait for a human decision.
// The coordinator:
//   1. drives the session to AWAITING_HUMAN (SessionService — the single authority),
//   2. polls the authoritative tool-call state until a human approves/denies it via the
//      ControlPlane → ObservabilityService.toolControl → ToolGateway.approve/deny
//      (APPROVAL_PENDING → APPROVED | DENIED), or the wait budget expires,
//   3. returns the session to RUNNING (HUMAN_DECIDED, SS-007 humanDecisionRecorded),
//   4. reports the decision.
//
// It introduces NO second authority: it only reads the tool-call state the ToolGateway
// drives, and transitions the session through SessionService exactly like the control
// gate does for pause/resume (OB-006).
import type { ApprovalCoordinator, ApprovalDecision } from '@codeforge/agent-core';

/** Minimal read port over the ToolCall store (just the state we poll). */
export interface ToolCallStateReader {
  getById(toolCallId: string): Promise<{ state: string } | null>;
}

/** Minimal session transition port (SessionService satisfies this). */
export interface SessionTransitionPort {
  transition(sessionId: string, event: string, ctx?: Record<string, unknown>): Promise<unknown>;
}

export interface NodeApprovalCoordinatorOptions {
  readonly toolCalls: ToolCallStateReader;
  readonly sessionService: SessionTransitionPort;
  /** Poll interval (ms) while awaiting the decision. Default 300. */
  readonly pollIntervalMs?: number;
  /** Max time (ms) to wait for a human decision before 'timeout'. Default 3,600,000 (1h). */
  readonly maxWaitMs?: number;
  readonly nowMs?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export class NodeApprovalCoordinator implements ApprovalCoordinator {
  private readonly pollIntervalMs: number;
  private readonly maxWaitMs: number;
  private readonly nowMs: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly opts: NodeApprovalCoordinatorOptions) {
    this.pollIntervalMs = opts.pollIntervalMs ?? 300;
    this.maxWaitMs = opts.maxWaitMs ?? 3_600_000;
    this.nowMs = opts.nowMs ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async awaitDecision(sessionId: string, toolCallId: string): Promise<ApprovalDecision> {
    // 1. Session → AWAITING_HUMAN (best-effort; if it is already there, continue).
    try {
      await this.opts.sessionService.transition(sessionId, 'HUMAN_REQUIRED');
    } catch {
      // Not in RUNNING (e.g. another pending approval already moved it) — proceed to wait.
    }

    // 2. Poll the authoritative tool-call state until the human decides, or we time out.
    const deadline = this.nowMs() + this.maxWaitMs;
    let decision: ApprovalDecision = 'timeout';
    for (;;) {
      const call = await this.opts.toolCalls.getById(toolCallId);
      const state = call?.state;
      if (state === 'APPROVED') { decision = 'approved'; break; }
      if (state === 'DENIED')   { decision = 'denied';   break; }
      if (this.nowMs() >= deadline) { decision = 'timeout'; break; }
      await this.sleep(this.pollIntervalMs);
    }

    // 3. Session → RUNNING (SS-007: a decision has been recorded). Best-effort: the
    //    session may already have been cancelled/aborted by the human instead.
    try {
      await this.opts.sessionService.transition(sessionId, 'HUMAN_DECIDED', { humanDecisionRecorded: true });
    } catch {
      // Session not resumable (cancelled/aborted) — the decision still stands.
    }

    return decision;
  }
}
