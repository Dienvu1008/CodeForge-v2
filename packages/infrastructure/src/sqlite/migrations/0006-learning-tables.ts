// Migration 0006 -- Phase 11 learning table (v6). P11.2.
// Additive-only: migrations v1-v5 are NOT touched.
// Single learning_lessons table keyed by scope + kind (PHASE_11_ROADMAP §3.2).
import type { Migration } from './types.js';

const SCHEMA_V6 = `
CREATE TABLE learning_lessons (
  lesson_id        TEXT PRIMARY KEY,
  kind             TEXT NOT NULL CHECK (kind IN
                     ('recovery_outcome','failure_recurrence')),
  scope            TEXT NOT NULL CHECK (scope IN ('project','session','global')),
  lesson_key       TEXT NOT NULL,
  payload_json     TEXT NOT NULL,
  provenance_json  TEXT NOT NULL,
  created_at       TEXT NOT NULL
);
CREATE INDEX idx_lessons_scope_kind ON learning_lessons (scope, kind);
CREATE INDEX idx_lessons_created ON learning_lessons (created_at);
CREATE INDEX idx_lessons_key ON learning_lessons (lesson_key);
`;

const ROLLBACK_V6 = `DROP TABLE IF EXISTS learning_lessons;`;

export const migration0006: Migration = {
  migrationId:  '0006_phase11_learning',
  fromVersion:  5,
  toVersion:    6,
  forwardOnly:  false,
  reversible:   true,
  description:  'Phase 11 learning_lessons table (single table keyed by scope + kind).',
  introducedIn: '0.11.0',
  apply(db):    void { db.exec(SCHEMA_V6); },
  rollback(db): void { db.exec(ROLLBACK_V6); },
};
