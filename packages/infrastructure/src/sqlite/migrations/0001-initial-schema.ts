// Migration 0001 — initial schema (v1). MIGRATION_SPEC §5.2, DOMAIN_CONTRACTS §2-§20.
//
// Design: queryable identity/reference/state fields are real columns (indexable,
// FK-enforceable). Structured sub-objects and collections (metadata, limits,
// workspaceRevision snapshots, arrays) are JSON TEXT columns — the runtime owns
// (de)serialization. Every entity row carries schema_version for forward migration.
//
// Roadmap hooks (nullable, unused in Phase 1 but wired now to avoid a later rename):
//   - tool_calls.before_content / after_content  → diff view (Phase 3+ UX)
//   - sessions.capability_set / tasks.capability_set → scoped-permission (Phase 3+)
import type { Migration } from './types.js';

const SCHEMA_V1 = `
-- ── sessions (DOMAIN_CONTRACTS §2) ───────────────────────────────────────────
CREATE TABLE sessions (
  session_id       TEXT PRIMARY KEY,
  workspace_id     TEXT NOT NULL,
  workspace_root   TEXT NOT NULL,
  goal_id          TEXT NOT NULL,
  graph_version    INTEGER NOT NULL,
  state            TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  runtime_version  TEXT NOT NULL,
  schema_version   INTEGER NOT NULL,
  budget_id        TEXT NOT NULL,
  lock_id          TEXT NOT NULL,
  metadata_json    TEXT NOT NULL,     -- SessionMetadata
  capability_set   TEXT,              -- roadmap hook (Phase 3+); NULL = full
  version          INTEGER NOT NULL DEFAULT 1  -- optimistic lock
);
CREATE INDEX idx_sessions_workspace ON sessions (workspace_id);
CREATE INDEX idx_sessions_state ON sessions (state);

-- ── goals (DOMAIN_CONTRACTS §3) — immutable, versioned ───────────────────────
CREATE TABLE goals (
  goal_id               TEXT NOT NULL,
  version               INTEGER NOT NULL,
  description           TEXT NOT NULL,
  constraints_json      TEXT NOT NULL,
  acceptance_json       TEXT NOT NULL,
  created_at            TEXT NOT NULL,
  created_by            TEXT NOT NULL,
  superseded_by         TEXT,
  schema_version        INTEGER NOT NULL,
  PRIMARY KEY (goal_id, version)
);

-- ── tasks (DOMAIN_CONTRACTS §4) — immutable intent, NO deps/state here ────────
CREATE TABLE tasks (
  task_id          TEXT PRIMARY KEY,
  description      TEXT NOT NULL,
  acceptance_json  TEXT NOT NULL,
  constraints_json TEXT NOT NULL,
  priority         INTEGER NOT NULL,
  strategy_json    TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  created_by       TEXT NOT NULL,
  superseded_by    TEXT,             -- taskId of superseding task
  capability_set   TEXT,             -- roadmap hook (Phase 3+); NULL = full
  schema_version   INTEGER NOT NULL,
  FOREIGN KEY (superseded_by) REFERENCES tasks (task_id)
);

-- ── task_executions (DOMAIN_CONTRACTS §5) — mutable projection ────────────────
CREATE TABLE task_executions (
  task_id                 TEXT PRIMARY KEY,
  current_state           TEXT NOT NULL,
  current_run_id          TEXT,
  attempts                INTEGER NOT NULL,
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL,
  latest_verification_id  TEXT,
  latest_failure_id       TEXT,
  version                 INTEGER NOT NULL DEFAULT 1,  -- optimistic lock
  FOREIGN KEY (task_id) REFERENCES tasks (task_id)
);
CREATE INDEX idx_task_exec_state ON task_executions (current_state);

-- ── task_runs (DOMAIN_CONTRACTS §6) — immutable after finalize ────────────────
CREATE TABLE task_runs (
  task_run_id                    TEXT PRIMARY KEY,
  task_id                        TEXT NOT NULL,
  session_id                     TEXT NOT NULL,
  attempt_number                 INTEGER NOT NULL,
  state                          TEXT NOT NULL,
  graph_version_at_start         INTEGER NOT NULL,
  workspace_revision_start_json  TEXT NOT NULL,   -- WorkspaceRevision snapshot
  workspace_revision_end_json    TEXT,
  strategy_used_json             TEXT NOT NULL,
  context_snapshot_id            TEXT,
  started_at                     TEXT NOT NULL,
  ended_at                       TEXT,
  tool_calls_json                TEXT NOT NULL,   -- ordered toolCallIds
  failures_json                  TEXT NOT NULL,   -- failureIds
  verification_id                TEXT,
  budget_consumed_json           TEXT NOT NULL,   -- BudgetConsumption
  schema_version                 INTEGER NOT NULL,
  FOREIGN KEY (task_id) REFERENCES tasks (task_id),
  FOREIGN KEY (session_id) REFERENCES sessions (session_id)
);
CREATE INDEX idx_task_runs_task ON task_runs (task_id);
CREATE INDEX idx_task_runs_session ON task_runs (session_id);

-- ── task_graph_versions (GRAPH_PROTOCOL §2) — versioned graph header ──────────
CREATE TABLE task_graph_versions (
  graph_id              TEXT NOT NULL,
  session_id            TEXT NOT NULL,
  version               INTEGER NOT NULL,
  parent_version        INTEGER,
  created_at            TEXT NOT NULL,
  created_by            TEXT NOT NULL,
  mutation_id           TEXT,
  canonical_hash        TEXT NOT NULL,
  schema_version        INTEGER NOT NULL,
  canonical_form_version TEXT NOT NULL,
  PRIMARY KEY (session_id, version),
  FOREIGN KEY (session_id) REFERENCES sessions (session_id)
);

-- ── task_graph_nodes (GRAPH_PROTOCOL §2) ─────────────────────────────────────
CREATE TABLE task_graph_nodes (
  session_id       TEXT NOT NULL,
  graph_version    INTEGER NOT NULL,
  task_id          TEXT NOT NULL,
  added_in_version INTEGER NOT NULL,
  PRIMARY KEY (session_id, graph_version, task_id),
  FOREIGN KEY (session_id, graph_version)
    REFERENCES task_graph_versions (session_id, version)
);

-- ── task_graph_edges (GRAPH_PROTOCOL §2) ─────────────────────────────────────
CREATE TABLE task_graph_edges (
  edge_id          TEXT NOT NULL,
  session_id       TEXT NOT NULL,
  graph_version    INTEGER NOT NULL,
  from_task_id     TEXT NOT NULL,
  to_task_id       TEXT NOT NULL,
  kind             TEXT NOT NULL CHECK (kind IN ('depends_on', 'blocks', 'supersedes')),
  added_in_version INTEGER NOT NULL,
  PRIMARY KEY (session_id, graph_version, edge_id),
  FOREIGN KEY (session_id, graph_version)
    REFERENCES task_graph_versions (session_id, version)
);
CREATE INDEX idx_edges_from ON task_graph_edges (session_id, graph_version, from_task_id);
CREATE INDEX idx_edges_to ON task_graph_edges (session_id, graph_version, to_task_id);

-- ── graph_mutations (GRAPH_PROTOCOL §4) ──────────────────────────────────────
CREATE TABLE graph_mutations (
  mutation_id        TEXT PRIMARY KEY,
  session_id         TEXT NOT NULL,
  base_version       INTEGER NOT NULL,
  operations_json    TEXT NOT NULL,   -- GraphOperation[]
  proposed_by        TEXT NOT NULL,
  reason             TEXT NOT NULL,
  provenance_json    TEXT NOT NULL,
  created_at         TEXT NOT NULL,
  status             TEXT NOT NULL CHECK (status IN ('PROPOSED','VALIDATED','REJECTED','COMMITTED')),
  validation_errors_json TEXT,
  committed_version  INTEGER,
  committed_at       TEXT,
  FOREIGN KEY (session_id) REFERENCES sessions (session_id)
);
CREATE INDEX idx_mutations_session ON graph_mutations (session_id);

-- ── budgets (DOMAIN_CONTRACTS §15) — hierarchical ────────────────────────────
CREATE TABLE budgets (
  budget_id         TEXT PRIMARY KEY,
  scope             TEXT NOT NULL CHECK (scope IN ('session','task','task_run','recovery','verification')),
  scope_id          TEXT NOT NULL,
  parent_budget_id  TEXT,
  limits_json       TEXT NOT NULL,
  consumed_json     TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  version           INTEGER NOT NULL DEFAULT 1,  -- optimistic lock
  FOREIGN KEY (parent_budget_id) REFERENCES budgets (budget_id)
);
CREATE INDEX idx_budgets_scope ON budgets (scope, scope_id);

-- ── tool_calls (DOMAIN_CONTRACTS §12) ────────────────────────────────────────
CREATE TABLE tool_calls (
  tool_call_id     TEXT PRIMARY KEY,
  session_id       TEXT NOT NULL,
  task_id          TEXT,
  task_run_id      TEXT,
  tool_name        TEXT NOT NULL,
  tool_version     TEXT NOT NULL,
  risk_class       TEXT NOT NULL,
  arguments_json   TEXT NOT NULL,
  arguments_hash   TEXT NOT NULL,
  idempotency_key  TEXT,
  state            TEXT NOT NULL,
  approval_json    TEXT,
  result_json      TEXT,
  proposed_by      TEXT NOT NULL,
  provenance_json  TEXT NOT NULL,
  requested_at     TEXT NOT NULL,
  started_at       TEXT,
  ended_at         TEXT,
  before_content   TEXT,             -- roadmap hook: diff view (Phase 3+)
  after_content    TEXT,             -- roadmap hook: diff view (Phase 3+)
  schema_version   INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions (session_id)
);
CREATE INDEX idx_tool_calls_session ON tool_calls (session_id);
CREATE INDEX idx_tool_calls_run ON tool_calls (task_run_id);

-- ── verification_reports (DOMAIN_CONTRACTS §9) — append-only ──────────────────
CREATE TABLE verification_reports (
  verification_id         TEXT PRIMARY KEY,
  session_id              TEXT NOT NULL,
  task_id                 TEXT NOT NULL,
  task_run_id             TEXT NOT NULL,
  target_revision_json    TEXT NOT NULL,   -- WorkspaceRevision
  canonical_form_version  TEXT NOT NULL,
  scope                   TEXT NOT NULL,
  checks_json             TEXT NOT NULL,
  status                  TEXT NOT NULL,
  started_at              TEXT NOT NULL,
  ended_at                TEXT NOT NULL,
  tool_versions_json      TEXT NOT NULL,
  artifacts_json          TEXT NOT NULL,
  invariants_json         TEXT NOT NULL,
  schema_version          INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions (session_id)
);
CREATE INDEX idx_verif_task ON verification_reports (task_id);
CREATE INDEX idx_verif_run ON verification_reports (task_run_id);

-- ── change_records (DOMAIN_CONTRACTS §17) — append-only ──────────────────────
CREATE TABLE change_records (
  change_id        TEXT PRIMARY KEY,
  session_id       TEXT NOT NULL,
  task_run_id      TEXT,
  tool_call_id     TEXT,
  kind             TEXT NOT NULL CHECK (kind IN ('create','modify','delete','rename')),
  relpath          TEXT NOT NULL,
  before_hash      TEXT,
  after_hash       TEXT,
  owned_by         TEXT NOT NULL CHECK (owned_by IN ('agent','verification','user')),
  in_scratch_zone  INTEGER NOT NULL,  -- boolean 0/1
  at               TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions (session_id)
);
CREATE INDEX idx_changes_session ON change_records (session_id);

-- ── checkpoints (DOMAIN_CONTRACTS §16) — atomic metadata ─────────────────────
CREATE TABLE checkpoints (
  checkpoint_id         TEXT PRIMARY KEY,
  session_id            TEXT NOT NULL,
  graph_version         INTEGER NOT NULL,
  workspace_revision_json TEXT NOT NULL,  -- .hash is a claim (CP-010)
  change_set_json       TEXT NOT NULL,    -- ChangeRecord[]
  session_state         TEXT NOT NULL,
  task_states_json      TEXT NOT NULL,
  budget_state          TEXT NOT NULL,
  last_event_id         TEXT NOT NULL,
  captured_at           TEXT NOT NULL,
  created_at            TEXT NOT NULL,
  schema_version        INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions (session_id)
);
CREATE INDEX idx_checkpoints_session ON checkpoints (session_id);

-- ── provenance (DOMAIN_CONTRACTS §19) — append-only ──────────────────────────
CREATE TABLE provenance (
  provenance_id       TEXT PRIMARY KEY,
  source_kind         TEXT NOT NULL,
  source_id           TEXT NOT NULL,
  model_json          TEXT,
  context_snapshot_id TEXT,
  inputs_json         TEXT NOT NULL,
  reason              TEXT NOT NULL,
  at                  TEXT NOT NULL
);

-- ── events (DOMAIN_CONTRACTS §18) — append-only, per-session monotonic ────────
CREATE TABLE events (
  event_id         TEXT PRIMARY KEY,
  session_id       TEXT NOT NULL,
  type             TEXT NOT NULL,
  aggregate_kind   TEXT NOT NULL,
  aggregate_id     TEXT NOT NULL,
  payload_json     TEXT NOT NULL,
  provenance_json  TEXT,
  at               TEXT NOT NULL,
  sequence_number  INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions (session_id),
  UNIQUE (session_id, sequence_number)  -- CP-008: monotonic, no gap/duplicate
);
CREATE INDEX idx_events_aggregate ON events (session_id, aggregate_kind, aggregate_id);
CREATE INDEX idx_events_type ON events (type);

-- ── locks (STATE_MACHINE_SPEC SM-LOCK) — one active lock per workspace ────────
CREATE TABLE locks (
  lock_id       TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL,
  session_id    TEXT NOT NULL,
  state         TEXT NOT NULL,
  hostname      TEXT NOT NULL,
  process_id    INTEGER NOT NULL,
  acquired_at   TEXT NOT NULL,
  heartbeat_at  TEXT NOT NULL,
  released_at   TEXT
);
CREATE UNIQUE INDEX idx_locks_active_workspace
  ON locks (workspace_id) WHERE released_at IS NULL;
`;

export const migration0001: Migration = {
  migrationId: '0001_create_initial_schema',
  fromVersion: 0,
  toVersion: 1,
  forwardOnly: false,
  reversible: true,
  description: 'Initial Phase 1 schema: sessions, goals, tasks, executions, runs, graph, budgets, tool calls, verification, changes, checkpoints, provenance, events, locks.',
  introducedIn: '0.1.0',

  apply(db): void {
    db.exec(SCHEMA_V1);
  },

  rollback(db): void {
    // Drop in reverse dependency order (children before parents).
    db.exec(`
      DROP TABLE IF EXISTS locks;
      DROP TABLE IF EXISTS events;
      DROP TABLE IF EXISTS provenance;
      DROP TABLE IF EXISTS checkpoints;
      DROP TABLE IF EXISTS change_records;
      DROP TABLE IF EXISTS verification_reports;
      DROP TABLE IF EXISTS tool_calls;
      DROP TABLE IF EXISTS budgets;
      DROP TABLE IF EXISTS graph_mutations;
      DROP TABLE IF EXISTS task_graph_edges;
      DROP TABLE IF EXISTS task_graph_nodes;
      DROP TABLE IF EXISTS task_graph_versions;
      DROP TABLE IF EXISTS task_runs;
      DROP TABLE IF EXISTS task_executions;
      DROP TABLE IF EXISTS tasks;
      DROP TABLE IF EXISTS goals;
      DROP TABLE IF EXISTS sessions;
    `);
  },
};
