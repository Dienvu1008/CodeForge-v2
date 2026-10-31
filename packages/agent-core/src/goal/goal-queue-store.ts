/*
 * Copyright 2026 DienVu (Dienvu1008)
 * SPDX-License-Identifier: Apache-2.0
 */

// GoalQueueStore (session-resume v1) — durable backing for GoalIngressService's FIFO queue, so
// goals submitted to the runtime survive a restart. SYNCHRONOUS on purpose (SQLite is synchronous
// and POST /goal returns the queue position synchronously).
//
// Never-run-twice rule: claimNext() flips the oldest QUEUED goal to STARTED, bound to the caller's
// sessionId, in ONE atomic step. A crash after the claim but before the session exists loses that
// goal rather than running it twice — the deliberate trade-off (design decision 5).
import type { Goal } from '../domain/goal.js';

export interface GoalQueueStore {
  /** Persist the Goal (goals table) + a QUEUED queue row, atomically. */
  enqueue(goal: Goal, at: string): void;
  /** Oldest QUEUED goal → STARTED with `sessionId`, atomically. undefined when the queue is empty. */
  claimNext(sessionId: string, at: string): Goal | undefined;
  /** Record the workspace revision hash the session started from (for resume's workspaceChanged). */
  recordStartRevision(sessionId: string, revisionHash: string): void;
  /** The goal (and recorded start revision) bound to a session, or null when none was recorded. */
  getBySession(sessionId: string): { readonly goal: Goal; readonly startRevisionHash?: string } | null;
  /** Number of goals still QUEUED. */
  queuedCount(): number;
}