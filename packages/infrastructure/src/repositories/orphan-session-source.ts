/*
 * Copyright 2026 DienVu (Dienvu1008)
 * SPDX-License-Identifier: Apache-2.0
 */

// SqliteOrphanSource (session-resume v1) — the read-only OrphanSource for StartupRecovery.
//
// Lists this workspace's NON-TERMINAL sessions whose recorded owner is THIS host and a DEAD pid
// (the same liveness rule reclaimStale uses), and builds the snapshot the pure classifier needs:
//   - openClarification: latest GOAL_CLARIFICATION_REQUESTED with no ANSWERED for its requestId,
//     rebuilt from the event payload (malformed ⇒ treated as absent ⇒ the session is closed);
//   - graphIsSeedOnly:   the current graph is still the empty seed (v1, no nodes);
//   - goalPersisted:     a goal_queue row is bound to the session (migration 0007);
//   - pendingToolApproval: a tool call is APPROVAL_PENDING.
// It never writes. Sessions of a live process or another host are never returned (Req 2.2).
import type {
  ClarificationRequest,
  DomainEvent,
  EventLog,
  OpenQuestion,
  OrphanSnapshot,
  OrphanSource,
  TaskGraphRepository,
} from '@codeforge/agent-core';
import type { DatabaseAdapter } from '../sqlite/types.js';
import type { SqliteSessionRepository } from './session-repository.js';

export interface SqliteOrphanSourceOptions {
  readonly db: DatabaseAdapter;
  readonly workspaceId: string;
  readonly hostname: string;
  /** Liveness check for a recorded pid (true = still running). */
  readonly isAlive: (pid: number) => boolean;
  readonly sessions: Pick<SqliteSessionRepository, 'getById'>;
  readonly graphs: Pick<TaskGraphRepository, 'getCurrent'>;
  readonly events: Pick<EventLog, 'query'>;
}

export class SqliteOrphanSource implements OrphanSource {
  constructor(private readonly opts: SqliteOrphanSourceOptions) {}

  async listOrphans(): Promise<readonly OrphanSnapshot[]> {
    const { db, workspaceId, hostname, isAlive } = this.opts;
    const ids = db.query<{ session_id: string }>(
      `SELECT session_id FROM sessions
        WHERE workspace_id = ? AND state NOT IN ('COMPLETED','ABORTED')
        ORDER BY created_at ASC`,
      [workspaceId],
    );
    const out: OrphanSnapshot[] = [];
    for (const { session_id: sid } of ids) {
      const s = await this.opts.sessions.getById(sid);
      if (s === null) continue;
      if (s.metadata.hostname !== hostname) continue; // another machine — never touch
      if (isAlive(s.metadata.processId)) continue;    // live owner — not orphaned
      const events = await this.opts.events.query({ sessionId: sid });
      const openClarification = findOpenClarification(events);
      out.push({
        session: { sessionId: s.sessionId, state: s.state, createdAt: s.createdAt, metadata: s.metadata },
        ...(openClarification !== undefined ? { openClarification } : {}),
        graphIsSeedOnly: await this.isSeedOnly(sid),
        goalPersisted: db.query<{ c: number }>('SELECT COUNT(*) AS c FROM goal_queue WHERE session_id = ?', [sid])[0]?.c === 1,
        pendingToolApproval: (db.query<{ c: number }>(
          "SELECT COUNT(*) AS c FROM tool_calls WHERE session_id = ? AND state = 'APPROVAL_PENDING'", [sid],
        )[0]?.c ?? 0) > 0,
      });
    }
    return out;
  }

  private async isSeedOnly(sessionId: string): Promise<boolean> {
    try {
      const g = await this.opts.graphs.getCurrent(sessionId);
      return g.version === 1 && g.nodes.length === 0;
    } catch {
      return false; // no graph at all — not the expected pre-planning shape
    }
  }
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function parseQuestion(raw: unknown): OpenQuestion | null {
  const q = asRecord(raw);
  if (q === null || typeof q['id'] !== 'string' || q['id'] === '' || typeof q['text'] !== 'string') return null;
  const opts = Array.isArray(q['suggestedOptions'])
    ? (q['suggestedOptions'] as unknown[]).filter((o): o is string => typeof o === 'string')
    : [];
  return opts.length > 0 ? { id: q['id'], text: q['text'], suggestedOptions: opts } : { id: q['id'], text: q['text'] };
}

/** Latest REQUESTED (valid payload) with no ANSWERED for its requestId — same rule as the Goals panel. */
export function findOpenClarification(
  events: readonly DomainEvent[],
): { readonly missionId: string; readonly request: ClarificationRequest } | undefined {
  const answered = new Set<string>();
  for (const e of events) {
    if (e.type !== 'GOAL_CLARIFICATION_ANSWERED') continue;
    const id = asRecord(e.payload)?.['requestId'];
    if (typeof id === 'string') answered.add(id);
  }
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i] as DomainEvent;
    if (e.type !== 'GOAL_CLARIFICATION_REQUESTED') continue;
    const p = asRecord(e.payload);
    if (p === null) continue;
    const { requestId, missionId, goalId, openQuestions } = p;
    if (typeof requestId !== 'string' || requestId === '' || typeof missionId !== 'string' || typeof goalId !== 'string') continue;
    if (!Array.isArray(openQuestions) || openQuestions.length === 0) continue;
    const questions = openQuestions.map(parseQuestion);
    if (questions.some((q) => q === null)) continue;
    if (answered.has(requestId)) continue;
    return { missionId, request: { requestId, missionId, goalId, openQuestions: questions as OpenQuestion[] } };
  }
  return undefined;
}