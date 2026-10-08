// Model Registry + Requirement Analyzer + Router — Phase 12 (P12.4).
//
// MI-006: the router selects ONLY from models that are actually registered (real, available).
// An advisory recommendation (e.g. "use model X") that names an unregistered model is ignored;
// the router picks the best valid candidate instead, and when nothing qualifies it ESCALATES.
// This does NOT change the ModelGateway contract — it decides WHICH registered model-id to use;
// the runtime still talks to a single gateway per call.
//
// Pure + deterministic: analysis and routing are total functions of (mission, registry).
import type {
  Mission,
  ModelRequirement,
  RequirementLevel,
  ContextSizeNeed,
} from '../domain/mission.js';

// ── Model registry (option (a): an injected list of real, available models) ──────

/** Capability tags describing what a registered model is good at (0.0–1.0 or level). */
export interface ModelCapabilities {
  readonly reasoning: RequirementLevel;
  readonly coding: RequirementLevel;
  readonly architecture: RequirementLevel;
  /** Max context the model supports, as a coarse size class. */
  readonly context: ContextSizeNeed;
  readonly toolUse: RequirementLevel;
  /** Relative latency class — SMALL models are faster/cheaper. */
  readonly speed: 'FAST' | 'MEDIUM' | 'SLOW';
}

/** A model that is ACTUALLY available (verified present, e.g. installed in Ollama). */
export interface RegisteredModel {
  /** The model id passed to the gateway, e.g. 'qwen2.5-coder:latest'. */
  readonly id: string;
  /** Coarse tier for human-facing routing explanations. */
  readonly tier: 'SMALL' | 'MEDIUM' | 'STRONG' | 'ARCHITECTURE';
  readonly capabilities: ModelCapabilities;
}

/** The set of registered models. Built from a real list (injected / later /api/tags). */
export class ModelRegistry {
  private readonly models: readonly RegisteredModel[];
  constructor(models: readonly RegisteredModel[]) {
    // Keep a stable, de-duplicated-by-id, sorted copy (determinism).
    const seen = new Set<string>();
    const unique: RegisteredModel[] = [];
    for (const m of [...models].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      unique.push(m);
    }
    this.models = unique;
  }
  list(): readonly RegisteredModel[] { return this.models; }
  has(id: string): boolean { return this.models.some((m) => m.id === id); }
  get(id: string): RegisteredModel | undefined { return this.models.find((m) => m.id === id); }
  isEmpty(): boolean { return this.models.length === 0; }
}

// ── Model requirement analysis (§12) ─────────────────────────────────────────────

const HEAVY_TYPES = new Set(['PROJECT', 'MIGRATION', 'ARCHITECTURE', 'MULTI_REPOSITORY']);

/**
 * Derive a ModelRequirement from a Mission. Deterministic over complexity/type/risk/scope.
 * Trivial missions ask for a fast, low-capability model (latency-sensitive); complex/architectural
 * missions ask for strong reasoning + architecture + large context, latency not prioritized.
 */
export function analyzeModelRequirement(mission: Mission): ModelRequirement {
  const level = mission.complexity.level;
  const heavyType = HEAVY_TYPES.has(mission.missionType);
  const needsArchitecture = mission.architectureRequirement !== 'NOT_REQUIRED' || heavyType;

  const byComplexity = (low: RequirementLevel, mid: RequirementLevel, high: RequirementLevel): RequirementLevel =>
    level === 'LOW' ? low : level === 'MEDIUM' ? mid : high;

  const reasoning: RequirementLevel = byComplexity('LOW', 'MEDIUM', 'HIGH');
  const coding: RequirementLevel = byComplexity('LOW', 'MEDIUM', 'HIGH');
  const architecture: RequirementLevel = needsArchitecture ? 'HIGH' : byComplexity('LOW', 'LOW', 'MEDIUM');
  const context: ContextSizeNeed =
    level === 'SYSTEM' || mission.contextScope === 'REPOSITORY' || mission.contextScope === 'MULTI_REPOSITORY'
      ? 'LARGE'
      : level === 'HIGH' || mission.contextScope === 'MODULE' ? 'MEDIUM' : 'SMALL';
  const toolUse: RequirementLevel = byComplexity('LOW', 'MEDIUM', 'HIGH');
  const latencySensitive = level === 'LOW';

  return { reasoning, coding, architecture, context, toolUse, latencySensitive };
}

// ── Routing (§13) ────────────────────────────────────────────────────────────────

export type RoutingOutcome =
  | { readonly kind: 'selected'; readonly model: RegisteredModel; readonly reason: string }
  | { readonly kind: 'fallback'; readonly model: RegisteredModel; readonly reason: string }
  | { readonly kind: 'escalate'; readonly reason: string };

const LEVEL_SCORE: Record<RequirementLevel, number> = { LOW: 0, MEDIUM: 1, HIGH: 2 };
const CTX_SCORE: Record<ContextSizeNeed, number> = { SMALL: 0, MEDIUM: 1, LARGE: 2 };

/** True when a model meets or exceeds every dimension of the requirement. */
function meets(model: RegisteredModel, req: ModelRequirement): boolean {
  const c = model.capabilities;
  return (
    LEVEL_SCORE[c.reasoning] >= LEVEL_SCORE[req.reasoning] &&
    LEVEL_SCORE[c.coding] >= LEVEL_SCORE[req.coding] &&
    LEVEL_SCORE[c.architecture] >= LEVEL_SCORE[req.architecture] &&
    CTX_SCORE[c.context] >= CTX_SCORE[req.context] &&
    LEVEL_SCORE[c.toolUse] >= LEVEL_SCORE[req.toolUse]
  );
}

/** Total "strength" of a model (for ranking qualified candidates). */
function strength(m: RegisteredModel): number {
  const c = m.capabilities;
  return LEVEL_SCORE[c.reasoning] + LEVEL_SCORE[c.coding] + LEVEL_SCORE[c.architecture] + CTX_SCORE[c.context] + LEVEL_SCORE[c.toolUse];
}

const SPEED_RANK: Record<ModelCapabilities['speed'], number> = { FAST: 0, MEDIUM: 1, SLOW: 2 };

/**
 * Route a requirement to a registered model (MI-006).
 *
 *   - If a `preferred` id is given AND it is registered AND it meets the requirement → selected.
 *     (A preferred id that is NOT registered is IGNORED — never routed to a non-existent model.)
 *   - Otherwise choose the WEAKEST model that still meets the requirement (don't overspend;
 *     latency-sensitive missions prefer FAST among equals). → selected.
 *   - If no model meets the requirement but the registry is non-empty → fallback to the STRONGEST
 *     available model (best effort), flagged as 'fallback' so the caller/observer knows.
 *   - If the registry is empty → escalate (no model to run at all).
 */
export function routeModel(
  req: ModelRequirement,
  registry: ModelRegistry,
  preferred?: string,
): RoutingOutcome {
  if (registry.isEmpty()) {
    return { kind: 'escalate', reason: 'no models registered — cannot route (MI-006)' };
  }

  const all = registry.list();
  const qualified = all.filter((m) => meets(m, req));

  // Honor a preferred model ONLY if it is registered and qualifies (MI-006: never invent one).
  if (preferred !== undefined) {
    const pm = registry.get(preferred);
    if (pm !== undefined && meets(pm, req)) {
      return { kind: 'selected', model: pm, reason: `preferred model ${preferred} is registered and meets requirements` };
    }
    // preferred is unregistered or under-qualified → ignore it and route normally.
  }

  if (qualified.length > 0) {
    // Cheapest-that-suffices: least strength first, then FAST first, then id asc (stable).
    const pick = [...qualified].sort((a, b) =>
      strength(a) - strength(b)
      || (req.latencySensitive ? SPEED_RANK[a.capabilities.speed] - SPEED_RANK[b.capabilities.speed] : 0)
      || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    )[0]!;
    return { kind: 'selected', model: pick, reason: `${pick.id} is the cheapest registered model meeting the requirement` };
  }

  // Nothing qualifies — fall back to the strongest available (best effort), flagged.
  const strongest = [...all].sort((a, b) => strength(b) - strength(a) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0]!;
  return {
    kind: 'fallback',
    model: strongest,
    reason: `no registered model fully meets the requirement; falling back to strongest available (${strongest.id})`,
  };
}
