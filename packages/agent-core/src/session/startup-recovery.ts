/*
 * Copyright 2026 DienVu (Dienvu1008)
 * SPDX-License-Identifier: Apache-2.0
 */

// Startup recovery (session-resume v1) — what to do with sessions left behind by a runtime
// process that died (crash, Ctrl+C, reboot, VS Code reload).
//
// An ORPHANED session is non-terminal and owned by THIS host and a DEAD pid (the infrastructure
// OrphanSource does that filtering). Each orphan gets exactly one explicit decision:
//   - resume: it was parked in AWAITING_HUMAN on an open goal clarification BEFORE planning — the
//             runtime adopts it (fresh workspace lock) and waits again on the SAME request;
//   - abort:  anything else (mid-execution, awaiting tool approval, paused, …) is closed with a
//             reason instead of being left dangling.
//
// The decision is PURE (classifyOrphan / planRecovery). StartupRecovery only reads ports, calls the
// pure functions, and executes through SessionService — the single authority over session state
// (DC-002). No new session state or transition is introduced (SS-002); SS-001 is kept by resuming
// at most ONE session (the newest) and by adopt() acquiring the workspace lock.
import type { Session } from '../domain/session.js';
import type { DomainEvent, EventType } from '../domain/event.js';
import type { EventLog } from '../repositories/index.js';
import type { ClarificationRequest } from '../mission/goal-clarification.js';
import type { SessionService } from './session-service.js';

/** Everything the classifier needs to know about one orphaned session (read-only snapshot). */
export interface OrphanSnapshot {
  readonly session: Pick<Session, 'sessionId' | 'state' | 'createdAt' | 'metadata'>;
  /** The latest GOAL_CLARIFICATION_REQUESTED with no ANSWERED for the same requestId, if any. */
  readonly openClarification?: { readonly missionId: string; readonly request: ClarificationRequest };
  /** True when the current graph is still the empty seed (v1, no nodes) — planning never started. */
  readonly graphIsSeedOnly: boolean;
  /** True when the session's Goal was persisted (goal_queue row bound to the session). */
  readonly goalPersisted: boolean;
  /** True when a tool call of the session is waiting for an approval decision. */
  readonly pendingToolApproval: boolean;
}

export type OrphanDecision =
  | { readonly kind: 'resume' }
  | { readonly kind: 'abort'; readonly reason: string };

export interface RecoveryOptions {
  /** Whether this runtime has the clarification gate wired (--mission on --clarify on). */
  readonly clarifyEnabled: boolean;
}

function stateReason(state: string): string {
  switch (state) {
    case 'RUNNING': return 'runtime restarted during execution';
    case 'PAUSED': return 'runtime restarted while paused';
    case 'CANCELLING': return 'runtime restarted while cancelling';
    case 'CREATED':
    case 'INITIALIZING': return 'runtime restarted while the session was starting';
    default: return `runtime restarted while ${state}`;
  }
}

/**
 * PURE. Decide resume vs abort for one orphan. Checks run in a fixed order; the FIRST violated
 * condition gives the abort reason (design C4 table).
 */
export function classifyOrphan(o: OrphanSnapshot, opts: RecoveryOptions): OrphanDecision {
  if (o.session.state !== 'AWAITING_HUMAN') return { kind: 'abort', reason: stateReason(o.session.state) };
  if (o.pendingToolApproval) return { kind: 'abort', reason: 'runtime restarted while awaiting tool approval' };
  if (o.openClarification === undefined) {
    return { kind: 'abort', reason: 'runtime restarted while awaiting a human decision' };
  }
  if (!o.graphIsSeedOnly) return { kind: 'abort', reason: 'runtime restarted after planning had started' };
  if (!o.goalPersisted) return { kind: 'abort', reason: 'goal was not persisted (session predates resume support)' };
  if (!opts.clarifyEnabled) {
    return { kind: 'abort', reason: 'clarification gate is disabled on this runtime (--clarify off)' };
  }
  return { kind: 'resume' };
}

export const SUPERSEDED_REASON = 'superseded by a newer resumable session';

export interface PlannedRecovery {
  readonly snapshot: OrphanSnapshot;
  readonly decision: OrphanDecision;
}

/**
 * PURE. One decision per snapshot (same order as the input). At most one resume: the resumable
 * snapshot with the newest createdAt (ties → the later one in input order); the others are
 * demoted to abort (SS-001: one active session per workspace).
 */
export function planRecovery(orphans: readonly OrphanSnapshot[], opts: RecoveryOptions): readonly PlannedRecovery[] {
  const decided = orphans.map((snapshot) => ({ snapshot, decision: classifyOrphan(snapshot, opts) }));
  let winner = -1;
  decided.forEach((d, i) => {
    if (d.decision.kind !== 'resume') return;
    if (winner === -1 || d.snapshot.session.createdAt >= (decided[winner] as PlannedRecovery).snapshot.session.createdAt) {
      winner = i;
    }
  });
  return decided.map((d, i) => (d.decision.kind === 'resume' && i !== winner
    ? { snapshot: d.snapshot, decision: { kind: 'abort', reason: SUPERSEDED_REASON } as const }
    : d));
}

// ── Effectful shell over ports ───────────────────────────────────────────────

/** Lists this workspace's orphaned sessions (this host + dead pid). Implemented in infrastructure. */
export interface OrphanSource {
  listOrphans(): Promise<readonly OrphanSnapshot[]>;
}

export interface ResumePlan {
  readonly sessionId: string;
  readonly missionId: string;
  readonly request: ClarificationRequest;
  readonly previousProcessId: number;
}

export interface StartupRecoveryOutcome {
  readonly resume?: ResumePlan;
  readonly aborted: readonly { readonly sessionId: string; readonly reason: string }[];
  /** Orphans whose recovery step failed (logged, never blocks startup). */
  readonly errors: readonly { readonly sessionId: string; readonly message: string }[];
  /** Set when a resumable session was left alone because a live runtime holds the workspace lock. */
  readonly skippedResume?: { readonly sessionId: string; readonly message: string };
}

export interface StartupRecoveryDeps {
  readonly orphans: OrphanSource;
  readonly sessionService: Pick<SessionService, 'transition' | 'adopt'>;
  readonly events: EventLog;
  readonly now: () => string;
  readonly nextId: () => string;
}

export interface StartupRecoverInput extends RecoveryOptions {
  readonly hostname: string;
  readonly processId: number;
  readonly newLockId: () => string;
}

export class StartupRecovery {
  constructor(private readonly deps: StartupRecoveryDeps) {}

  /** Decide + execute recovery for every orphan. Never throws. */
  async recover(input: StartupRecoverInput): Promise<StartupRecoveryOutcome> {
    let orphans: readonly OrphanSnapshot[];
    try {
      orphans = await this.deps.orphans.listOrphans();
    } catch (err) {
      return { aborted: [], errors: [{ sessionId: '*', message: messageOf(err) }] };
    }
    const plan = planRecovery(orphans, input);
    const aborted: { sessionId: string; reason: string }[] = [];
    const errors: { sessionId: string; message: string }[] = [];
    let resume: ResumePlan | undefined;
    let skippedResume: { sessionId: string; message: string } | undefined;

    // Aborts first, so a resumed session never coexists with another live one.
    for (const { snapshot, decision } of plan) {
      if (decision.kind !== 'abort') continue;
      const sid = snapshot.session.sessionId;
      try {
        await this.emit(sid, 'SESSION_RECOVERY_DECIDED', {
          decision: 'abort', reason: decision.reason, previousProcessId: snapshot.session.metadata.processId,
        });
        await this.deps.sessionService.transition(sid, 'ABORT');
        aborted.push({ sessionId: sid, reason: decision.reason });
      } catch (err) {
        errors.push({ sessionId: sid, message: messageOf(err) });
      }
    }

    const chosen = plan.find((p) => p.decision.kind === 'resume');
    if (chosen !== undefined && chosen.snapshot.openClarification !== undefined) {
      const sid = chosen.snapshot.session.sessionId;
      const previousProcessId = chosen.snapshot.session.metadata.processId;
      try {
        await this.deps.sessionService.adopt({
          sessionId: sid, lockId: input.newLockId(), hostname: input.hostname, processId: input.processId,
        });
        await this.emit(sid, 'SESSION_RECOVERY_DECIDED', {
          decision: 'resume', reason: 'awaiting goal clarification before planning', previousProcessId,
        });
        resume = {
          sessionId: sid,
          missionId: chosen.snapshot.openClarification.missionId,
          request: chosen.snapshot.openClarification.request,
          previousProcessId,
        };
      } catch (err) {
        // LOCK_HELD: a LIVE runtime owns this workspace — leave the session untouched (Req 2.2).
        skippedResume = { sessionId: sid, message: messageOf(err) };
      }
    }

    return {
      aborted, errors,
      ...(resume !== undefined ? { resume } : {}),
      ...(skippedResume !== undefined ? { skippedResume } : {}),
    };
  }

  private async emit(sessionId: string, type: EventType, payload: unknown): Promise<void> {
    const event: DomainEvent = {
      eventId: this.deps.nextId(),
      sessionId,
      type,
      aggregate: { kind: 'session', id: sessionId },
      payload,
      at: this.deps.now(),
      sequenceNumber: 0, // EventLog is the sequence authority (CP-008)
    };
    await this.deps.events.append(event);
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}