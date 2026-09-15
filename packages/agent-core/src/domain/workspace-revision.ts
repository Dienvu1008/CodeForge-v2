// WorkspaceRevision domain type — WORKSPACE_SPEC §5.2, DOMAIN_CONTRACTS.
//
// Immutable snapshot of the workspace at a point in time, with a canonical hash.
// This is a DOMAIN type: no filesystem access here. Computation (which touches the
// filesystem) lives in @codeforge/infrastructure (C2 factory), preserving DC-001/DC-002.

export type WorkspaceRevisionReason =
  | 'session_start'
  | 'pre_verify'
  | 'post_verify'
  | 'pre_checkpoint'
  | 'manual';

export type WorkspaceHashAlgorithm = 'blake3' | 'sha256';

export interface WorkspaceRevisionCreatedBy {
  readonly sessionId: string;
  readonly taskId?: string;
  readonly taskRunId?: string;
  readonly reason: WorkspaceRevisionReason;
}

export interface WorkspaceGitMetadata {
  readonly head: string;
  readonly branch: string;
  readonly isDirty: boolean;
  readonly hasStagedChanges: boolean;
}

export interface WorkspaceRevision {
  readonly revisionId: string; // ULID, immutable, never reused
  readonly canonicalFormVersion: string; // e.g. "v1"
  readonly root: string; // canonical absolute path, '/'-separated
  readonly includedPaths: readonly string[]; // sorted, canonical relative
  readonly excludedScratchPaths: readonly string[]; // sorted, canonical relative
  readonly hashAlgorithm: WorkspaceHashAlgorithm;
  readonly hash: string; // hex
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly createdAt: string; // ISO 8601
  readonly createdBy: WorkspaceRevisionCreatedBy;
  readonly gitMetadata?: WorkspaceGitMetadata; // informational only — NOT used for freshness
}

/**
 * Freshness (WORKSPACE_SPEC §5, §13.1; VERIFICATION_PROTOCOL §5.1(a)).
 *
 * A report/revision is FRESH relative to `current` iff hash AND canonicalFormVersion match.
 * Git metadata is never consulted (WS-009). Does NOT consider verification status —
 * status is a completion-gate concern, not freshness (see isUsableForCompletion elsewhere).
 */
export function isFresh(
  a: Pick<WorkspaceRevision, 'hash' | 'canonicalFormVersion'>,
  current: Pick<WorkspaceRevision, 'hash' | 'canonicalFormVersion'>,
): boolean {
  return a.hash === current.hash && a.canonicalFormVersion === current.canonicalFormVersion;
}

/** The canonical form version this codebase produces. Bump when the hash format changes. */
export const CANONICAL_FORM_VERSION = 'v1';
