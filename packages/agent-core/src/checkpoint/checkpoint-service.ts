// CheckpointService (P1-C1) — DOMAIN_CONTRACTS §16, WORKSPACE_SPEC §10.
// Enforces CP-002/003/009/010/011/012.
//
// Capture-then-commit ordering (CP-010): the workspaceRevision.hash is a CLAIM about the
// filesystem computed BEFORE the SQLite transaction — it is NOT atomic with the DB. The
// service therefore:
//   1. Takes an already-computed WorkspaceRevision (captured before this call).
//   2. Persists the full checkpoint metadata in ONE transaction (CP-002 — the repository).
//   3. AFTER commit, re-verifies the protected set (CP-011): if the filesystem drifted
//      during capture, it appends CHECKPOINT_DIRTY_AT_CAPTURE (the checkpoint stays
//      immutable and is flagged as not-clean for recovery).
//
// load() re-computes the current hash and compares to the checkpoint's hash (CP-012):
// a mismatch means drift and the caller MUST reconcile (never assume consistency).
import type { Checkpoint } from '../domain/checkpoint.js';
import type { WorkspaceRevision } from '../domain/workspace-revision.js';
import type { ChangeRecord } from '../domain/change-record.js';
import type { SessionState, TaskState, BudgetState } from '../state-machine/states.js';
import type { DomainEvent, EventType } from '../domain/event.js';
import type { CheckpointRepository, EventLog } from '../repositories/index.js';

export interface CheckpointServiceDeps {
  readonly checkpoints: CheckpointRepository;
  readonly events: EventLog;
  readonly now: () => string;
  readonly nextId: () => string;
}

/** Inputs to a capture — all 5 required components (CP-002). */
export interface CaptureInput {
  readonly sessionId: string;
  readonly graphVersion: number;
  /** Pre-computed BEFORE this call (CP-010): the hash is a filesystem claim. */
  readonly workspaceRevision: WorkspaceRevision;
  readonly agentChangeSet: readonly ChangeRecord[];
  readonly sessionState: SessionState;
  readonly taskStates: Readonly<Record<string, TaskState>>;
  readonly budgetState: BudgetState;
  readonly lastEventId: string;
  /** When computeRevision ran (before COMMIT) — the capture instant. */
  readonly capturedAt: string;
  readonly schemaVersion: number;
}

export interface LoadResult {
  readonly checkpoint: Checkpoint;
  /** CP-012: true if the current workspace hash differs from the checkpoint's hash. */
  readonly drift: boolean;
}

export class CheckpointService {
  constructor(private readonly deps: CheckpointServiceDeps) {}

  /**
   * Persist a checkpoint atomically (CP-002), then re-verify the protected set (CP-011).
   * `currentHashAfterCommit` is the hash re-computed AFTER commit; if it differs from the
   * captured hash, the filesystem drifted during capture → emit CHECKPOINT_DIRTY_AT_CAPTURE.
   * The checkpoint itself is immutable either way (dirtiness is an append-only event).
   */
  async capture(input: CaptureInput, currentHashAfterCommit?: string): Promise<Checkpoint> {
    const checkpoint: Checkpoint = {
      checkpointId: this.deps.nextId(),
      sessionId: input.sessionId,
      graphVersion: input.graphVersion,
      workspaceRevision: input.workspaceRevision,
      agentChangeSet: input.agentChangeSet,
      sessionState: input.sessionState,
      taskStates: input.taskStates,
      budgetState: input.budgetState,
      lastEventId: input.lastEventId,
      capturedAt: input.capturedAt,
      createdAt: this.deps.now(),
      schemaVersion: input.schemaVersion,
    };

    // CP-002: the repository writes all metadata in one transaction.
    await this.deps.checkpoints.create(checkpoint);

    // CP-011: re-verify the protected set after commit; flag drift as an append-only event.
    if (
      currentHashAfterCommit !== undefined &&
      currentHashAfterCommit !== input.workspaceRevision.hash
    ) {
      await this.emit(input.sessionId, 'CHECKPOINT_DIRTY_AT_CAPTURE', {
        checkpointId: checkpoint.checkpointId,
        capturedHash: input.workspaceRevision.hash,
        observedHash: currentHashAfterCommit,
      });
    } else {
      await this.emit(input.sessionId, 'CHECKPOINT_CREATED', {
        checkpointId: checkpoint.checkpointId,
        graphVersion: checkpoint.graphVersion,
      });
    }
    return checkpoint;
  }

  /**
   * Load the latest checkpoint for a session and compare the CURRENT workspace hash to the
   * checkpoint's hash (CP-012). A mismatch => drift; the caller must reconcile rather than
   * assume the filesystem matches the recorded state. Emits CHECKPOINT_LOADED.
   */
  async load(sessionId: string, currentHash: string): Promise<LoadResult | null> {
    const checkpoint = await this.deps.checkpoints.getLatest(sessionId);
    if (!checkpoint) {
      return null;
    }
    const drift = currentHash !== checkpoint.workspaceRevision.hash;
    await this.emit(sessionId, 'CHECKPOINT_LOADED', {
      checkpointId: checkpoint.checkpointId,
      drift,
    });
    return { checkpoint, drift };
  }

  private async emit(sessionId: string, type: EventType, payload: unknown): Promise<void> {
    const event: DomainEvent = {
      eventId: this.deps.nextId(),
      sessionId,
      type,
      aggregate: { kind: 'session', id: sessionId },
      payload,
      at: this.deps.now(),
      sequenceNumber: 0, // EventLog is the sequence authority (CP-008)
    };
    await this.deps.events.append(event);
  }
}
