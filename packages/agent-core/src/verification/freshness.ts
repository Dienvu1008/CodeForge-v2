// Freshness utilities — VERIFICATION_PROTOCOL §5, P1.5-VR1.
//
// Two distinct concepts (§5.1):
//   isFresh          — revision binding only (no status check).
//   isUsableForCompletion — fresh AND conclusive (status ∈ PASS | FAIL).
//
// isFresh is already defined in domain/workspace-revision.ts. This module
// re-exports it and adds isUsableForCompletion which is verification-specific.
export { isFresh } from '../domain/workspace-revision.js';
import { isFresh } from '../domain/workspace-revision.js';
import type { VerificationReport } from '../domain/verification.js';
import type { WorkspaceRevision } from '../domain/workspace-revision.js';

/**
 * True iff the report can be used to make a completion decision:
 *   - revision is still fresh (hash + canonicalFormVersion match current), AND
 *   - report has a conclusive status (PASS or FAIL).
 *
 * INVALID/ERROR reports are NOT usable even if fresh (§5.1b).
 * Callers that need PASS specifically (CompletionGate) check status === 'PASS'
 * on top of this.
 */
export function isUsableForCompletion(
  report: Pick<VerificationReport, 'targetWorkspaceRevision' | 'status'>,
  current: Pick<WorkspaceRevision, 'hash' | 'canonicalFormVersion'>,
): boolean {
  return (
    isFresh(report.targetWorkspaceRevision, current) &&
    (report.status === 'PASS' || report.status === 'FAIL')
  );
}

/**
 * True iff the report has status PASS AND is fresh relative to `current`.
 * This is the actual gate condition for VERIFYING → PASSED (TI-005).
 */
export function isPassing(
  report: Pick<VerificationReport, 'targetWorkspaceRevision' | 'status'>,
  current: Pick<WorkspaceRevision, 'hash' | 'canonicalFormVersion'>,
): boolean {
  return report.status === 'PASS' && isFresh(report.targetWorkspaceRevision, current);
}
