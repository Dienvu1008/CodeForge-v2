// TrustMarker — CONTEXT_SPEC §9, P2-CX1.
//
// Deterministic assignment of TrustLevel per ContextSource.kind.
// CX-003: untrusted content must be marked in snapshot.
// CX-005: context is never runtime authority — trust level is data only.
//
// Rule (CONTEXT_SPEC §9.1):
//   Workspace files, artifacts, logs, test results, failure evidence → untrusted.
//   Task/goal/policy/constraint definitions → trusted (T1/T2 origin).
import type { TrustLevel, ContextSourceKind } from '../domain/context.js';

/**
 * Determine the TrustLevel for a given ContextSource kind.
 * Pure + deterministic (no I/O, no LLM).
 */
export function assignTrust(sourceKind: ContextSourceKind): TrustLevel {
  switch (sourceKind) {
    // T0/T1/T2 trusted sources — task definitions, policy, goal.
    case 'task':
    case 'goal':
    case 'policy':
    case 'session':
    case 'graph':
      return 'trusted';

    // T4/T5 untrusted — workspace content, test results, artifacts, logs.
    case 'workspace_file':
    case 'workspace_symbol':
    case 'artifact':
    case 'memory':
      return 'untrusted';

    default:
      // Fail-safe: unknown sources are untrusted (SE-001 spirit).
      return 'untrusted';
  }
}

/** True if content from this source kind must be wrapped in untrusted delimiters. */
export function isUntrustedSource(sourceKind: ContextSourceKind): boolean {
  return assignTrust(sourceKind) === 'untrusted';
}
