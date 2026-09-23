// Migration 0002 -- Phase 1.5 tables (v2). MIGRATION_SPEC §5.2, P1.5-DB2.
//
// Additive-only: migration v1 is NOT touched. New tables:
//   - approvals        -- Approval records (HI-001/002, TG-003/004)
//   - failures         -- Failure records (DOMAIN_CONTRACTS §10)
//   - recovery_actions -- RecoveryAction records (DOMAIN_CONTRACTS §11)
//
// Note: tool_calls and verification_reports already exist in v1 (forward-designed
// in Phase 1). This migration only adds the tables deferred to Phase 1.5.
import type { Migration } from './types.js';

const SCHEMA_V2 = `
-- approvals (DOMAIN_CONTRACTS §13, HI-001/002, TG-003/004)
-- Each approval row is bound to exactly one (toolCallId, argumentsHash,
-- toolPolicyVersion) triple (HI-001). Reusing an approval for a different
-- argumentsHash is rejected at the service layer (HI-002).
CREATE TABLE approvals (
  approval_id          TEXT PRIMARY KEY,
  tool_call_id         TEXT NOT NULL,
  arguments_hash       TEXT NOT NULL,
  tool_policy_version  INTEGER NOT NULL,
  decision             TEXT NOT NULL CHECK (decision IN ('APPROVED','DENIED')),
  decided_by           TEXT NOT NULL CHECK (decided_by IN ('user','policy')),
  reason               TEXT,
  decided_at           TEXT NOT NULL,
  expires_at           TEXT,
  FOREIGN KEY (tool_call_id) REFERENCES tool_calls (tool_call_id)
);
CREATE INDEX idx_approvals_tool_call ON approvals (tool_call_id);
CREATE INDEX idx_approvals_hash ON approvals (arguments_hash);

-- failures (DOMAIN_CONTRACTS §10) -- append-only failure evidence
CREATE TABLE failures (
  failure_id                TEXT PRIMARY KEY,
  session_id                TEXT NOT NULL,
  task_id                   TEXT NOT NULL,
  task_run_id               TEXT NOT NULL,
  stage                     TEXT NOT NULL CHECK (stage IN ('plan','execute','verify','recover')),
  class                     TEXT NOT NULL,
  signature                 TEXT NOT NULL,
  evidence_json             TEXT NOT NULL,
  detected_at               TEXT NOT NULL,
  classified_by             TEXT NOT NULL CHECK (classified_by IN ('deterministic','analyzer')),
  recovery_action_ids_json  TEXT NOT NULL DEFAULT '[]',
  FOREIGN KEY (session_id) REFERENCES sessions (session_id),
  FOREIGN KEY (task_id) REFERENCES tasks (task_id)
);
CREATE INDEX idx_failures_session ON failures (session_id);
CREATE INDEX idx_failures_task ON failures (task_id);
CREATE INDEX idx_failures_signature ON failures (signature);

-- recovery_actions (DOMAIN_CONTRACTS §11) -- bounded, append-only
CREATE TABLE recovery_actions (
  action_id             TEXT PRIMARY KEY,
  failure_id            TEXT NOT NULL,
  action                TEXT NOT NULL,
  reason                TEXT NOT NULL,
  policy_version        INTEGER NOT NULL,
  budget_consumed_json  TEXT NOT NULL,
  started_at            TEXT NOT NULL,
  ended_at              TEXT,
  outcome               TEXT NOT NULL CHECK (outcome IN ('PENDING','SUCCEEDED','FAILED','ABORTED')),
  next_failure_id       TEXT,
  FOREIGN KEY (failure_id) REFERENCES failures (failure_id)
);
CREATE INDEX idx_recovery_failure ON recovery_actions (failure_id);
`;

const ROLLBACK_V2 = `
DROP TABLE IF EXISTS recovery_actions;
DROP TABLE IF EXISTS failures;
DROP TABLE IF EXISTS approvals;
`;

export const migration0002: Migration = {
  migrationId: '0002_phase15_approvals_failures_recovery',
  fromVersion: 1,
  toVersion: 2,
  forwardOnly: false,
  reversible: true,
  description: 'Phase 1.5 tables: approvals (HI-001/002, TG-003/004), failures (RC evidence), recovery_actions (bounded recovery).',
  introducedIn: '0.2.0',

  apply(db): void {
    db.exec(SCHEMA_V2);
  },

  rollback(db): void {
    db.exec(ROLLBACK_V2);
  },
};
