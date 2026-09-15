// GoalService (P1-S2) — DOMAIN_CONTRACTS §3, GL-001..GL-004.
//
// Goal is immutable + versioned. This service enforces:
//   - GL-001: no in-place mutation — supersede creates a NEW version (version+1).
//   - GL-002: a Goal originates from 'user'/'import' only, never an LLM. The domain
//     type already forbids a 'model' creator; the service adds a defensive runtime check.
//   - GL-003: a Goal must carry >= 1 acceptance criterion (validation).
//   - GL-004: version is monotonic and never reused (supersede requires newGoal.version
//     to be the current latest + 1).
// Effects run over injected CONTRACTS (GoalRepository, EventLog) — no infra import.
import type { Goal } from '../domain/goal.js';
import type { DomainEvent, EventType } from '../domain/event.js';
import type { GoalRepository, EventLog } from '../repositories/index.js';

export class GoalError extends Error {
  public readonly code:
    | 'MISSING_ACCEPTANCE' // GL-003
    | 'LLM_MUTATION' // GL-002
    | 'NOT_FOUND'
    | 'VERSION_REUSE' // GL-004
    | 'INVALID_VERSION';
  constructor(code: GoalError['code'], message?: string) {
    super(message ?? code);
    this.name = 'GoalError';
    this.code = code;
  }
}

export interface GoalServiceDeps {
  readonly goals: GoalRepository;
  readonly events: EventLog;
  readonly sessionId: string; // events are per-session (EventLog is session-scoped)
  readonly now: () => string;
  readonly nextId: () => string;
}

const ALLOWED_CREATORS: readonly Goal['createdBy'][] = ['user', 'import'];

export class GoalService {
  constructor(private readonly deps: GoalServiceDeps) {}

  /** Create the first version of a goal (version must be 1). */
  async create(goal: Goal): Promise<Goal> {
    this.validate(goal);
    if (goal.version !== 1) {
      throw new GoalError('INVALID_VERSION', 'a new goal must start at version 1');
    }
    await this.deps.goals.create(goal);
    await this.emit('GOAL_CREATED', goal.goalId, { goalId: goal.goalId, version: goal.version });
    return goal;
  }

  /**
   * Supersede a goal with a new version. GL-001/GL-004: the new version must be the
   * current latest + 1; the old version is preserved and linked via supersededBy.
   */
  async supersede(goalId: string, newGoal: Goal): Promise<Goal> {
    this.validate(newGoal);
    const current = await this.deps.goals.getById(goalId);
    if (!current) {
      throw new GoalError('NOT_FOUND', goalId);
    }
    if (newGoal.version !== current.version + 1) {
      // GL-004: monotonic, no reuse/skip.
      throw new GoalError(
        'VERSION_REUSE',
        `expected version ${current.version + 1}, got ${newGoal.version}`,
      );
    }
    await this.deps.goals.supersede(goalId, newGoal);
    await this.emit('GOAL_SUPERSEDED', goalId, {
      goalId,
      fromVersion: current.version,
      toVersion: newGoal.version,
    });
    return newGoal;
  }

  private validate(goal: Goal): void {
    // GL-002: never accept an LLM-originated goal.
    if (!ALLOWED_CREATORS.includes(goal.createdBy)) {
      throw new GoalError('LLM_MUTATION', `goal creator not allowed: ${goal.createdBy}`);
    }
    // GL-003: at least one acceptance criterion.
    if (goal.acceptanceCriteria.length === 0) {
      throw new GoalError('MISSING_ACCEPTANCE', 'goal must have >= 1 acceptance criterion');
    }
  }

  // Goal has no dedicated EventAggregateKind (§18); it is scoped to the session, so
  // events use the 'session' aggregate with the goalId carried in the payload.
  private async emit(type: EventType, _goalId: string, payload: unknown): Promise<void> {
    const event: DomainEvent = {
      eventId: this.deps.nextId(),
      sessionId: this.deps.sessionId,
      type,
      aggregate: { kind: 'session', id: this.deps.sessionId },
      payload,
      at: this.deps.now(),
      sequenceNumber: 0, // EventLog is the sequence authority (CP-008)
    };
    await this.deps.events.append(event);
  }
}
