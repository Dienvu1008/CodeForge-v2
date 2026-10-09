// MissionContextStrategy — Phase 12 (P12.7). §19. Deterministic mapping from a Mission to a
// recommended context scope for the ContextBuilder, so a trivial task does not load the whole
// repository (CX-005: context is bounded; cost scales with the mission, §34).
//
// Advisory (MI-001): this RECOMMENDS a scope. The ContextBuilder/Retriever + token budgeter
// remain the authority on what actually enters a snapshot (and the snapshot stays provenance-
// tracked and size-bounded regardless). Pure: same mission → same recommendation.
import type { Mission, ContextScope, MissionType, Complexity } from '../domain/mission.js';
import { DEFAULT_CONTEXT_POLICY, type ContextPolicy } from '../context/context-builder.js';

export interface ContextStrategy {
  readonly scope: ContextScope;
  /** Soft cap on files to retrieve for this scope (hint for the budgeter, not a hard limit). */
  readonly maxFiles: number;
  /** Whether cross-file / repository-wide retrieval is warranted. */
  readonly repositoryWide: boolean;
  readonly reason: string;
}

/**
 * ContextPlan — the FLATTENED, serializable subset of a ContextStrategy that is threaded through
 * the orchestrator seam into each TaskExecutorRequest (same pattern as Tier B2's assumptions).
 * It drops `reason` (log/emit only) and carries just the three fields that actually steer
 * retrieval. Advisory (MI-001): it changes HOW MUCH / HOW WIDE context is gathered, never WHAT is
 * authoritative; absent ⇒ callers fall back to defaults (fail-safe parity).
 */
export interface ContextPlan {
  readonly scope: ContextScope;
  readonly maxFiles: number;
  readonly repositoryWide: boolean;
}

/** Project a ContextStrategy to its serializable ContextPlan (drops the human-readable reason). */
export function toContextPlan(strategy: ContextStrategy): ContextPlan {
  return { scope: strategy.scope, maxFiles: strategy.maxFiles, repositoryWide: strategy.repositoryWide };
}

/**
 * Translate a ContextPlan into a concrete ContextPolicy for the ContextBuilder. This is the
 * deliberate scope→budget mapping (one "file" can produce several context items — symbols —
 * so maxItems is NOT a 1:1 copy of maxFiles). Token budgets step by scope rather than scaling
 * linearly. These numbers are an initial proposal to be tuned by the context benchmark; the
 * TokenBudgeter (CX-004) remains the final authority — this only sets soft caps. Pure + total.
 */
export function policyFromContextPlan(plan: ContextPlan): ContextPolicy {
  // maxItems ≈ 2× the file cap (files + their symbols/snippets), clamped to a sane band.
  const maxItems = Math.min(60, Math.max(8, Math.round(plan.maxFiles * 2)));
  // Token budget steps by scope (discrete tiers, not a linear function of maxFiles).
  const availableTokens =
    plan.scope === 'TASK' || plan.scope === 'FILE' ? 4096 :
    plan.scope === 'MODULE'                        ? 8192 :
    /* REPOSITORY / MULTI_REPOSITORY / EXTERNAL_RESEARCH */ 12288;
  return {
    ...DEFAULT_CONTEXT_POLICY,
    policyId: `cx-${plan.scope.toLowerCase()}`,
    availableTokens,
    maxItems,
  };
}

// Deterministic soft file caps per scope (hints only; CX-005 budgeter stays authoritative).
const MAX_FILES: Record<ContextScope, number> = {
  TASK: 3,
  FILE: 5,
  MODULE: 25,
  REPOSITORY: 150,
  MULTI_REPOSITORY: 400,
  EXTERNAL_RESEARCH: 150,
};

const REPO_WIDE_TYPES = new Set<MissionType>([
  'PROJECT', 'ARCHITECTURE', 'MIGRATION', 'MULTI_REPOSITORY', 'REFACTOR',
]);

/**
 * Recommend a context scope for a mission. The mission already carries a `contextScope`
 * (computed from signals during intake); this strategy refines it into an actionable scope +
 * budget hint, widening ONLY when the mission type/complexity justifies it (never defaulting to
 * repository-wide for trivial work). Ordered rules, first match wins.
 */
export function decideContextStrategy(mission: Mission): ContextStrategy {
  const type: MissionType = mission.missionType;
  const level: Complexity = mission.complexity.level;
  const declared: ContextScope = mission.contextScope;

  // 1. Multi-repo missions are inherently cross-repository.
  if (type === 'MULTI_REPOSITORY' || declared === 'MULTI_REPOSITORY') {
    return strat('MULTI_REPOSITORY', true, `multi-repository mission (type=${type})`);
  }

  // 2. Research/external missions need wide (but repo-bounded) retrieval.
  if (type === 'RESEARCH' || declared === 'EXTERNAL_RESEARCH') {
    return strat('EXTERNAL_RESEARCH', true, `research mission (type=${type})`);
  }

  // 3. SYSTEM-level complexity or architecture/project work → repository scope.
  if (level === 'SYSTEM' || REPO_WIDE_TYPES.has(type) || declared === 'REPOSITORY') {
    return strat('REPOSITORY', true, `repository-wide (type=${type}, complexity=${level})`);
  }

  // 4. HIGH complexity or module-scoped declared → module scope.
  if (level === 'HIGH' || declared === 'MODULE') {
    return strat('MODULE', false, `module scope (type=${type}, complexity=${level})`);
  }

  // 5. MEDIUM complexity or file-scoped declared → file scope.
  if (level === 'MEDIUM' || declared === 'FILE') {
    return strat('FILE', false, `file scope (complexity=${level})`);
  }

  // 6. Trivial → the narrowest useful scope (CX-005: do not load the repo for a one-liner).
  return strat('TASK', false, `task scope (complexity=${level})`);
}

function strat(scope: ContextScope, repositoryWide: boolean, reason: string): ContextStrategy {
  return { scope, maxFiles: MAX_FILES[scope], repositoryWide, reason };
}
