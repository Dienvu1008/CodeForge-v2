/*
 * Copyright 2026 DienVu (Dienvu1008)
 * SPDX-License-Identifier: Apache-2.0
 */

// goal-history.ts (P12.23) — PURE, OFFLINE-TESTABLE model for the Goals panel's conversational
// history. This is NOT a chatbot: each entry is ONE goal the user submitted, shown as a message,
// and the runtime "replies" with REAL progress (a session is created, tasks run, verification
// passes/fails). We do not run a free-form LLM dialogue — goal → mission → plan → task-graph →
// execute → verify stays the authority (that is CodeForge's whole value). The panel just renders
// the history + live status of those goals.
//
// The runtime already persists everything (goal → session → EventLog in SQLite), so there is no
// new store: we rebind queued goals to sessions returned by GET /sessions and derive status.

/** A session state as reported by GET /sessions (and the runtime projection). */
export type SessionState = string;

/** The lifecycle of a goal entry as the user sees it in the panel. */
export type GoalStatus = 'queued' | 'running' | 'completed' | 'failed';

/** One goal in the conversational history. */
export interface GoalEntry {
  /** Stable local id (assigned at submit time, before the runtime returns a goalId). */
  readonly localId: string;
  /** The goal text the user submitted. */
  readonly description: string;
  /** When the user submitted it (ISO). */
  readonly submittedAt: string;
  /** The runtime goalId once POST /goal returns it (used only for display). */
  readonly goalId?: string;
  /** The session this goal bound to once one appeared (used to show live progress). */
  readonly sessionId?: string;
  /** Derived status. */
  readonly status: GoalStatus;
}

/** A session summary we bind against (subset of SessionSummary). */
export interface BindableSession {
  readonly sessionId: string;
  readonly state: SessionState;
  readonly createdAt: string;
}

/** Map a session state string to a goal status. Unknown/active states → running. */
export function statusFromSessionState(state: SessionState): GoalStatus {
  const s = state.toUpperCase();
  if (s === 'COMPLETED' || s === 'SUCCEEDED' || s === 'DONE') return 'completed';
  if (s === 'FAILED' || s === 'ABORTED' || s === 'CANCELLED' || s === 'CANCELED') return 'failed';
  return 'running';
}

/**
 * Create a new queued entry. localId must be unique within the history (e.g. a counter or uuid).
 */
export function newGoalEntry(localId: string, description: string, submittedAt: string): GoalEntry {
  return { localId, description, submittedAt, status: 'queued' };
}

/** Record the runtime's goalId on a queued entry (does not change status). */
export function withGoalId(entry: GoalEntry, goalId: string): GoalEntry {
  return { ...entry, goalId };
}

/**
 * Reconcile the history against the latest sessions list. For each entry:
 *   - already bound to a session → refresh its status from that session's current state;
 *   - still queued → bind it to the oldest not-yet-claimed session created at/after it was
 *     submitted (first-come-first-served, so two goals map to two distinct sessions), and adopt
 *     that session's status.
 * Sessions already claimed by an earlier entry are not reused. Pure: returns a new array.
 */
export function reconcileHistory(
  history: readonly GoalEntry[],
  sessions: readonly BindableSession[],
): GoalEntry[] {
  const byId = new Map<string, BindableSession>();
  for (const s of sessions) byId.set(s.sessionId, s);

  // Sessions available for binding to a queued goal, oldest first.
  const claimed = new Set<string>(history.map((e) => e.sessionId).filter((x): x is string => x !== undefined));
  const unclaimed = sessions
    .filter((s) => !claimed.has(s.sessionId))
    .slice()
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  // Process entries in submit order so earlier goals claim earlier sessions.
  const ordered = history.slice().sort((a, b) => a.submittedAt.localeCompare(b.submittedAt));
  const result: GoalEntry[] = [];
  for (const entry of ordered) {
    if (entry.sessionId !== undefined) {
      const sess = byId.get(entry.sessionId);
      result.push(sess ? { ...entry, status: statusFromSessionState(sess.state) } : entry);
      continue;
    }
    // Bind to the first unclaimed session created no earlier than submit time.
    const idx = unclaimed.findIndex((s) => s.createdAt >= entry.submittedAt);
    if (idx >= 0) {
      const sess = unclaimed.splice(idx, 1)[0];
      result.push({ ...entry, sessionId: sess.sessionId, status: statusFromSessionState(sess.state) });
    } else {
      result.push(entry); // stays queued until a matching session shows up
    }
  }
  // Preserve the original (submit) order for stable rendering.
  result.sort((a, b) => a.submittedAt.localeCompare(b.submittedAt));
  return result;
}

/** A short status chip label for the UI. */
export function statusChip(status: GoalStatus): string {
  switch (status) {
    case 'queued': return 'queued';
    case 'running': return 'running';
    case 'completed': return 'completed';
    case 'failed': return 'failed';
  }
}
