// Checkpoint — DOMAIN_CONTRACTS §16 + WORKSPACE_SPEC §10.
//
// Metadata is atomic in SQLite (CP-002). workspaceRevision.hash is a CLAIM about the
// filesystem, not atomic with SQLite (CP-010). Immutable — "dirty at capture" is recorded
// via an append-only event, not a mutable status field (CP-011).
import type { WorkspaceRevision } from './workspace-revision.js';
import type { ChangeRecord } from './change-record.js';
import type { SessionState, TaskState, BudgetState } from '../state-machine/states.js';

export interface Checkpoint {
  readonly checkpointId: string; // ULID
  readonly sessionId: string;

  readonly graphVersion: number;
  readonly workspaceRevision: WorkspaceRevision; // .hash is a claim (CP-010)
  readonly agentChangeSet: readonly ChangeRecord[];

  readonly sessionState: SessionState;
  readonly taskStates: Readonly<Record<string, TaskState>>;
  readonly budgetState: BudgetState;

  readonly lastEventId: string;

  readonly capturedAt: string; // when computeRevision ran (before COMMIT)
  readonly createdAt: string;
  readonly schemaVersion: number;
}
