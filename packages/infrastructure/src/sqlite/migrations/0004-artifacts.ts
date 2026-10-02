// Migration 0004 -- Phase 3 artifacts table (v4). P3-AS1.
// Additive-only: migrations v1-v3 are NOT touched.
// The artifacts table stores metadata only; binary content lives on disk.
import type { Migration } from './types.js';

const SCHEMA_V4 = `
CREATE TABLE artifacts (
  artifact_id   TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('log','stdout','stderr','patch','test_result','other')),
  content_type  TEXT NOT NULL,
  size_bytes    INTEGER NOT NULL,
  storage_path  TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions (session_id)
);
CREATE INDEX idx_artifacts_session ON artifacts (session_id);
`;

const ROLLBACK_V4 = `DROP TABLE IF EXISTS artifacts;`;

export const migration0004: Migration = {
  migrationId:  '0004_phase3_artifacts',
  fromVersion:  3,
  toVersion:    4,
  forwardOnly:  false,
  reversible:   true,
  description:  'Phase 3 artifacts table (metadata-only; binary content on disk).',
  introducedIn: '0.4.0',
  apply(db):    void { db.exec(SCHEMA_V4); },
  rollback(db): void { db.exec(ROLLBACK_V4); },
};
