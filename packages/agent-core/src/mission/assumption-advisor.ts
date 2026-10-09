// AssumptionAdvisor — Phase 12 / Tier B1 (goal clarification, option (ii): assume + state).
//
// When a goal is under-specified (Mission.uncertainty ≥ INFERRED), instead of stopping to ask the
// user, the agent proceeds under EXPLICIT assumptions. This advisor asks the model to turn the
// mission's openQuestions into concrete, reasonable assumptions — each with an acceptance check —
// and a one-line clarified restatement of the goal.
//
// Authority rules (same discipline as MissionArchitect):
//   MI-001: the output is ADVISORY — prompt context + mission-level acceptance, never authority.
//   MI-004: it NEVER mutates the Goal (GL-*). Assumptions are mirrored into the Mission copy only.
//   SE-010 / MG-002: model output is UNTRUSTED and must pass structured validation before use.
//   MG-001: the single LLM call goes through the injected ModelGateway.
// Pure orchestration over injected gateway + clock + id source; fail-safe (caller skips on throw).
import type { ModelGateway } from '../model/gateway.js';
import { parseModelOutput, modelRequest, type OutputSchema } from '../model/structured-output-parser.js';
import { BOUNDARY_SYSTEM_PREAMBLE, buildPrompt } from '../security/prompt-boundary.js';
import type { GoalAssumption, GoalClarification, Mission } from '../domain/mission.js';

export interface AssumptionAdvisorDeps {
  readonly gateway: ModelGateway;
  readonly now: () => string;
  readonly newProvenanceId: () => string;
}

const CLARIFICATION_SCHEMA: OutputSchema = {
  clarifiedGoal: { type: 'string', required: true },
  assumptions: { type: 'array', required: true },
};

interface RawClarification {
  readonly clarifiedGoal?: unknown;
  readonly assumptions?: unknown;
}

/** Max assumptions kept (deterministic clamp — a vague goal shouldn't explode into dozens). */
const MAX_ASSUMPTIONS = 6;

export class AssumptionAdvisor {
  constructor(private readonly deps: AssumptionAdvisorDeps) {}

  /**
   * Produce a GoalClarification for an under-specified mission: a clarified restatement + a
   * bounded list of explicit assumptions (each with an acceptance check). Throws ModelError if
   * the output cannot be validated after bounded retries — the caller treats that as "no
   * clarification" and proceeds (fail-safe; the advisory layer never breaks the run).
   */
  async clarify(mission: Mission): Promise<GoalClarification> {
    const system = `${BOUNDARY_SYSTEM_PREAMBLE}\n\n${ADVISOR_INSTRUCTIONS}`;

    const openQuestions = mission.uncertainty.openQuestions.length > 0
      ? mission.uncertainty.openQuestions.map((q) => `- ${q}`).join('\n')
      : '(no specific gaps enumerated — infer the reasonable interface/behavior)';

    const taskPrompt = buildPrompt([
      {
        label: 'MISSION',
        content: [
          `type: ${mission.missionType}`,
          `complexity: ${mission.complexity.level}`,
          `uncertainty: ${mission.uncertainty.level}`,
        ].join('\n'),
        trust: 'trusted',
      },
      { label: 'GOAL', content: mission.normalizedGoal, trust: 'untrusted' },
      { label: 'OPEN_QUESTIONS', content: openQuestions, trust: 'untrusted' },
      { label: 'OUTPUT', content: OUTPUT_CONTRACT, trust: 'trusted' },
    ]);

    const request = modelRequest('plan', system, taskPrompt, { maxOutputTokens: 1500, temperature: 0 });

    const raw = await parseModelOutput<RawClarification>(this.deps.gateway, request, {
      schema: CLARIFICATION_SCHEMA,
      purpose: 'plan',
      semanticCheck: semanticCheckClarification,
      retryFeedback: (msg) =>
        `Your previous output was rejected: ${msg}. Return ONLY one JSON object matching the required shape.`,
    });

    return mapToClarification(raw, mission, this.deps.now(), this.deps.newProvenanceId());
  }
}

// ── Semantic validation (MG-002 Stage 3) ──────────────────────────────────────

function semanticCheckClarification(parsed: unknown): string | undefined {
  const obj = parsed as RawClarification;
  if (typeof obj.clarifiedGoal !== 'string' || obj.clarifiedGoal.trim() === '') {
    return 'clarifiedGoal must be a non-empty string';
  }
  if (!Array.isArray(obj.assumptions) || obj.assumptions.length === 0) {
    return 'assumptions must be a non-empty array';
  }
  for (const a of obj.assumptions) {
    if (typeof a !== 'object' || a === null) return 'each assumption must be an object';
    const aa = a as Record<string, unknown>;
    if (typeof aa.assumption !== 'string' || aa.assumption.trim() === '') {
      return 'each assumption needs a non-empty "assumption"';
    }
    if (typeof aa.acceptance !== 'string' || aa.acceptance.trim() === '') {
      return 'each assumption needs a non-empty "acceptance"';
    }
  }
  return undefined;
}

// ── Mapping (untrusted raw → domain GoalClarification) ─────────────────────────

function mapToClarification(
  raw: RawClarification,
  mission: Mission,
  at: string,
  provenanceId: string,
): GoalClarification {
  const assumptions: GoalAssumption[] = (Array.isArray(raw.assumptions) ? raw.assumptions : [])
    .filter((a): a is Record<string, unknown> => typeof a === 'object' && a !== null)
    .slice(0, MAX_ASSUMPTIONS)
    .map((a) => ({
      question: typeof a.question === 'string' ? a.question : '',
      assumption: String(a.assumption),
      acceptance: String(a.acceptance),
    }));

  return {
    missionId: mission.missionId,
    clarifiedGoal: typeof raw.clarifiedGoal === 'string' ? raw.clarifiedGoal : mission.normalizedGoal,
    assumptions,
    provenance: {
      provenanceId,
      source: { kind: 'model', id: 'assumption-advisor' },
      inputs: [mission.missionId, mission.goalId],
      reason: 'assumption-based clarification of an under-specified goal (Tier B1)',
      at,
    },
    createdAt: at,
  };
}

// ── Prompt text (trusted runtime constants) ────────────────────────────────────

const ADVISOR_INSTRUCTIONS = `\
TASK: The user's goal is under-specified. Do NOT ask the user questions. Instead, make the most
reasonable, conventional assumptions a senior engineer would make, state them EXPLICITLY, and
restate the goal clearly. Keep assumptions minimal and sensible — prefer the simplest common
interpretation (standard interfaces, simple I/O, an obvious example). Each assumption must come
with a concrete way to verify a correct result under it.`;

const OUTPUT_CONTRACT = `\
Return ONLY a single JSON object (no prose, no markdown fences):
{
  "clarifiedGoal": string,            // one-line restatement with the gaps resolved
  "assumptions": [                    // non-empty; the explicit assumptions you are making
    { "question": string,             // the gap being resolved (may echo an open question)
      "assumption": string,           // the concrete choice you are making
      "acceptance": string }          // how a correct result under this assumption is verified
  ]
}`;
