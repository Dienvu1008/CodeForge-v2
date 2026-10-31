/*
 * Copyright 2026 DienVu (Dienvu1008)
 * SPDX-License-Identifier: Apache-2.0
 */

// Migration 0007 -- session-resume v1: durable goal queue (v7).
// Additive-only: migrations v1-v6 are NOT touched.
// goal_queue holds the FIFO order and QUEUED/STARTED status of goals submitted to the runtime, so
// queued goals survive a restart and a goal is never run twice (it flips to STARTED, bound to its
// sessionId, in the same transaction that takes it off the queue). The Goal itself lives in the
// existing `goals` table (v1).
import type { Migration } from './types.js';

const SCHEMA_V7 = `
CREATE TABLE goal_queue (
  goal_id              TEXT NOT NULL PRIMARY KEY,
  goal_version         INTEGER NOT NULL,
  workspace_id         TEXT NOT NULL,
  seq                  INTEGER NOT NULL,
  status               TEXT NOT NULL CHECK (status IN ('QUEUED','STARTED')),
  enqueued_at          TEXT NOT NULL,
  session_id           TEXT,
  started_at           TEXT,
  start_revision_hash  TEXT,
  FOREIGN KEY (goal_id, goal_version) REFERENCES goals (goal_id, version)
);
CREATE INDEX idx_goal_queue_ws_status_seq ON goal_queue (workspace_id, status, seq);
CREATE INDEX idx_goal_queue_session ON goal_queue (session_id);
`;

const ROLLBACK_V7 = `DROP TABLE IF EXISTS goal_queue;`;

export const migration0007: Migration = {
  migrationId:  '0007_session_resume_goal_queue',
  fromVersion:  6,
  toVersion:    7,
  forwardOnly:  false,
  reversible:   true,
  description:  'session-resume v1: durable goal_queue (FIFO + QUEUED/STARTED + start revision).',
  introducedIn: '0.12.0',
  apply(db):    void { db.exec(SCHEMA_V7); },
  rollback(db): void { db.exec(ROLLBACK_V7); },
};