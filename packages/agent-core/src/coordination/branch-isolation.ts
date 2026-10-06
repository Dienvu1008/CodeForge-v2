// BranchIsolation (P8-BI1) — deterministic workspace isolation + no-orphan cancellation
// for parallel branches. Enforces AU-005 (isolation) and AU-006 (no orphan on cancel).
//
// A "branch" is one parallel line of execution (one admitted task from the
// ParallelExecutor batch, or one sub-agent fan-out). This module is PURE agent-core
// logic — no filesystem, no process control. It computes WHERE a branch may write and
// WHETHER a branch's cancellation is clean; the infrastructure WorkspaceManager /
// ProcessReconciler enforce those decisions at the boundary.
//
// AU-005 — isolation: each branch gets a disjoint scratch zone (a relpath prefix under
// a shared root). A write is classified OWN / SHARED / FOREIGN; a FOREIGN write (into a
// sibling's zone) is rejected unless an explicit shared-path policy allows it. Two
// branches therefore cannot clobber each other's scratch.
//
// AU-006 — no orphan: a branch's cancellation is only "clean" once its run reached a
// terminal state AND its process tree was reconciled (zero orphan PIDs — EX-006/CP-006).
// Cancelling one branch is a pure, local operation: sibling branch states are returned
// unchanged.
import type { TaskRunState } from '../state-machine/states.js';
import { TERMINAL_TASK_RUN_STATES } from '../state-machine/states.js';

// ── Scratch-zone allocation (AU-005) ──────────────────────────────────────────

/** A relpath prefix (workspace-relative, '/'-separated, trailing '/') owned by a branch. */
export interface BranchScratchZone {
  readonly branchId: string;
  readonly relpath: string;
}

/**
 * Deterministically allocate a disjoint scratch zone per branch under `rootPrefix`.
 * Zone = `${rootPrefix}/${branchId}/`. branchIds are sorted for a stable result, and a
 * duplicate id is a programming error (the caller must pass distinct branch ids).
 */
export function allocateScratchZones(
  branchIds: readonly string[],
  rootPrefix = '.scratch',
): readonly BranchScratchZone[] {
  const seen = new Set<string>();
  for (const id of branchIds) {
    if (seen.has(id)) throw new BranchIsolationError('DUPLICATE_BRANCH', `duplicate branch id: ${id}`);
    seen.add(id);
  }
  const base = normalizePrefix(rootPrefix);
  return [...branchIds]
    .sort(compareStr)
    .map((branchId) => ({ branchId, relpath: `${base}${branchId}/` }));
}

// ── Write classification (AU-005) ──────────────────────────────────────────────

export type WriteDisposition = 'OWN' | 'SHARED' | 'FOREIGN';

export interface WriteCheck {
  readonly disposition: WriteDisposition;
  /** True iff the write is allowed (OWN always; SHARED by policy; FOREIGN never). */
  readonly allowed: boolean;
}

/**
 * Classify a branch's write to `relpath` against the full zone allocation.
 *   OWN     — inside the branch's own scratch zone → allowed.
 *   SHARED  — inside an explicitly shared prefix → allowed.
 *   FOREIGN — inside a sibling's zone (not shared) → rejected (AU-005).
 * A path in no branch zone and no shared prefix is treated as OWN of the committed
 * workspace (branches share the base tree read/commit path, which is governed by
 * WS-005/WS-006 elsewhere); only cross-branch SCRATCH collisions are the concern here.
 */
export function classifyWrite(
  branchId: string,
  relpath: string,
  zones: readonly BranchScratchZone[],
  sharedPrefixes: readonly string[] = [],
): WriteCheck {
  const path = normalizeRel(relpath);

  // An explicitly shared prefix wins (policy-permitted cross-branch area).
  for (const shared of sharedPrefixes) {
    const s = normalizeRel(shared);
    if (underPrefix(path, s)) return { disposition: 'SHARED', allowed: true };
  }

  for (const zone of zones) {
    if (underPrefix(path, zone.relpath)) {
      const own = zone.branchId === branchId;
      return { disposition: own ? 'OWN' : 'FOREIGN', allowed: own };
    }
  }

  // Not in any branch scratch zone → not a cross-branch isolation concern.
  return { disposition: 'OWN', allowed: true };
}

/** Throwing variant for callers that want to fail fast on a foreign write. */
export function assertWriteAllowed(
  branchId: string,
  relpath: string,
  zones: readonly BranchScratchZone[],
  sharedPrefixes: readonly string[] = [],
): void {
  const check = classifyWrite(branchId, relpath, zones, sharedPrefixes);
  if (!check.allowed) {
    throw new BranchIsolationError(
      'FOREIGN_WRITE',
      `branch ${branchId} may not write ${relpath} (${check.disposition})`,
    );
  }
}

// ── No-orphan cancellation (AU-006) ────────────────────────────────────────────

/** The reconciled state of one branch's run after a cancel attempt. */
export interface BranchRunOutcome {
  readonly branchId: string;
  readonly runState: TaskRunState;
  /** PIDs still alive after the ProcessReconciler ran (empty ⇒ no orphan). */
  readonly orphanPids: readonly number[];
}

/**
 * True iff cancelling this branch left no orphan: the run reached a terminal state and
 * its process tree was fully reconciled (EX-006/CP-006). A non-terminal run or any
 * surviving PID means the cancellation is NOT clean.
 */
export function isCleanCancellation(outcome: BranchRunOutcome): boolean {
  const terminal = (TERMINAL_TASK_RUN_STATES as readonly string[]).includes(outcome.runState);
  return terminal && outcome.orphanPids.length === 0;
}

/**
 * Cancel exactly one branch, leaving siblings untouched (AU-006: cancelling one branch
 * does not disturb the others). Pure: returns the next outcome set. The cancelled
 * branch's outcome is supplied by the caller (the reconciled result from the runtime);
 * this function only asserts no-orphan and preserves every sibling verbatim.
 */
export function cancelOneBranch(
  outcomes: readonly BranchRunOutcome[],
  cancelled: BranchRunOutcome,
): readonly BranchRunOutcome[] {
  if (!isCleanCancellation(cancelled)) {
    throw new BranchIsolationError(
      'ORPHAN_ON_CANCEL',
      `branch ${cancelled.branchId} left an orphan (state=${cancelled.runState}, ` +
        `${cancelled.orphanPids.length} pid(s))`,
    );
  }
  // Replace only the cancelled branch; siblings are returned unchanged (same references).
  return outcomes.map((o) => (o.branchId === cancelled.branchId ? cancelled : o));
}

// ── Errors ──────────────────────────────────────────────────────────────────────

export type BranchIsolationErrorCode =
  | 'DUPLICATE_BRANCH'
  | 'FOREIGN_WRITE'
  | 'ORPHAN_ON_CANCEL';

export class BranchIsolationError extends Error {
  public readonly code: BranchIsolationErrorCode;
  constructor(code: BranchIsolationErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'BranchIsolationError';
    this.code = code;
  }
}

// ── internals ─────────────────────────────────────────────────────────────────

/** Normalize a prefix to '<p>/' form, '/'-separated, no leading './' or '/'. */
function normalizePrefix(p: string): string {
  const n = normalizeRel(p);
  return n.endsWith('/') ? n : `${n}/`;
}

/** Normalize a relpath: strip leading './' and '/', collapse to '/'-separated. */
function normalizeRel(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.?\/+/, '');
}

/** True iff `path` is at or under the directory prefix `prefix` (prefix ends with '/'). */
function underPrefix(path: string, prefix: string): boolean {
  const pre = prefix.endsWith('/') ? prefix : `${prefix}/`;
  return path === pre.slice(0, -1) || path.startsWith(pre);
}

/** Total, locale-independent string order (deterministic across platforms). */
function compareStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
