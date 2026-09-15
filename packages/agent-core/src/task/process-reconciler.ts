// ProcessReconciler contract (P1-T3) — enforces EX-005 (no finalize before reconcile).
//
// Before a TaskRun may be finalized, the process tree it spawned MUST be reconciled
// (killed/verified-dead) so no orphan process outlives the run. This is a CONTRACT;
// the real ProcessSupervisor impl lands in a later phase. Phase 1 ships a Noop that
// reports "reconciled" so the runtime can be exercised with FakeModel, plus the gate
// logic that refuses to finalize when reconciliation has not happened.
export interface ReconcileResult {
  /** True iff the run's process tree is confirmed fully terminated. */
  readonly reconciled: boolean;
  /** PIDs that were killed during reconciliation (informational). */
  readonly killedPids: readonly number[];
  /** PIDs still alive after reconcile attempt (non-empty => reconciled=false). */
  readonly orphanPids: readonly number[];
}

export interface ProcessReconciler {
  /** Reconcile the process tree for a run. Idempotent. */
  reconcile(taskRunId: string): Promise<ReconcileResult>;
}

/**
 * Phase 1 no-op reconciler: there are no real processes yet (no ToolGateway), so the
 * tree is trivially reconciled. Returns reconciled=true with empty pid lists.
 */
export class NoopProcessReconciler implements ProcessReconciler {
  async reconcile(_taskRunId: string): Promise<ReconcileResult> {
    return { reconciled: true, killedPids: [], orphanPids: [] };
  }
}
