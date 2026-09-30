// Migration 0003 -- Phase 2 context tables (v3). P2-DB3, CONTEXT_SPEC §12.
//
// Additive-only: migrations v1/v2 are NOT touched.
// New tables (all append-only per CX-001, PR-003):
//   - context_snapshots   -- ContextSnapshot header (CX-001: immutable + versioned)
//   - context_items       -- ContextItem rows (CX-003: trust field required)
//   - context_provenance  -- per-item provenance records (CX-002, PR-002)
import type { Migration } from './types.js';

const SCHEMA_V3 = `
-- context_snapshots (CONTEXT_SPEC §12.1, DOMAIN_CONTRACTS §14)
-- Append-only: snapshot is immutable after creation (CX-001).
CREATE TABLE context_snapshots (
  snapshot_id            TEXT PRIMARY KEY,
  session_id             TEXT NOT NULL,
  task_id                TEXT,
  task_run_id            TEXT,
  workspace_revision_id  TEXT NOT NULL,
  canonical_form_version TEXT NOT NULL,
  token_budget           INTEGER NOT NULL,
  token_used             INTEGER NOT NULL,
  built_by               TEXT NOT NULL,
  build_reason           TEXT NOT NULL,
  policy_version         INTEGER NOT NULL,
  built_at               TEXT NOT NULL,
  schema_version         INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions (session_id)
);
CREATE INDEX idx_ctx_snap_session  ON context_snapshots (session_id);
CREATE INDEX idx_ctx_snap_task     ON context_snapshots (task_id);
CREATE INDEX idx_ctx_snap_revision ON context_snapshots (workspace_revision_id);

-- context_items (CONTEXT_SPEC §12.1)
-- Append-only (CX-001). trust field is NOT NULL -- every item must be marked (CX-003).
CREATE TABLE context_items (
  item_id              TEXT PRIMARY KEY,
  snapshot_id          TEXT NOT NULL,
  kind                 TEXT NOT NULL,
  source_kind          TEXT NOT NULL,
  source_path          TEXT,
  source_range_start   INTEGER,
  source_range_end     INTEGER,
  source_revision_id   TEXT,
  source_artifact_id   TEXT,
  source_symbol_name   TEXT,
  content              TEXT NOT NULL,
  token_count          INTEGER NOT NULL,
  trust                TEXT NOT NULL CHECK (trust IN ('trusted','untrusted')),
  reason               TEXT NOT NULL,
  priority             INTEGER NOT NULL,
  pinned               INTEGER NOT NULL CHECK (pinned IN (0,1)),
  truncated            INTEGER NOT NULL CHECK (truncated IN (0,1)),
  truncation_note      TEXT,
  FOREIGN KEY (snapshot_id) REFERENCES context_snapshots (snapshot_id)
);
CREATE INDEX idx_ctx_items_snapshot ON context_items (snapshot_id);

-- context_provenance (CONTEXT_SPEC §12.1, PR-002)
-- Append-only. Every item must have a provenance record (CX-002).
CREATE TABLE context_provenance (
  provenance_id        TEXT PRIMARY KEY,
  snapshot_id          TEXT NOT NULL,
  item_id              TEXT NOT NULL,
  retrieved_by         TEXT NOT NULL,
  reason               TEXT NOT NULL,
  at                   TEXT NOT NULL,
  original_token_count INTEGER,
  final_token_count    INTEGER NOT NULL,
  truncated            INTEGER NOT NULL CHECK (truncated IN (0,1)),
  compaction_method    TEXT,
  FOREIGN KEY (snapshot_id) REFERENCES context_snapshots (snapshot_id),
  FOREIGN KEY (item_id) REFERENCES context_items (item_id)
);
CREATE INDEX idx_ctx_prov_snapshot ON context_provenance (snapshot_id);
CREATE INDEX idx_ctx_prov_item     ON context_provenance (item_id);
`;

const ROLLBACK_V3 = `
DROP TABLE IF EXISTS context_provenance;
DROP TABLE IF EXISTS context_items;
DROP TABLE IF EXISTS context_snapshots;
`;

export const migration0003: Migration = {
  migrationId:  '0003_phase2_context_tables',
  fromVersion:  2,
  toVersion:    3,
  forwardOnly:  false,
  reversible:   true,
  description:  'Phase 2 context tables: context_snapshots, context_items, context_provenance.',
  introducedIn: '0.3.0',

  apply(db): void {
    db.exec(SCHEMA_V3);
  },

  rollback(db): void {
    db.exec(ROLLBACK_V3);
  },
};
