// SqliteCheckpointRepository — DOMAIN_CONTRACTS §16, CP-002/CP-009.
//
// CP-002: all checkpoint metadata is written in ONE statement (a single INSERT is atomic),
// so a checkpoint row is either fully present or absent — never partial. CP-009: reads
// return a fully-materialized Checkpoint or null; there is no partial-load path.
import type {
  Checkpoint,
  CheckpointRepository,
  WorkspaceRevision,
  ChangeRecord,
} from '@codeforge/agent-core';
import type { DatabaseAdapter } from '../sqlite/types.js';
import { RepoError } from './errors.js';

interface CheckpointRow {
  checkpoint_id: string;
  session_id: string;
  graph_version: number;
  workspace_revision_json: string;
  change_set_json: string;
  session_state: string;
  task_states_json: string;
  budget_state: string;
  last_event_id: string;
  captured_at: string;
  created_at: string;
  schema_version: number;
}

export class SqliteCheckpointRepository implements CheckpointRepository {
  constructor(private readonly db: DatabaseAdapter) {}

  async create(checkpoint: Checkpoint): Promise<void> {
    try {
      // Single INSERT = atomic write of all 5 components + metadata (CP-002).
      this.db.execute(
        `INSERT INTO checkpoints
           (checkpoint_id, session_id, graph_version, workspace_revision_json, change_set_json,
            session_state, task_states_json, budget_state, last_event_id, captured_at,
            created_at, schema_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          checkpoint.checkpointId,
          checkpoint.sessionId,
          checkpoint.graphVersion,
          JSON.stringify(checkpoint.workspaceRevision),
          JSON.stringify(checkpoint.agentChangeSet),
          checkpoint.sessionState,
          JSON.stringify(checkpoint.taskStates),
          checkpoint.budgetState,
          checkpoint.lastEventId,
          checkpoint.capturedAt,
          checkpoint.createdAt,
          checkpoint.schemaVersion,
        ],
      );
    } catch (err) {
      if (err && typeof err === 'object' && 'code' in err && (err as { code: unknown }).code === 'DB_CONSTRAINT') {
        throw new RepoError('ALREADY_EXISTS', 'Checkpoint', checkpoint.checkpointId);
      }
      throw err;
    }
  }

  async getById(checkpointId: string): Promise<Checkpoint | null> {
    const rows = this.db.query<CheckpointRow>('SELECT * FROM checkpoints WHERE checkpoint_id = ?', [
      checkpointId,
    ]);
    return rows[0] ? rowToCheckpoint(rows[0]) : null;
  }

  async getLatest(sessionId: string): Promise<Checkpoint | null> {
    // Newest by capturedAt then id (deterministic; CP-003 recovery determinism).
    const rows = this.db.query<CheckpointRow>(
      'SELECT * FROM checkpoints WHERE session_id = ? ORDER BY captured_at DESC, checkpoint_id DESC LIMIT 1',
      [sessionId],
    );
    return rows[0] ? rowToCheckpoint(rows[0]) : null;
  }
}

function rowToCheckpoint(row: CheckpointRow): Checkpoint {
  return {
    checkpointId: row.checkpoint_id,
    sessionId: row.session_id,
    graphVersion: row.graph_version,
    workspaceRevision: JSON.parse(row.workspace_revision_json) as WorkspaceRevision,
    agentChangeSet: JSON.parse(row.change_set_json) as ChangeRecord[],
    sessionState: row.session_state as Checkpoint['sessionState'],
    taskStates: JSON.parse(row.task_states_json) as Checkpoint['taskStates'],
    budgetState: row.budget_state as Checkpoint['budgetState'],
    lastEventId: row.last_event_id,
    capturedAt: row.captured_at,
    createdAt: row.created_at,
    schemaVersion: row.schema_version,
  };
}
