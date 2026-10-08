// MissionArchitect — Phase 12 (P12.6). §16. For complex missions (HIGH/SYSTEM or architecture
// REQUIRED), ask the model for an architecture blueprint via the structured-output pipeline.
//
// Authority rules:
//   MI-001: the blueprint is ADVISORY. It is EVIDENCE for the ArchitectureGate and prompt
//           context for planning — never authority. The Planner/kernel still own Tasks + Graph.
//   MI-004: the architect never mutates the Goal and never creates Tasks/Graph.
//   MI-008: the ExpertProfile rendered into the prompt is untrusted prompt-context, not authority.
//   SE-010 / MG-002: the model output is UNTRUSTED and MUST pass structured validation
//           (parse → schema → semantic) before it becomes an Architecture proposal.
//   MG-001: the single LLM call goes through the injected ModelGateway.
//
// This module is pure orchestration over an injected gateway + clock + id source (DC-002).
import type { ModelGateway } from '../model/gateway.js';
import { parseModelOutput, modelRequest, type OutputSchema } from '../model/structured-output-parser.js';
import { BOUNDARY_SYSTEM_PREAMBLE, buildPrompt } from '../security/prompt-boundary.js';
import type {
  Architecture,
  ExpertProfile,
  Mission,
  ModuleBoundary,
  RoadmapPhase,
} from '../domain/mission.js';
import { renderExpertProfile } from './expert-profile.js';

// ── Deps ────────────────────────────────────────────────────────────────────────

export interface MissionArchitectDeps {
  readonly gateway: ModelGateway;
  readonly now: () => string;          // ISO timestamp
  readonly newProvenanceId: () => string;
}

// ── Raw model-output shape (before mapping to the domain Architecture) ───────────

/** Schema the model output must satisfy (MG-002, Stage 2). Only top-level fields are checked
 * by the validator; array element shapes are checked in the semantic hook. */
const ARCHITECTURE_SCHEMA: OutputSchema = {
  summary: { type: 'string', required: true },
  requirements: { type: 'array', required: true },
  assumptions: { type: 'array', required: false },
  techChoices: { type: 'array', required: false },
  moduleBoundaries: { type: 'array', required: true },
  folderHierarchy: { type: 'array', required: false },
  roadmap: { type: 'array', required: true },
  verificationStrategy: { type: 'array', required: true },
  risks: { type: 'array', required: false },
  openQuestions: { type: 'array', required: false },
  requiredCapabilities: { type: 'array', required: false },
};

interface RawArchitecture {
  readonly summary?: unknown;
  readonly requirements?: unknown;
  readonly assumptions?: unknown;
  readonly techChoices?: unknown;
  readonly moduleBoundaries?: unknown;
  readonly folderHierarchy?: unknown;
  readonly roadmap?: unknown;
  readonly verificationStrategy?: unknown;
  readonly risks?: unknown;
  readonly openQuestions?: unknown;
  readonly requiredCapabilities?: unknown;
}

// ── MissionArchitect ──────────────────────────────────────────────────────────

export class MissionArchitect {
  constructor(private readonly deps: MissionArchitectDeps) {}

  /**
   * Whether this mission warrants an architecture blueprint (§16). Deterministic predicate so the
   * caller can skip the LLM call entirely for trivial work (MI-002 fast-path / §34):
   *   - architectureRequirement REQUIRED or RECOMMENDED, OR
   *   - complexity HIGH or SYSTEM.
   * Pure — no I/O.
   */
  static needsArchitecture(mission: Mission): boolean {
    if (mission.architectureRequirement === 'REQUIRED' || mission.architectureRequirement === 'RECOMMENDED') {
      return true;
    }
    return mission.complexity.level === 'HIGH' || mission.complexity.level === 'SYSTEM';
  }

  /**
   * Produce an architecture blueprint for a complex mission. Calls the model once through the
   * structured-output pipeline (schema + semantic validation + bounded retry). The returned
   * Architecture is a validated PROPOSAL (MI-001) — the ArchitectureGate decides PASS/BLOCK next.
   *
   * Throws ModelError if the model output cannot be validated after bounded retries (MG-003).
   */
  async architect(
    mission: Mission,
    expertProfile: ExpertProfile,
    verifiedCapabilities: readonly string[],
  ): Promise<Architecture> {
    const system = `${BOUNDARY_SYSTEM_PREAMBLE}\n\n${renderExpertProfile(expertProfile)}\n\n${ARCHITECT_INSTRUCTIONS}`;

    // The mission facts are trusted runtime-derived data; the raw user goal is untrusted (SE-001).
    const taskPrompt = buildPrompt([
      {
        label: 'MISSION',
        content: [
          `type: ${mission.missionType}`,
          `complexity: ${mission.complexity.level}`,
          `planningMode: ${mission.planningMode}`,
          `contextScope: ${mission.contextScope}`,
          `architectureRequirement: ${mission.architectureRequirement}`,
          `verifiedCapabilities: ${verifiedCapabilities.length > 0 ? verifiedCapabilities.join(', ') : '(none verified)'}`,
        ].join('\n'),
        trust: 'trusted',
      },
      { label: 'GOAL', content: mission.normalizedGoal, trust: 'untrusted' },
      {
        label: 'ACCEPTANCE',
        content:
          mission.acceptanceCriteria.length > 0
            ? mission.acceptanceCriteria.map((a) => `- ${a.description}`).join('\n')
            : '(no explicit acceptance criteria)',
        trust: 'untrusted',
      },
      { label: 'OUTPUT', content: OUTPUT_CONTRACT, trust: 'trusted' },
    ]);

    const request = modelRequest('architect', system, taskPrompt, {
      maxOutputTokens: 4096,
      temperature: 0,
    });

    const raw = await parseModelOutput<RawArchitecture>(this.deps.gateway, request, {
      schema: ARCHITECTURE_SCHEMA,
      purpose: 'architect',
      semanticCheck: semanticCheckArchitecture,
      retryFeedback: (msg) =>
        `Your previous output was rejected: ${msg}. Return ONLY a single JSON object matching the required shape.`,
    });

    return mapToArchitecture(raw, mission, this.deps.now(), this.deps.newProvenanceId());
  }
}

// ── Semantic check (MG-002, Stage 3) ─────────────────────────────────────────────

/**
 * Business-rule validation beyond the flat schema: array elements must have the right shape,
 * and the required arrays must be non-empty (an architecture with no modules/roadmap/
 * verification is not usable). Returns a rejection reason or undefined.
 */
function semanticCheckArchitecture(parsed: unknown): string | undefined {
  const obj = parsed as RawArchitecture;

  if (asStringArray(obj.requirements).length === 0) return 'requirements must be a non-empty array of strings';
  if (asStringArray(obj.verificationStrategy).length === 0) {
    return 'verificationStrategy must be a non-empty array of strings';
  }

  const modules = obj.moduleBoundaries;
  if (!Array.isArray(modules) || modules.length === 0) {
    return 'moduleBoundaries must be a non-empty array';
  }
  for (const m of modules) {
    if (typeof m !== 'object' || m === null) return 'each moduleBoundary must be an object';
    const mm = m as Record<string, unknown>;
    if (typeof mm.name !== 'string' || mm.name.trim() === '') return 'each moduleBoundary needs a name';
    if (typeof mm.responsibility !== 'string' || mm.responsibility.trim() === '') {
      return 'each moduleBoundary needs a responsibility';
    }
  }

  const roadmap = obj.roadmap;
  if (!Array.isArray(roadmap) || roadmap.length === 0) {
    return 'roadmap must be a non-empty array';
  }
  for (const p of roadmap) {
    if (typeof p !== 'object' || p === null) return 'each roadmap phase must be an object';
    const pp = p as Record<string, unknown>;
    if (typeof pp.name !== 'string' || pp.name.trim() === '') return 'each roadmap phase needs a name';
    if (typeof pp.outcome !== 'string' || pp.outcome.trim() === '') return 'each roadmap phase needs an outcome';
  }

  return undefined;
}

// ── Mapping (untrusted raw → domain Architecture) ────────────────────────────────

function mapToArchitecture(
  raw: RawArchitecture,
  mission: Mission,
  at: string,
  provenanceId: string,
): Architecture {
  const moduleBoundaries: ModuleBoundary[] = (Array.isArray(raw.moduleBoundaries) ? raw.moduleBoundaries : [])
    .filter((m): m is Record<string, unknown> => typeof m === 'object' && m !== null)
    .map((m) => ({
      name: String(m.name),
      responsibility: String(m.responsibility),
      dependsOn: asStringArray(m.dependsOn),
    }));

  const roadmap: RoadmapPhase[] = (Array.isArray(raw.roadmap) ? raw.roadmap : [])
    .filter((p): p is Record<string, unknown> => typeof p === 'object' && p !== null)
    .map((p) => ({
      name: String(p.name),
      outcome: String(p.outcome),
      requiresCapabilities: asStringArray(p.requiresCapabilities),
    }));

  return {
    missionId: mission.missionId,
    summary: typeof raw.summary === 'string' ? raw.summary : '',
    requirements: asStringArray(raw.requirements),
    assumptions: asStringArray(raw.assumptions),
    techChoices: asStringArray(raw.techChoices),
    moduleBoundaries,
    folderHierarchy: asStringArray(raw.folderHierarchy),
    roadmap,
    verificationStrategy: asStringArray(raw.verificationStrategy),
    risks: asStringArray(raw.risks),
    openQuestions: asStringArray(raw.openQuestions),
    requiredCapabilities: asStringArray(raw.requiredCapabilities),
    provenance: {
      provenanceId,
      source: { kind: 'model', id: 'mission-architect' },
      inputs: [mission.missionId, mission.goalId],
      reason: 'architecture blueprint proposed for complex mission (§16)',
      at,
    },
    createdAt: at,
  };
}

function asStringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string' && v.trim() !== '');
}

// ── Prompt text (trusted runtime constants) ──────────────────────────────────────

const ARCHITECT_INSTRUCTIONS = `\
TASK: Produce an architecture blueprint for the mission below BEFORE any code is written.
Think in terms of module boundaries, folder layout, an ordered roadmap, and how the result
will be verified. Only list capabilities you genuinely need; do NOT claim a tool is installed —
the runtime verifies capabilities separately. Surface assumptions and open questions explicitly.`;

const OUTPUT_CONTRACT = `\
Return ONLY a single JSON object (no prose, no markdown fences) with these fields:
{
  "summary": string,
  "requirements": string[],            // non-empty
  "assumptions": string[],
  "techChoices": string[],
  "moduleBoundaries": [ { "name": string, "responsibility": string, "dependsOn": string[] } ],  // non-empty
  "folderHierarchy": string[],
  "roadmap": [ { "name": string, "outcome": string, "requiresCapabilities": string[] } ],       // non-empty
  "verificationStrategy": string[],    // non-empty
  "risks": string[],
  "openQuestions": string[],
  "requiredCapabilities": string[]     // capability names you need VERIFIED (e.g. "docker","node")
}`;
