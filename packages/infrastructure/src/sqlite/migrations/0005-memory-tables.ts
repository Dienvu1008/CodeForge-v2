// Migration 0005 -- Phase 7 memory table (v5). P7-MS1.
// Additive-only: migrations v1-v4 are NOT touched.
// Single memory_records table keyed by kind + scope (PHASE_7_ROADMAP Appendix A).
import type { Migration } from './types.js';

const SCHEMA_V5 = `
CREATE TABLE memory_records (
  memory_id        TEXT PRIMARY KEY,
  kind             TEXT NOT NULL CHECK (kind IN
                     ('task_outcome','failure_pattern','project_note',
                      'user_preference','architecture_note')),
  scope            TEXT NOT NULL CHECK (scope IN ('project','session','global')),
  content          TEXT NOT NULL,
  tags_json        TEXT NOT NULL,
  provenance_json  TEXT NOT NULL,
  created_at       TEXT NOT NULL
);
CREATE INDEX idx_memory_scope_kind ON memory_records (scope, kind);
CREATE INDEX idx_memory_created ON memory_records (created_at);
`;

const ROLLBACK_V5 = `DROP TABLE IF EXISTS memory_records;`;

export const migration0005: Migration = {
  migrationId:  '0005_phase7_memory',
  fromVersion:  4,
  toVersion:    5,
  forwardOnly:  false,
  reversible:   true,
  description:  'Phase 7 memory_records table (single table keyed by kind + scope).',
  introducedIn: '0.7.0',
  apply(db):    void { db.exec(SCHEMA_V5); },
  rollback(db): void { db.exec(ROLLBACK_V5); },
};
