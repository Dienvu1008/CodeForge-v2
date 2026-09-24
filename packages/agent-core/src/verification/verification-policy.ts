// VerificationPolicy — VERIFICATION_PROTOCOL §9, P1.5-VR1.
//
// Deterministic struct and default values for verification configuration.
// resolvePolicy() is a pure function — no LLM, no I/O (VR-010).
import type { VerificationScope, CheckKind } from '../domain/verification.js';

// ── CheckDefinition ───────────────────────────────────────────────────────────

/** A single check the engine will run via ProcessSupervisor. */
export interface CheckDefinition {
  readonly name: string;
  readonly kind: CheckKind;
  readonly command: string;
  readonly args: readonly string[];
  /** Minimum scope at which this check applies (skipped for lower scopes). */
  readonly minScope: VerificationScope;
  readonly timeoutMs: number;
}

// ── ScratchZone ───────────────────────────────────────────────────────────────

/** A relative-path prefix that belongs to the declared scratch zone. */
export interface ScratchZone {
  readonly relpath: string;
}

// ── ScopeRule ─────────────────────────────────────────────────────────────────

export interface ScopeRule {
  /** Minimum required scope for this policy context. */
  readonly minimumScope: VerificationScope;
  readonly reason: string;
}

// ── VerificationPolicy ────────────────────────────────────────────────────────

export interface VerificationPolicy {
  readonly policyId: string;
  readonly version: number;

  /** Minimum scope that will never be demoted within a verification run. */
  readonly minimumScope: VerificationScope;

  /** Required scope for the completion gate on a typical task. */
  readonly requiredScope: VerificationScope;

  readonly checks: readonly CheckDefinition[];

  readonly scratchZones: readonly ScratchZone[];

  /**
   * Stop after the first failing check.
   * Default: true for SMOKE/AFFECTED_DIRECT, false for FULL.
   */
  readonly failFast: boolean;

  /**
   * If affectedClosure.size / totalTestablePaths > threshold, promote to FULL.
   * Default: 0.5 (§4.7).
   */
  readonly affectedClosureThreshold: number;

  /** Tool versions to record in the report (VR-009). */
  readonly toolVersions: Readonly<Record<string, string>>;

  /** Schema version for this policy record. */
  readonly schemaVersion: number;
}

// ── Default policies ──────────────────────────────────────────────────────────

/**
 * Standard per-task policy.
 * Scope: AFFECTED_DIRECT (§3.3 minimum for per-task verification).
 * Checks: none by default — callers inject concrete check definitions.
 * Phase 1.5: FakeProcessSupervisor provides deterministic results.
 */
export const DEFAULT_VERIFICATION_POLICY: VerificationPolicy = {
  policyId: 'default-task-v1',
  version: 1,
  minimumScope: 'AFFECTED_DIRECT',
  requiredScope: 'AFFECTED_DIRECT',
  checks: [],
  scratchZones: [],
  failFast: true,
  affectedClosureThreshold: 0.5,
  toolVersions: {},
  schemaVersion: 1,
};

/**
 * Policy for final-graph verification (VR-004: scope ≥ AFFECTED_CLOSURE).
 */
export const GRAPH_FINAL_VERIFICATION_POLICY: VerificationPolicy = {
  ...DEFAULT_VERIFICATION_POLICY,
  policyId: 'graph-final-v1',
  minimumScope: 'AFFECTED_CLOSURE',
  requiredScope: 'AFFECTED_CLOSURE',
  failFast: false,
};

/**
 * Smoke-only policy for small tasks (§3.3: allowed when policy permits).
 */
export const SMOKE_VERIFICATION_POLICY: VerificationPolicy = {
  ...DEFAULT_VERIFICATION_POLICY,
  policyId: 'smoke-v1',
  minimumScope: 'SMOKE',
  requiredScope: 'SMOKE',
  failFast: true,
};

// ── resolvePolicy ─────────────────────────────────────────────────────────────

export interface PolicyResolutionContext {
  /** Override policy (e.g. for graph-final verification). */
  readonly override?: VerificationPolicy;
  /** Whether this is the final graph verification pass (→ AFFECTED_CLOSURE minimum). */
  readonly isFinalGraph?: boolean;
}

/**
 * Resolve the VerificationPolicy to use. Pure + deterministic (VR-010).
 * No LLM, no wall-clock.
 */
export function resolvePolicy(
  base: VerificationPolicy,
  ctx: PolicyResolutionContext = {},
): VerificationPolicy {
  if (ctx.override !== undefined) return ctx.override;
  if (ctx.isFinalGraph === true) return { ...base, ...GRAPH_FINAL_VERIFICATION_POLICY };
  return base;
}
