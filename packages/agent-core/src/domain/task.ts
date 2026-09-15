// Task, TaskExecution, TaskRun — DOMAIN_CONTRACTS §4, §5, §6.
import type { AcceptanceCriterion, Constraint, TaskStrategy } from './common.js';
import type { TaskState, TaskRunState } from '../state-machine/states.js';
import type { WorkspaceRevision } from './workspace-revision.js';
import type { BudgetConsumption } from './budget.js';

// §4 Task — intent, NOT execution. No deps / state / runs / verification here (TI-001..003).
export interface Task {
  readonly taskId: string; // ULID, immutable
  readonly description: string;

  readonly acceptanceCriteria: readonly AcceptanceCriterion[];
  readonly constraints: readonly Constraint[];

  readonly priority: number; // LLM proposal, not authority
  readonly strategy: TaskStrategy; // hint, not authority

  readonly createdAt: string;
  readonly createdBy: 'planner' | 'replanner' | 'user';

  readonly supersededBy?: string; // taskId
}

// §5 TaskExecution — mutable projection of a Task's current state.
export interface TaskExecution {
  readonly taskId: string;
  readonly currentState: TaskState;
  readonly currentRunId?: string;

  readonly attempts: number; // number of TaskRuns
  readonly createdAt: string;
  readonly updatedAt: string;

  readonly latestVerificationId?: string;
  readonly latestFailureId?: string;
}

// §6 TaskRun — immutable record of one execution attempt.
export interface TaskRun {
  readonly taskRunId: string; // ULID
  readonly taskId: string;
  readonly sessionId: string;
  readonly attemptNumber: number; // 1-indexed

  readonly state: TaskRunState;

  readonly graphVersionAtStart: number;
  readonly workspaceRevisionAtStart: WorkspaceRevision;
  readonly workspaceRevisionAtEnd?: WorkspaceRevision;

  readonly strategyUsed: TaskStrategy;
  readonly contextSnapshotId?: string;

  readonly startedAt: string;
  readonly endedAt?: string;

  readonly toolCalls: readonly string[]; // toolCallIds, ordered
  readonly failures: readonly string[]; // failureIds
  readonly verificationId?: string;

  readonly budgetConsumed: BudgetConsumption;
}
