// WorkspaceLock contract (P1-S1) — STATE_MACHINE_SPEC SM-LOCK §12, enforces SS-001.
//
// At most ONE active session per workspace (SS-001). The lock is the enforcement
// point: acquire() must fail if another live lock exists for the workspace. This is
// a CONTRACT; the SQLite-backed impl lives in infrastructure (partial unique index
// on locks(workspace_id) WHERE released_at IS NULL is the last-resort guard).
import type { LockState } from '../state-machine/states.js';

export interface WorkspaceLock {
  readonly lockId: string;
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly state: LockState;
  readonly hostname: string;
  readonly processId: number;
  readonly acquiredAt: string;
  readonly heartbeatAt: string;
  readonly releasedAt?: string;
}

export class LockError extends Error {
  public readonly code: 'LOCK_HELD' | 'LOCK_NOT_FOUND' | 'LOCK_NOT_OWNED';
  constructor(code: 'LOCK_HELD' | 'LOCK_NOT_FOUND' | 'LOCK_NOT_OWNED', message?: string) {
    super(message ?? code);
    this.name = 'LockError';
    this.code = code;
  }
}

export interface AcquireLockRequest {
  readonly lockId: string;
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly hostname: string;
  readonly processId: number;
  readonly at: string; // ISO timestamp (injected — no wall-clock in domain)
}

/**
 * Manages the single-active-session lock (SS-001). Implementations MUST make
 * acquire atomic w.r.t. the active-lock check.
 */
export interface WorkspaceLockService {
  /** Acquire the workspace lock. Throws LockError('LOCK_HELD') if already held. */
  acquire(req: AcquireLockRequest): Promise<WorkspaceLock>;
  /** Release a held lock. Throws if not found / not owned by the session. */
  release(lockId: string, sessionId: string, at: string): Promise<void>;
  /** The current active (unreleased) lock for a workspace, if any. */
  getActive(workspaceId: string): Promise<WorkspaceLock | null>;
}
