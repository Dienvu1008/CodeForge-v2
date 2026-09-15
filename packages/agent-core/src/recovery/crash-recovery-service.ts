// CrashRecoveryService (P1-CR1) — DOMAIN_CONTRACTS §recovery, CP-004/005/006.
//
// On restart, the runtime does NOT assume in-flight work failed. It:
//   1. Loads the latest checkpoint and checks for workspace drift (CP-012, via
//      CheckpointService.load — the caller supplies the current hash).
//   2. Finds unfinished TaskRuns (state RUNNING).
//   3. For each: reconciles the process tree (CP-005: orphan processes are killed by
//      the ProcessReconciler), then finalizes the run as INTERRUPTED — NOT FAILED
//      (CP-004: unfinished runs are reconciled, never assumed-failed). This leaves the
//      task in a non-orphan state (CP-006); the RecoveryPolicy (Phase 5) decides the
//      next step from there.
//
// Deterministic (CP-003): same checkpoint + same run set → same recovery actions.
import type { TaskRun } from '../domain/task.js';
import type { WorkspaceRevision } from '../domain/workspace-revision.js';
import type { TaskRunRepository } from '../repositories/index.js';
import type { CheckpointService, LoadResult } from '../checkpoint/checkpoint-service.js';
import type { TaskRunService } from '../task/task-run-service.js';

export interface CrashRecoveryDeps {
  readonly runs: TaskRunRepository;
  readonly checkpoints: CheckpointService;
  readonly taskRuns: TaskRunService;
}

export interface RecoverInput {
  readonly sessionId: string;
  /** Current workspace hash at restart, for the checkpoint drift check (CP-012). */
  readonly currentHash: string;
  /**
   * Revision to record as the run's end anchor when finalizing INTERRUPTED (EX-L14).
   * At recovery this is the reconciled current workspace revision.
   */
  readonly reconciledRevision: WorkspaceRevision;
}

export interface RecoveryReport {
  /** The loaded checkpoint + whether the workspace drifted (CP-012). null if no checkpoint. */
  readonly checkpoint: LoadResult | null;
  /** taskRunIds that were unfinished and got marked INTERRUPTED (CP-004). */
  readonly interruptedRuns: readonly string[];
  /** True if the workspace drifted from the checkpoint (caller must reconcile further). */
  readonly drift: boolean;
}

export class CrashRecoveryService {
  constructor(private readonly deps: CrashRecoveryDeps) {}

  /**
   * Recover a session after a crash/restart. Marks every unfinished TaskRun INTERRUPTED
   * (via TaskRunService.finalizeInterrupted, which reconciles the process tree first —
   * CP-005 — and refuses to finalize while orphans remain). Returns a deterministic report.
   */
  async recover(input: RecoverInput): Promise<RecoveryReport> {
    const checkpoint = await this.deps.checkpoints.load(input.sessionId, input.currentHash);

    const running = await this.deps.runs.findRunning(input.sessionId);
    const interruptedRuns: string[] = [];
    for (const run of running) {
      // CP-004/CP-005: reconcile-then-INTERRUPTED. finalizeInterrupted calls the
      // ProcessReconciler and throws if orphans remain, so a successful call means the
      // process tree was cleaned up.
      await this.deps.taskRuns.finalizeInterrupted(run.taskRunId, input.reconciledRevision);
      interruptedRuns.push(run.taskRunId);
    }

    return {
      checkpoint,
      interruptedRuns,
      drift: checkpoint?.drift ?? false,
    };
  }

  /** Just the unfinished run set (diagnostic; does not mutate state). */
  async unfinishedRuns(sessionId: string): Promise<readonly TaskRun[]> {
    return this.deps.runs.findRunning(sessionId);
  }
}
