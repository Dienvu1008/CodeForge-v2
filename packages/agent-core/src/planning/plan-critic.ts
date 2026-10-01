// PlanCritic — P2-PL1. Advisory-only LLM critique of a plan.
//
// MG-001: all LLM calls go through ModelGateway.
// MG-006: Critic output is advisory only — NO commit authority.
// The critic cannot reject, commit, or modify a plan. It produces critique text
// that the caller may log or pass back to the planner as feedback.
//
// Coding Agent Architecture §14: "Critic chỉ góp ý, không authority."
import type { ModelGateway } from '../model/gateway.js';
import type { GraphMutation } from '../graph/types.js';
import type { Goal } from '../domain/goal.js';
import { parseModelOutput, modelRequest } from '../model/structured-output-parser.js';
import { BOUNDARY_SYSTEM_PREAMBLE } from '../security/prompt-boundary.js';
import type { OutputSchema } from '../security/structured-output-validator.js';

// ── CritiqueResult ────────────────────────────────────────────────────────────

export interface CritiqueResult {
  /** Overall quality score 1-5. */
  readonly score: number;
  /** Issues found (may be empty). */
  readonly issues: readonly string[];
  /** Improvement suggestions (may be empty). */
  readonly suggestions: readonly string[];
  /** Summary of the critique. */
  readonly summary: string;
}

const CRITIQUE_SCHEMA: OutputSchema = {
  score:       { type: 'number', required: true, min: 1, max: 5 },
  issues:      { type: 'array',  required: true },
  suggestions: { type: 'array',  required: true },
  summary:     { type: 'string', required: true },
};

// ── PlanCriticDeps ────────────────────────────────────────────────────────────

export interface PlanCriticDeps {
  readonly gateway: ModelGateway;
  readonly now:     () => string;
  readonly nextId:  () => string;
}

// ── PlanCritic ────────────────────────────────────────────────────────────────

export class PlanCritic {
  constructor(private readonly deps: PlanCriticDeps) {}

  /**
   * Ask the model to critique a plan mutation. Returns a CritiqueResult.
   * Advisory only — caller decides whether/how to use the feedback.
   * Returns a neutral critique if the model call fails (never throws).
   */
  async critique(goal: Goal, mutation: GraphMutation): Promise<CritiqueResult> {
    const taskList = mutation.operations
      .filter((op) => op.kind === 'ADD_TASK')
      .map((op) => {
        if (op.kind !== 'ADD_TASK') return '';
        return `  - ${op.task.taskId}: ${op.task.description}`;
      })
      .join('\n');

    const taskPrompt = [
      `Goal: ${goal.description}`,
      '',
      'Proposed plan tasks:',
      taskList || '  (none)',
      '',
      'Critique this plan. Return JSON: { score (1-5), issues (string[]), suggestions (string[]), summary (string) }',
      'score 5 = excellent, 1 = poor.',
      'Be concise. issues and suggestions may be empty arrays if the plan is good.',
    ].join('\n');

    try {
      const request = modelRequest('critique', BOUNDARY_SYSTEM_PREAMBLE, taskPrompt, {
        temperature:     0.2,
        maxOutputTokens: 512,
        responseSchema:  CRITIQUE_SCHEMA,
      });

      const result = await parseModelOutput<CritiqueResult>(
        this.deps.gateway,
        request,
        { schema: CRITIQUE_SCHEMA },
      );

      return {
        score:       Math.min(5, Math.max(1, Math.round(result.score))),
        issues:      Array.isArray(result.issues)      ? result.issues      : [],
        suggestions: Array.isArray(result.suggestions) ? result.suggestions : [],
        summary:     typeof result.summary === 'string' ? result.summary : '',
      };
    } catch {
      // Critic failure is non-fatal — return neutral result.
      return { score: 3, issues: [], suggestions: [], summary: 'critique unavailable' };
    }
  }
}
