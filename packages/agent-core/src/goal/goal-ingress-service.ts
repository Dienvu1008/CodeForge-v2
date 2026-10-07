// GoalIngressService (P10.9) — the runtime entry point for NEW goals submitted while the
// agent is already running (e.g. a dashboard/Telegram/API "do X" request), as opposed to
// the single --goal supplied at process start.
//
// It is a Decision Gate ("what to do"), deliberately separate from the Approval Gate
// ("may this run"). A submitted goal is turned into a proper Goal entity (createdBy='user'
// — GL-002: never an LLM) and placed on an in-memory FIFO queue. A worker in the runtime
// dequeues one goal at a time and runs it through the SAME kernel path as the first goal:
// Planner → GraphCommit → orchestrator (GI-009 — the LLM proposes, the kernel decides).
// This service introduces NO authority: it only builds + queues intent; it never plans,
// commits, or executes.
//
// Pure core: queue + builder with injected now/nextId. The worker loop and all I/O live
// in the runtime (infra), so this stays trivially testable (agent-core ↛ infrastructure).
import type { Goal } from '../domain/goal.js';
import type { AcceptanceCriterion } from '../domain/common.js';

// ── Submission + result ────────────────────────────────────────────────────────

export interface GoalSubmission {
  /** Free-text description of the work (user intent). */
  readonly description: string;
  /** Optional explicit acceptance criteria; when omitted, the description is used. */
  readonly acceptanceCriteria?: readonly string[];
}

export interface GoalSubmissionResult {
  readonly goalId: string;
  /** 1-based position in the queue at submission time. */
  readonly position: number;
}

export class GoalIngressError extends Error {
  public readonly code: 'EMPTY_DESCRIPTION';
  constructor(code: GoalIngressError['code'], message?: string) {
    super(message ?? code);
    this.name = 'GoalIngressError';
    this.code = code;
  }
}

export interface GoalIngressServiceDeps {
  readonly now:    () => string;
  readonly nextId: () => string;
}

// ── GoalIngressService ───────────────────────────────────────────────────────

export class GoalIngressService {
  private readonly queue: Goal[] = [];

  constructor(private readonly deps: GoalIngressServiceDeps) {}

  /**
   * Build a Goal from a submission and enqueue it (FIFO). GL-002: createdBy='user'.
   * GL-003: always carries >= 1 acceptance criterion (defaults to the description).
   * Throws GoalIngressError on an empty description — the gate rejects a non-goal.
   */
  submitGoal(input: GoalSubmission): GoalSubmissionResult {
    const description = input.description.trim();
    if (description.length === 0) {
      throw new GoalIngressError('EMPTY_DESCRIPTION', 'goal description must be non-empty');
    }

    const criteria = (input.acceptanceCriteria ?? [])
      .map((c) => c.trim())
      .filter((c) => c.length > 0);
    const acceptanceCriteria: AcceptanceCriterion[] = (criteria.length > 0 ? criteria : [description])
      .map((desc) => ({ criterionId: this.deps.nextId(), description: desc, mandatory: true }));

    const goal: Goal = {
      goalId:  this.deps.nextId(),
      version: 1,
      description,
      constraints: [],
      acceptanceCriteria,
      createdAt: this.deps.now(),
      createdBy: 'user',
    };

    this.queue.push(goal);
    return { goalId: goal.goalId, position: this.queue.length };
  }

  /** Dequeue the next goal (FIFO), or undefined when the queue is empty. */
  dequeue(): Goal | undefined {
    return this.queue.shift();
  }

  /** Number of goals currently waiting. */
  size(): number {
    return this.queue.length;
  }
}
