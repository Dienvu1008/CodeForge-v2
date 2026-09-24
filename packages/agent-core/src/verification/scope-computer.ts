// ScopeComputer — VERIFICATION_PROTOCOL §3, §4.7, P1.5-VR1.
//
// Pure + deterministic scope computation (VR-010). No LLM, no I/O.
//
// Rules:
//   1. Start from policy.minimumScope (never demote below it).
//   2. If affectedClosure / totalPaths > threshold → promote to FULL (§4.7).
//   3. Scope may only be promoted, never demoted (§3.4).
import { SCOPE_LATTICE, type VerificationScope } from '../domain/verification.js';
import type { VerificationPolicy } from './verification-policy.js';

// ── promoteScope ──────────────────────────────────────────────────────────────

/**
 * Promote `current` scope to at least `target`.
 * No-op if current ≥ target already.
 */
export function promoteScope(
  current: VerificationScope,
  target: VerificationScope,
): VerificationScope {
  return SCOPE_LATTICE[current] >= SCOPE_LATTICE[target] ? current : target;
}

// ── computeScope ──────────────────────────────────────────────────────────────

export interface ComputeScopeInput {
  readonly policy: VerificationPolicy;
  /** Number of files in the affectedClosure set. */
  readonly affectedClosureSize: number;
  /** Total number of testable paths in the workspace (denominator for threshold). */
  readonly totalTestablePaths: number;
  /** Whether this is the final graph verification (forces ≥ AFFECTED_CLOSURE, VR-004). */
  readonly isFinalGraph?: boolean;
}

/**
 * Compute the verification scope deterministically.
 *
 * VR-004: final graph verification must use ≥ AFFECTED_CLOSURE.
 * VR-010: deterministic — same input always produces the same scope.
 * §3.4: scope may only be promoted, never demoted.
 */
export function computeScope(input: ComputeScopeInput): VerificationScope {
  let scope: VerificationScope = input.policy.minimumScope;

  // VR-004: final graph must be at least AFFECTED_CLOSURE.
  if (input.isFinalGraph === true) {
    scope = promoteScope(scope, 'AFFECTED_CLOSURE');
  }

  // §4.7: promote to FULL when affected fraction exceeds threshold.
  if (
    input.totalTestablePaths > 0 &&
    input.affectedClosureSize / input.totalTestablePaths >
      input.policy.affectedClosureThreshold
  ) {
    scope = promoteScope(scope, 'FULL');
  }

  return scope;
}

// ── scopeIncludes ─────────────────────────────────────────────────────────────

/**
 * True iff `actual` scope satisfies `required` (i.e. actual ≥ required in the lattice).
 * Used by CompletionGate to check report.scope ≥ requiredScope (§10.1).
 */
export function scopeIncludes(
  actual: VerificationScope,
  required: VerificationScope,
): boolean {
  return SCOPE_LATTICE[actual] >= SCOPE_LATTICE[required];
}
