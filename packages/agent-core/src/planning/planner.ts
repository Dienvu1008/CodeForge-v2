// Planner — P2-PL1. Coding Agent Architecture §14/§52, PHASE_2_ROADMAP §4.5.
//
// Translates Goal + Graph into a GraphMutation proposal via ModelGateway + ContextBuilder.
//
// Key invariants:
//   MG-001: all LLM calls go through ModelGateway.
//   MG-002/003: output validated by StructuredOutputParser (bounded retry).
//   GI-009: LLM NEVER commits graph directly — Planner returns a GraphMutation that the
//           caller passes to GraphCommitService (runtime decides, not LLM).
//   CX-003: untrusted workspace content is marked in context snapshot.
//
// Flow:
//   1. ContextBuilder.build() → ContextSnapshot.
//   2. PromptBoundary.buildPrompt() → structured prompt with trust marking.
//   3. ModelGateway.generate() → raw LLM output.
//   4. StructuredOutputParser.parseModelOutput() → RawPlan (bounded retry).
//   5. Translate RawPlan → GraphMutation (runtime builds mutation, not LLM).
//   6. Return mutation — caller runs GraphCommitService.commit(mutation).

import type { Goal } from '../domain/goal.js';
import type { TaskGraph, GraphMutation, GraphOperation } from '../graph/types.js';
import type { WorkspaceRevision } from '../domain/workspace-revision.js';
import type { Provenance } from '../domain/provenance.js';
import type { ModelGateway } from '../model/gateway.js';
import { parseModelOutput, modelRequest } from '../model/structured-output-parser.js';
import { ContextBuilder, type BuildContextRequest, DEFAULT_CONTEXT_POLICY } from '../context/context-builder.js';
import { buildPrompt, BOUNDARY_SYSTEM_PREAMBLE } from '../security/prompt-boundary.js';
import {
  PLAN_SCHEMA,
  validatePlanSemantics,
  type RawPlan,
  type RawTaskProposal,
} from './plan-schema.js';
import type { Task } from '../domain/task.js';
import type { TaskStrategy, AcceptanceCriterion } from '../domain/common.js';

// ── PlannerError ──────────────────────────────────────────────────────────────

export class PlannerError extends Error {
  public readonly code:
    | 'INVALID_PLAN_OUTPUT'  // model returned invalid/unparseable plan
    | 'EMPTY_PLAN'           // plan has no tasks
    | 'CONTEXT_BUILD_FAILED';

  constructor(code: PlannerError['code'], message?: string) {
    super(message ?? code);
    this.name = 'PlannerError';
    this.code = code;
  }
}

// ── PlannerDeps ───────────────────────────────────────────────────────────────

export interface PlannerDeps {
  readonly gateway: ModelGateway;
  readonly now:     () => string;
  readonly nextId:  () => string;
}

// ── Planner ───────────────────────────────────────────────────────────────────

export class Planner {
  private readonly contextBuilder: ContextBuilder;

  constructor(private readonly deps: PlannerDeps) {
    this.contextBuilder = new ContextBuilder({
      now:    deps.now,
      nextId: deps.nextId,
    });
  }

  /**
   * Plan a session: Goal + existing graph → GraphMutation proposal.
   *
   * GI-009: returns a mutation the CALLER must commit via GraphCommitService.
   *         The Planner NEVER commits directly.
   */
  async plan(
    sessionId:   string,
    goal:        Goal,
    graph:       TaskGraph,
    revision:    WorkspaceRevision,
  ): Promise<GraphMutation> {
    // 1. Build context snapshot (CX-003: workspace items marked untrusted).
    const ctxRequest: BuildContextRequest = {
      sessionId,
      workspaceRevision: revision,
      buildReason:       'initial_plan',
      goalData:          goal,
      policy:            DEFAULT_CONTEXT_POLICY,
    };
    const snapshot = this.contextBuilder.build(ctxRequest);

    // 2. Build structured prompt with trust boundary (SE-001/002).
    const graphSummary = `Current graph: ${graph.nodes.length} tasks, version ${graph.version}.`;
    const taskPrompt = buildPrompt([
      {
        label:   'PLANNING TASK',
        content: [
          `Goal: ${goal.description}`,
          '',
          goal.acceptanceCriteria.length > 0
            ? `Acceptance criteria:\n${goal.acceptanceCriteria.map((ac) => `  - ${ac.description}`).join('\n')}`
            : '',
          '',
          graphSummary,
          '',
          'Return a JSON plan with "tasks" array and optional "edges" array.',
          'Each task: { "id": "T1", "description": "...", "strategy": "generate" }',
          'Each edge: { "from": "T2", "to": "T1", "kind": "depends_on" } (T2 depends_on T1)',
          '',
          'Rules:',
          '  - tasks array must be non-empty',
          '  - Each task needs a unique short id (T1, T2, ...) and a description',
          '  - Do NOT put dependencies inside task objects',
          '  - Use edges to express dependencies',
        ].filter(Boolean).join('\n'),
        trust: 'trusted',
      },
    ]);

    // 3. Call ModelGateway (MG-001) with structured output request.
    const request = modelRequest(
      'plan',
      BOUNDARY_SYSTEM_PREAMBLE,
      taskPrompt,
      { responseSchema: PLAN_SCHEMA, temperature: 0, maxOutputTokens: 2048 },
    );
    // Attach context snapshot id to request for provenance (MG-004).
    const requestWithCtx = { ...request, contextSnapshotId: snapshot.snapshotId };

    // 4. Parse model output (MG-002/003: bounded retry, structured validation).
    let rawPlan: RawPlan;
    try {
      rawPlan = await parseModelOutput<RawPlan>(
        this.deps.gateway,
        requestWithCtx,
        {
          schema:        PLAN_SCHEMA,
          semanticCheck: validatePlanSemantics,
          retryFeedback: (msg, attempt) =>
            `[Attempt ${attempt}] Your previous response was invalid: ${msg}. ` +
            'Please return a valid JSON object with a "tasks" array.',
        },
      );
    } catch (err) {
      throw new PlannerError(
        'INVALID_PLAN_OUTPUT',
        `Planner model output invalid after retries: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (rawPlan.tasks.length === 0) {
      throw new PlannerError('EMPTY_PLAN', 'Planner returned empty tasks array');
    }

    // 5. Translate RawPlan → GraphMutation (GI-009: runtime builds mutation, not LLM).
    return this.buildMutation(sessionId, rawPlan, graph);
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private buildMutation(
    sessionId: string,
    rawPlan:   RawPlan,
    graph:     TaskGraph,
  ): GraphMutation {
    const idMap = new Map<string, string>(); // proposal id → real ULID
    const operations: GraphOperation[] = [];

    // ADD_TASK for each proposed task.
    for (const raw of rawPlan.tasks) {
      const taskId = this.deps.nextId();
      idMap.set(raw.id, taskId);
      const task = this.rawToTask(taskId, raw);
      operations.push({ kind: 'ADD_TASK', task });
    }

    // ADD_EDGE for each proposed dependency.
    for (const edge of rawPlan.edges ?? []) {
      const fromId = idMap.get(edge.from);
      const toId   = idMap.get(edge.to);
      if (fromId === undefined || toId === undefined) continue; // skip unknown refs
      operations.push({ kind: 'ADD_EDGE', fromTaskId: fromId, toTaskId: toId, edgeKind: 'depends_on' });
    }

    const provenance: Provenance = {
      provenanceId: this.deps.nextId(),
      source:       { kind: 'model', id: this.deps.gateway.identity.name },
      model: {
        name:     this.deps.gateway.identity.name,
        version:  this.deps.gateway.identity.version,
        endpoint: this.deps.gateway.identity.endpoint,
      },
      inputs:  [],
      reason:  rawPlan.reason ?? 'initial plan',
      at:      this.deps.now(),
    };

    return {
      mutationId:  this.deps.nextId(),
      sessionId,
      baseVersion: graph.version,
      operations,
      proposedBy:  'planner',
      reason:      rawPlan.reason ?? 'initial plan from Planner',
      provenance,
      createdAt:   this.deps.now(),
      status:      'PROPOSED',
    };
  }

  private rawToTask(taskId: string, raw: RawTaskProposal): Task {
    const strategy: TaskStrategy = {
      kind: (raw.strategy ?? 'generate') as TaskStrategy['kind'],
      ...(raw.notes !== undefined ? { notes: raw.notes } : {}),
    };

    const acceptanceCriteria: AcceptanceCriterion[] = (raw.acceptanceCriteria ?? []).map((desc) => ({
      criterionId:  this.deps.nextId(),
      description: desc,
      mandatory:    true,
    }));

    return {
      taskId,
      description:       raw.description,
      acceptanceCriteria,
      constraints:       [],
      priority:          raw.priority ?? 0,
      strategy,
      createdAt:         this.deps.now(),
      createdBy:         'planner',
    };
  }
}
