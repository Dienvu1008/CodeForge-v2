/*
 * Copyright 2026 DienVu (Dienvu1008)
 * SPDX-License-Identifier: Apache-2.0
 */

// ApproachAdvisor — Goal Clarification Phase 2 (plan options).
//
// For a goal that is clear enough but admits several reasonable approaches (complexity ≥ MEDIUM),
// ask the model for 2–4 genuinely DIFFERENT approach sketches (title, summary, pros, cons, one
// recommended). The user picks one; the Planner then decomposes under it. The advisor never plans
// tasks itself (GI-009: only the Planner proposes graph mutations).
//
// Authority rules (same discipline as AssumptionAdvisor):
//   MI-001: ADVISORY output — shown to the user, never authority.
//   SE-010 / MG-002: model output is UNTRUSTED — it must pass sanitizePlanOptions (bounded, one-line,
//            de-duplicated, ≥ 2 options) before use; otherwise the call is retried, then rejected.
//   MG-001: the single LLM call goes through the injected ModelGateway.
// Fail-safe: throws after bounded retries; the caller skips the plan-options step.
import type { ModelGateway } from '../model/gateway.js';
import { parseModelOutput, modelRequest, type OutputSchema } from '../model/structured-output-parser.js';
import { BOUNDARY_SYSTEM_PREAMBLE, buildPrompt } from '../security/prompt-boundary.js';
import type { Mission } from '../domain/mission.js';
import { sanitizePlanOptions, PLAN_OPTION_LIMITS, type PlanOption } from './plan-options.js';

export interface ApproachAdvisorDeps {
  readonly gateway: ModelGateway;
}

const OPTIONS_SCHEMA: OutputSchema = {
  options: { type: 'array', required: true },
};

export class ApproachAdvisor {
  constructor(private readonly deps: ApproachAdvisorDeps) {}

  /**
   * Propose sanitized plan options for the mission. `statements` are the decisions already made
   * (user-provided clarification answers + assumptions) — every option must respect them.
   * Throws ModelError when no valid set (≥ 2 options) is produced after bounded retries.
   */
  async propose(mission: Mission, statements: readonly string[]): Promise<readonly PlanOption[]> {
    const system = `${BOUNDARY_SYSTEM_PREAMBLE}\n\n${ADVISOR_INSTRUCTIONS}`;
    const decided = statements.length > 0 ? statements.map((s) => `- ${s}`).join('\n') : '(none)';
    const acceptance = mission.acceptanceCriteria.length > 0
      ? mission.acceptanceCriteria.map((c) => `- ${c.description}`).join('\n')
      : '(none stated)';

    const taskPrompt = buildPrompt([
      {
        label: 'MISSION',
        content: [
          `type: ${mission.missionType}`,
          `complexity: ${mission.complexity.level}`,
          `risk: ${mission.risk.level}`,
        ].join('\n'),
        trust: 'trusted',
      },
      { label: 'GOAL', content: mission.normalizedGoal, trust: 'untrusted' },
      { label: 'ACCEPTANCE', content: acceptance, trust: 'untrusted' },
      { label: 'ALREADY_DECIDED', content: decided, trust: 'untrusted' },
      { label: 'OUTPUT', content: OUTPUT_CONTRACT, trust: 'trusted' },
    ]);

    const request = modelRequest('plan', system, taskPrompt, { maxOutputTokens: 1500, temperature: 0 });
    let sanitized: readonly PlanOption[] | null = null;
    await parseModelOutput<{ options?: unknown }>(this.deps.gateway, request, {
      schema: OPTIONS_SCHEMA,
      purpose: 'plan',
      semanticCheck: (parsed) => {
        sanitized = sanitizePlanOptions(parsed);
        return sanitized === null
          ? `need ${PLAN_OPTION_LIMITS.minOptions}-${PLAN_OPTION_LIMITS.maxOptions} valid, distinct options (title ≤ ${PLAN_OPTION_LIMITS.title} chars, summary ≤ ${PLAN_OPTION_LIMITS.summary}, 1-${PLAN_OPTION_LIMITS.items} pros and cons each ≤ ${PLAN_OPTION_LIMITS.item})`
          : undefined;
      },
      retryFeedback: (msg) =>
        `Your previous output was rejected: ${msg}. Return ONLY one JSON object matching the required shape.`,
    });
    if (sanitized === null) throw new Error('approach advisor produced no valid options');
    return sanitized;
  }
}

// ── Prompt text (trusted runtime constants) ────────────────────────────────────

const ADVISOR_INSTRUCTIONS = `\
TASK: Propose 2 to 4 GENUINELY DIFFERENT ways to accomplish the user's goal (different structure,
scope, or technique — not renamings of the same plan). Every option must fully satisfy the goal, its
acceptance criteria, and everything in ALREADY_DECIDED. Be concrete and brief. Do NOT write code and
do NOT list tasks. Mark exactly ONE option as recommended: the one a senior engineer would pick for
this goal by default (prefer simple, verifiable solutions).`;

const OUTPUT_CONTRACT = `\
Return ONLY a single JSON object (no prose, no markdown fences):
{
  "options": [                         // 2 to 4 entries
    { "title": string,                 // <= 80 chars, e.g. "Module + unit tests"
      "summary": string,               // <= 400 chars, one or two sentences
      "pros": [string],                // 1-4 short items
      "cons": [string],                // 1-4 short items
      "recommended": boolean }         // exactly one true
  ]
}`;