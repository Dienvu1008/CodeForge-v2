// ContinuationManifest (P9.6) — a NON-AUTHORITATIVE hand-off for session rollover.
// Enforces OB-008.
//
// When a session rolls over (e.g. context pressure), the agent captures a manifest: the
// goal, what is done / in-flight / blocked, discoveries, the next intended action, and
// REFERENCES to the evidence/context it relied on. The next session bootstraps by
// RELOADING authoritative state (TaskGraph, task states, WorkspaceRevision, Verification,
// Budget, Checkpoint) from SQLite — the manifest never carries authoritative state and
// can never overwrite it. validateContinuationManifest() is the bootstrap check: it
// reports which of the manifest's references are still valid against the freshly reloaded
// state, so the next session can trust the live state and treat the manifest as a hint
// only.
import type { WorkspaceRevision } from '../domain/workspace-revision.js';
import type { Provenance } from '../domain/provenance.js';

// ── Manifest (references + hints only — no authoritative state objects) ─────────

export interface ContinuationManifest {
  readonly manifestId: string;
  /** The session being rolled over FROM. */
  readonly parentSessionId: string;
  readonly createdAt: string;

  // References into authoritative state (ids/versions only — never the objects).
  readonly goalId: string;
  readonly taskGraphVersion: number;
  readonly workspaceRevisionId: string;
  readonly completedTaskIds: readonly string[];
  readonly activeTaskIds: readonly string[];
  readonly blockedTaskIds: readonly string[];
  readonly verificationIds: readonly string[];
  readonly checkpointId?: string;
  readonly contextSnapshotId?: string;

  // Hints (free-form, redacted upstream — advisory text, not authority).
  readonly discoveries: readonly string[];
  readonly decisions: readonly string[];
  readonly openQuestions: readonly string[];
  readonly nextIntendedAction?: string;

  readonly provenance: Provenance;
}

export interface BuildContinuationInput {
  readonly manifestId: string;
  readonly parentSessionId: string;
  readonly createdAt: string;
  readonly goalId: string;
  readonly taskGraphVersion: number;
  readonly workspaceRevision: Pick<WorkspaceRevision, 'revisionId'>;
  readonly completedTaskIds: readonly string[];
  readonly activeTaskIds: readonly string[];
  readonly blockedTaskIds: readonly string[];
  readonly verificationIds?: readonly string[];
  readonly checkpointId?: string;
  readonly contextSnapshotId?: string;
  readonly discoveries?: readonly string[];
  readonly decisions?: readonly string[];
  readonly openQuestions?: readonly string[];
  readonly nextIntendedAction?: string;
  readonly provenance: Provenance;
}

// ── buildContinuationManifest ──────────────────────────────────────────────────

/**
 * Build a continuation manifest. Pure + total: references are copied, ids sorted for a
 * stable result. The manifest holds no authoritative state objects — only ids, versions,
 * and advisory hints (OB-008).
 */
export function buildContinuationManifest(input: BuildContinuationInput): ContinuationManifest {
  return {
    manifestId: input.manifestId,
    parentSessionId: input.parentSessionId,
    createdAt: input.createdAt,
    goalId: input.goalId,
    taskGraphVersion: input.taskGraphVersion,
    workspaceRevisionId: input.workspaceRevision.revisionId,
    completedTaskIds: [...input.completedTaskIds].sort(compareStr),
    activeTaskIds: [...input.activeTaskIds].sort(compareStr),
    blockedTaskIds: [...input.blockedTaskIds].sort(compareStr),
    verificationIds: [...(input.verificationIds ?? [])].sort(compareStr),
    ...(input.checkpointId !== undefined ? { checkpointId: input.checkpointId } : {}),
    ...(input.contextSnapshotId !== undefined ? { contextSnapshotId: input.contextSnapshotId } : {}),
    discoveries: [...(input.discoveries ?? [])],
    decisions: [...(input.decisions ?? [])],
    openQuestions: [...(input.openQuestions ?? [])],
    ...(input.nextIntendedAction !== undefined ? { nextIntendedAction: input.nextIntendedAction } : {}),
    provenance: input.provenance,
  };
}

// ── Validation against freshly-reloaded authoritative state ─────────────────────

/**
 * The authoritative facts the NEXT session reloads from SQLite to validate the manifest.
 * These are the single source of truth; the manifest is checked against them, never the
 * other way round.
 */
export interface AuthoritativeSnapshot {
  readonly goalId: string;
  readonly currentGraphVersion: number;
  readonly knownTaskIds: readonly string[];
  readonly currentRevisionId: string;
  readonly knownVerificationIds: readonly string[];
  readonly knownCheckpointIds: readonly string[];
}

export type StaleRefKind =
  | 'goal'
  | 'graph_version'
  | 'workspace_revision'
  | 'task'
  | 'verification'
  | 'checkpoint';

export interface StaleRef {
  readonly kind: StaleRefKind;
  readonly ref: string;
}

export interface ContinuationValidation {
  /** True iff every reference in the manifest resolves against the authoritative state. */
  readonly valid: boolean;
  /** References that no longer resolve (sorted, deterministic). The caller rebuilds from
   *  authoritative state regardless; this reports what the manifest got wrong. */
  readonly staleRefs: readonly StaleRef[];
}

/**
 * Validate a manifest's references against the authoritative snapshot the next session
 * reloaded. Pure + total. A manifest is valid when the goal matches, its graph version is
 * not ahead of the current one, the workspace revision resolves, and every referenced
 * task / verification / checkpoint id is known. Stale refs are reported, never "fixed" —
 * the authoritative state always wins (OB-008).
 */
export function validateContinuationManifest(
  manifest: ContinuationManifest,
  authoritative: AuthoritativeSnapshot,
): ContinuationValidation {
  const stale: StaleRef[] = [];
  const knownTasks = new Set(authoritative.knownTaskIds);
  const knownVerifications = new Set(authoritative.knownVerificationIds);
  const knownCheckpoints = new Set(authoritative.knownCheckpointIds);

  if (manifest.goalId !== authoritative.goalId) {
    stale.push({ kind: 'goal', ref: manifest.goalId });
  }
  // The manifest must not reference a graph version ahead of the reloaded one.
  if (manifest.taskGraphVersion > authoritative.currentGraphVersion) {
    stale.push({ kind: 'graph_version', ref: String(manifest.taskGraphVersion) });
  }
  if (manifest.workspaceRevisionId !== authoritative.currentRevisionId) {
    stale.push({ kind: 'workspace_revision', ref: manifest.workspaceRevisionId });
  }
  for (const taskId of [...manifest.completedTaskIds, ...manifest.activeTaskIds, ...manifest.blockedTaskIds]) {
    if (!knownTasks.has(taskId)) stale.push({ kind: 'task', ref: taskId });
  }
  for (const vId of manifest.verificationIds) {
    if (!knownVerifications.has(vId)) stale.push({ kind: 'verification', ref: vId });
  }
  if (manifest.checkpointId !== undefined && !knownCheckpoints.has(manifest.checkpointId)) {
    stale.push({ kind: 'checkpoint', ref: manifest.checkpointId });
  }

  stale.sort((a, b) => (a.kind !== b.kind ? compareStr(a.kind, b.kind) : compareStr(a.ref, b.ref)));
  return { valid: stale.length === 0, staleRefs: stale };
}

/** Total, locale-independent string order (deterministic across platforms). */
function compareStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
