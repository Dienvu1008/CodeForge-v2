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

// ── Architecture blueprint (§16) — Phase 12 (P12.6) ─────────────────────────────

/**
 * A proposed module boundary in the architecture (§16). Describes a cohesive unit of the
 * system and what it is responsible for. Advisory: the Planner still decides the actual Tasks.
 */
export interface ModuleBoundary {
  readonly name: string;
  readonly responsibility: string;
  /** Names of other modules this one is allowed to depend on (dependency direction). */
  readonly dependsOn: readonly string[];
}

/**
 * A roadmap phase (§16). The architecture proposes an ORDER of work; it never creates Tasks or
 * Graph (MI-004) — the Planner remains the only authority that produces the Graph (GI-009).
 */
export interface RoadmapPhase {
  readonly name: string;
  readonly outcome: string;
  /** Capability names this phase depends on being VERIFIED (checked by the gate). */
  readonly requiresCapabilities: readonly string[];
}

/**
 * The architecture blueprint produced by the MissionArchitect for complex missions (§16).
 *
 * This is an UNTRUSTED LLM PROPOSAL (SE-010) that has passed structured validation (MG-002).
 * It is EVIDENCE for the ArchitectureGate and prompt context for planning — never authority
 * (MI-001). It does not mutate the Goal and does not create Tasks/Graph (MI-004).
 */
export interface Architecture {
  readonly missionId: string;
  /** One-paragraph summary of the chosen approach. */
  readonly summary: string;
  /** Requirements the architecture claims to address (traced against the mission's acceptance). */
  readonly requirements: readonly string[];
  /** Explicit assumptions the architect made (surfaced so the gate/human can check them). */
  readonly assumptions: readonly string[];
  /** Technology choices (e.g. 'TypeScript', 'Postgres') — advisory. */
  readonly techChoices: readonly string[];
  readonly moduleBoundaries: readonly ModuleBoundary[];
  /** Proposed top-level folder layout (strings like 'src/domain', 'src/adapters'). */
  readonly folderHierarchy: readonly string[];
  /** Ordered roadmap of phases (advisory ordering, not Tasks). */
  readonly roadmap: readonly RoadmapPhase[];
  /** How the result will be verified (maps toward acceptance criteria). */
  readonly verificationStrategy: readonly string[];
  /** Known risks the architect flagged. */
  readonly risks: readonly string[];
  /** Open questions the architect could not resolve (drives the gate's uncertainty check). */
  readonly openQuestions: readonly string[];
  /** Capability names the architecture requires to exist (gate checks these are VERIFIED). */
  readonly requiredCapabilities: readonly string[];
  readonly provenance: Provenance;
  readonly createdAt: string;
}

// ── Architecture gate result (§16/§18) — Phase 12 (P12.6) ────────────────────────

export type ArchitectureVerdict = 'PASS' | 'BLOCK';

/**
 * The deterministic outcome of evaluating an Architecture against the mission + preflight.
 * BLOCK means the caller must stop and move the session to AWAITING_HUMAN (MI-007); the gate
 * itself never transitions state — it only returns a verdict (DC-* / pure).
 */
export interface ArchitectureGateResult {
  readonly verdict: ArchitectureVerdict;
  /** Concrete blockers (empty iff PASS). Human-readable, stable order. */
  readonly blockers: readonly string[];
  /** Deterministic reasons the gate reached this verdict (both PASS and BLOCK). */
  readonly reasons: readonly string[];
}

/** Current Mission schema version (bump when the shape changes). */
export const MISSION_VERSION = 1;
