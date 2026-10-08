// Mission — Phase 12 (P12.1). The strategic projection of a Goal, computed BEFORE planning.
//
// A Mission is NOT a Task and NOT a Goal. It is an advisory analysis of a user's Goal that
// the Mission Intelligence layer produces to decide HOW to approach the work: what kind of
// mission it is, how complex/risky, what capabilities and model it needs, which planning mode
// to use, and (for complex missions) whether an architecture gate must run first.
//
// Authority rules (MI-001, MI-004):
//   - A Mission is EVIDENCE/ADVISORY. It never mutates the Goal (GL-*), never creates Tasks or
//     Graph (only Planner + GraphCommit do, GI-009), and never decides tool/approval/state.
//   - Every field here is either a deterministic classification or an LLM proposal that has
//     already passed a deterministic gate. The runtime remains the authority.
//
// This file is pure domain types. Analyzers/gates/routers live under ../mission/.
import type { Constraint, AcceptanceCriterion } from './common.js';
import type { Provenance } from './provenance.js';

// ── Mission type (extensible taxonomy, §4) ──────────────────────────────────────

export type MissionType =
  | 'BUG_FIX'
  | 'FEATURE'
  | 'REFACTOR'
  | 'MIGRATION'
  | 'PROJECT'
  | 'RESEARCH'
  | 'ARCHITECTURE'
  | 'PERFORMANCE'
  | 'TESTING'
  | 'DOCUMENTATION'
  | 'MULTI_REPOSITORY'
  | 'EXPERIMENT'
  | 'AUTOMATION'
  | 'UNKNOWN';

// ── Complexity (§5) ─────────────────────────────────────────────────────────────

export type Complexity = 'LOW' | 'MEDIUM' | 'HIGH' | 'SYSTEM';

export interface ComplexityAssessment {
  readonly level: Complexity;
  /** 0.0–1.0 confidence in the classification. */
  readonly confidence: number;
  /** Deterministic reasons (human-readable), e.g. "cross-platform target". Sorted/stable. */
  readonly reasons: readonly string[];
  /**
   * Whether an LLM advisory signal contributed. The advisory signal is already clamped by
   * the MissionGate; this flag is for observability/provenance only, not authority.
   */
  readonly usedAdvisory: boolean;
}

// ── Risk (§6) ───────────────────────────────────────────────────────────────────

export type RiskDimension =
  | 'READ_ONLY'
  | 'LOCAL_EDIT'
  | 'BUILD'
  | 'NETWORK'
  | 'CREDENTIAL'
  | 'SYSTEM_CHANGE'
  | 'DESTRUCTIVE'
  | 'DATABASE'
  | 'DEPLOYMENT'
  | 'EXTERNAL_SERVICE'
  | 'SECURITY_SENSITIVE';

export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface RiskAssessment {
  readonly level: RiskLevel;
  readonly factors: readonly RiskDimension[];
  /**
   * What this risk level SHOULD require. The existing approval/policy system stays
   * authoritative (§6) — this is a recommendation, not an enforcement.
   */
  readonly requiredApprovals: readonly RiskDimension[];
  readonly requiredVerification: readonly string[];
}

// ── Context scope (§19) ─────────────────────────────────────────────────────────

export type ContextScope =
  | 'TASK'
  | 'FILE'
  | 'MODULE'
  | 'REPOSITORY'
  | 'MULTI_REPOSITORY'
  | 'EXTERNAL_RESEARCH';

// ── Uncertainty (§26) ───────────────────────────────────────────────────────────

export type UncertaintyLevel = 'KNOWN' | 'INFERRED' | 'UNKNOWN' | 'CONFLICTING' | 'BLOCKED';

export interface Uncertainty {
  readonly level: UncertaintyLevel;
  /** Specific open questions / conflicts, if any. */
  readonly openQuestions: readonly string[];
}

// ── Planning mode (§15) ─────────────────────────────────────────────────────────

export type PlanningMode =
  | 'DIRECT'
  | 'LOCAL_PLAN'
  | 'ARCHITECTURE_FIRST'
  | 'RESEARCH_FIRST'
  | 'MIGRATION_PLAN'
  | 'EXPERIMENT';

// ── Capabilities (§7–§10) ───────────────────────────────────────────────────────

/**
 * Status of a capability (§9). Only VERIFIED (evidence from a real command via
 * ProcessSupervisor) may be treated as an execution prerequisite (MI-003).
 */
export type CapabilityStatus =
  | 'VERIFIED'
  | 'AVAILABLE'
  | 'UNAVAILABLE'
  | 'UNKNOWN'
  | 'STALE';

/** Where a capability lives (§10): the machine vs the current workspace. */
export type CapabilityScope = 'machine' | 'workspace';

export interface Capability {
  /** Stable identifier, e.g. 'flutter', 'node', 'docker', 'git', 'android-sdk'. */
  readonly name: string;
  readonly scope: CapabilityScope;
  readonly status: CapabilityStatus;
  /** Detected version string, when available (e.g. '3.22.0'). */
  readonly version?: string;
  /** Evidence of verification: the command run + a trimmed snippet of its output. */
  readonly evidence?: string;
  /** What this capability ENABLES (§8), e.g. ['build_windows','build_android','test']. */
  readonly enables: readonly string[];
  /** ISO timestamp of the last verification; drives STALE via TTL. */
  readonly lastVerified?: string;
}

/** The machine-readable preflight result (§11). */
export interface PreflightReport {
  readonly missionId: string;
  readonly machine: readonly Capability[];
  readonly workspace: readonly Capability[];
  readonly aiModels: readonly string[];
  /** 0–100 readiness, deterministic over required-vs-verified capabilities. */
  readonly readiness: number;
  /** Required capabilities that are not VERIFIED → block or warn. */
  readonly blockers: readonly string[];
  readonly warnings: readonly string[];
  readonly createdAt: string;
}

// ── Model requirements (§12) ────────────────────────────────────────────────────

export type RequirementLevel = 'LOW' | 'MEDIUM' | 'HIGH';
export type ContextSizeNeed = 'SMALL' | 'MEDIUM' | 'LARGE';

export interface ModelRequirement {
  readonly reasoning: RequirementLevel;
  readonly coding: RequirementLevel;
  readonly architecture: RequirementLevel;
  readonly context: ContextSizeNeed;
  readonly toolUse: RequirementLevel;
  /** Whether low latency is prioritized over capability (trivial tasks). */
  readonly latencySensitive: boolean;
}

// ── Expert profile (§17) — prompt context, never authority (MI-008, SE-010) ──────

export interface ExpertProfile {
  readonly domain: string;
  readonly expertise: readonly string[];
  readonly responsibilities: readonly string[];
  readonly constraints: readonly string[];
  readonly preferredPractices: readonly string[];
}

// ── Mission (the aggregate) ─────────────────────────────────────────────────────

/**
 * Whether this mission requires an architecture stage before planning (§16/§18).
 * NOT_REQUIRED for trivial/medium work; REQUIRED for HIGH/SYSTEM or high uncertainty.
 */
export type ArchitectureRequirement = 'NOT_REQUIRED' | 'RECOMMENDED' | 'REQUIRED';

export interface Mission {
  readonly missionId: string; // ULID
  /** The Goal this mission analyzes. The Goal is immutable (GL-*); the mission never edits it. */
  readonly goalId: string;

  /** Raw user goal text (copied for provenance; the Goal remains the source of truth). */
  readonly userGoal: string;
  /** Normalized/condensed restatement used for downstream prompts. */
  readonly normalizedGoal: string;

  readonly missionType: MissionType;
  readonly complexity: ComplexityAssessment;
  readonly risk: RiskAssessment;
  readonly uncertainty: Uncertainty;

  readonly contextScope: ContextScope;
  readonly planningMode: PlanningMode;
  readonly architectureRequirement: ArchitectureRequirement;

  /** Capability names this mission needs (resolved against the preflight report). */
  readonly capabilityRequirements: readonly string[];
  readonly modelRequirement: ModelRequirement;
  /** Whether external research is flagged (§20) — a marker; execution stays policy-governed. */
  readonly researchRequired: boolean;

  /** Mission-level constraints/acceptance mirrored from the Goal (read-only copies). */
  readonly constraints: readonly Constraint[];
  readonly acceptanceCriteria: readonly AcceptanceCriterion[];

  readonly provenance: Provenance;
  readonly createdAt: string;
}

/** Current Mission schema version (bump when the shape changes). */
export const MISSION_VERSION = 1;
