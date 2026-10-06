// SessionStateControlGate (P9-I1) — bridges the SessionOrchestrator's cooperative
// ControlGate to admitted controls WITHOUT a second channel: it derives the pause/cancel
// signal from the AUTHORITATIVE session state (SessionRepository). Enforces OB-006 — the
// one source of truth is the session state the ControlPlane already drove via
// SessionService; the gate only observes it.
//
// Flow: a dashboard/Telegram "pause" -> ObservabilityService.submitControl -> ControlPlane
// admits -> SessionService transitions the session to PAUSED. The orchestrator loop polls
// this gate, sees PAUSED, parks via awaitResume, and continues when the session returns to
// RUNNING (resume) or aborts when it reaches CANCELLING/ABORTED (cancel).
import type { SessionRepository } from '@codeforge/agent-core';
import type { ControlGate, ControlSignal } from '@codeforge/agent-core';

export interface SessionStateControlGateOptions {
  readonly sessions: SessionRepository;
  /** Poll interval (ms) while parked in awaitResume. Default 50. */
  readonly pollIntervalMs?: number;
  /** Max time (ms) to wait for resume before treating it as a cancel. Default 60000. */
  readonly maxWaitMs?: number;
  /** Injected clock for the wait budget (ms since epoch). Default Date.now. */
  readonly nowMs?: () => number;
  /** Injected sleep (for tests). Default a real setTimeout. */
  readonly sleep?: (ms: number) => Promise<void>;
}

export class SessionStateControlGate implements ControlGate {
  private readonly pollIntervalMs: number;
  private readonly maxWaitMs: number;
  private readonly nowMs: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly opts: SessionStateControlGateOptions) {
    this.pollIntervalMs = opts.pollIntervalMs ?? 50;
    this.maxWaitMs = opts.maxWaitMs ?? 60000;
    this.nowMs = opts.nowMs ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** Derive the control signal from the current session state (read-only). */
  async poll(sessionId: string): Promise<ControlSignal> {
    const session = await this.opts.sessions.getById(sessionId);
    if (session === null) return { kind: 'none' };
    switch (session.state) {
      case 'PAUSED':     return { kind: 'pause' };
      case 'CANCELLING':
      case 'ABORTED':    return { kind: 'cancel' };
      default:           return { kind: 'none' };
    }
  }

  /**
   * Park until the session leaves PAUSED. Resolves 'resume' when it returns to a running
   * state, or 'cancel' when it reaches CANCELLING/ABORTED (or the wait budget expires —
   * fail-safe: a stuck pause is treated as a cancel rather than hanging the loop forever).
   */
  async awaitResume(sessionId: string): Promise<'resume' | 'cancel'> {
    const deadline = this.nowMs() + this.maxWaitMs;
    for (;;) {
      const session = await this.opts.sessions.getById(sessionId);
      if (session === null) return 'cancel';
      if (session.state === 'CANCELLING' || session.state === 'ABORTED') return 'cancel';
      if (session.state !== 'PAUSED') return 'resume';
      if (this.nowMs() >= deadline) return 'cancel';
      await this.sleep(this.pollIntervalMs);
    }
  }
}
