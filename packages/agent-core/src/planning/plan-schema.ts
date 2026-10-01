// PlanSchema — P2-PL1. JSON schema for structured Planner output.
//
// The Planner asks the model to return a JSON object matching this shape.
// The runtime then translates the parsed output into GraphMutation operations.
// LLM proposes; GraphValidator decides (GI-009: LLM never commits directly).
//
// Phase 2 scope: ADD_TASK + ADD_EDGE only (full 7-op set in Phase 5 replanner).
import type { OutputSchema } from '../security/structured-output-validator.js';

/** One task proposed by the Planner. */
export interface RawTaskProposal {
  readonly id: string;           // caller-scoped temporary id (e.g. "T1", "T2")
  readonly description: string;
  readonly strategy: 'generate' | 'refactor' | 'fix' | 'test' | 'migrate' | 'custom';
  readonly notes?: string;
  readonly priority?: number;
  readonly acceptanceCriteria?: string[]; // short strings, optional
}

/** One edge proposed by the Planner. */
export interface RawEdgeProposal {
  readonly from: string;  // task id in the proposal (e.g. "T2")
  readonly to: string;    // task id in the proposal (e.g. "T1") — T2 depends_on T1
  readonly kind: 'depends_on';
}

/** The full plan proposal returned by the Planner model. */
export interface RawPlan {
  readonly tasks: readonly RawTaskProposal[];
  readonly edges?: readonly RawEdgeProposal[];
  readonly reason?: string;
}

// ── JSON Schema for StructuredOutputParser ────────────────────────────────────

/** OutputSchema for the top-level plan object. */
export const PLAN_SCHEMA: OutputSchema = {
  tasks: { type: 'array', required: true },
};

// ── Plan proposal schema validation (semantic) ────────────────────────────────

/** Semantic check: tasks array must be non-empty and each task must have description. */
export function validatePlanSemantics(raw: unknown): string | undefined {
  const plan = raw as Partial<RawPlan>;
  if (!Array.isArray(plan.tasks) || plan.tasks.length === 0) {
    return 'plan must contain at least one task';
  }
  for (let i = 0; i < plan.tasks.length; i++) {
    const t = plan.tasks[i] as Partial<RawTaskProposal>;
    if (!t.id || typeof t.id !== 'string') {
      return `task[${i}] missing required "id" field`;
    }
    if (!t.description || typeof t.description !== 'string' || t.description.trim().length === 0) {
      return `task[${i}] missing required "description" field`;
    }
    // TI-003: Task must NOT carry dependency-like fields.
    const forbidden = ['dependencies', 'deps', 'dependsOn', 'blockedBy', 'edges', 'state'];
    for (const f of forbidden) {
      if (f in (t as Record<string, unknown>)) {
        return `task[${i}] must not carry a "${f}" field (TI-003) — use edges instead`;
      }
    }
  }
  if (plan.edges !== undefined) {
    for (let i = 0; i < plan.edges.length; i++) {
      const e = plan.edges[i] as Partial<RawEdgeProposal>;
      if (!e.from || !e.to) {
        return `edge[${i}] missing from/to fields`;
      }
    }
  }
  return undefined;
}
