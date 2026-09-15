// SqliteGoalRepository — DOMAIN_CONTRACTS §3, GL-001/GL-004.
//
// Goal is immutable + versioned: rows are keyed by (goal_id, version). `getById`
// returns the latest version. `supersede` inserts the new version and links the old
// one via superseded_by, all in one transaction. GL-004 (no version reuse) is enforced
// by the composite PK — inserting a duplicate (goal_id, version) fails as DB_CONSTRAINT.
import type {
  Goal,
  GoalRepository,
  AcceptanceCriterion,
  Constraint,
} from '@codeforge/agent-core';
import type { DatabaseAdapter } from '../sqlite/types.js';
import { RepoError } from './errors.js';

interface GoalRow {
  goal_id: string;
  version: number;
  description: string;
  constraints_json: string;
  acceptance_json: string;
  created_at: string;
  created_by: string;
  superseded_by: string | null;
  schema_version: number;
}

export class SqliteGoalRepository implements GoalRepository {
  constructor(
    private readonly db: DatabaseAdapter,
    private readonly schemaVersion = 1,
  ) {}

  async create(goal: Goal): Promise<void> {
    try {
      this.insert(goal);
    } catch (err) {
      throw wrapConstraint(err, goal.goalId);
    }
  }

  async getById(goalId: string): Promise<Goal | null> {
    const rows = this.db.query<GoalRow>(
      'SELECT * FROM goals WHERE goal_id = ? ORDER BY version DESC LIMIT 1',
      [goalId],
    );
    return rows[0] ? rowToGoal(rows[0]) : null;
  }

  async getVersion(goalId: string, version: number): Promise<Goal | null> {
    const rows = this.db.query<GoalRow>('SELECT * FROM goals WHERE goal_id = ? AND version = ?', [
      goalId,
      version,
    ]);
    return rows[0] ? rowToGoal(rows[0]) : null;
  }

  async supersede(goalId: string, newGoal: Goal): Promise<void> {
    this.db.transaction((tx) => {
      const latest = tx.query<{ version: number }>(
        'SELECT MAX(version) AS version FROM goals WHERE goal_id = ?',
        [goalId],
      );
      const currentVersion = latest[0]?.version;
      if (currentVersion === null || currentVersion === undefined) {
        throw new RepoError('NOT_FOUND', 'Goal', goalId);
      }
      // Insert the new version (PK guards GL-004: duplicate version -> DB_CONSTRAINT).
      tx.execute(
        `INSERT INTO goals
           (goal_id, version, description, constraints_json, acceptance_json,
            created_at, created_by, superseded_by, schema_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          newGoal.goalId,
          newGoal.version,
          newGoal.description,
          JSON.stringify(newGoal.constraints),
          JSON.stringify(newGoal.acceptanceCriteria),
          newGoal.createdAt,
          newGoal.createdBy,
          newGoal.supersededBy ?? null,
          this.schemaVersion,
        ],
      );
      // Link the previous latest version to the new one.
      tx.execute('UPDATE goals SET superseded_by = ? WHERE goal_id = ? AND version = ?', [
        newGoal.goalId,
        goalId,
        currentVersion,
      ]);
    });
  }

  private insert(goal: Goal): void {
    this.db.execute(
      `INSERT INTO goals
         (goal_id, version, description, constraints_json, acceptance_json,
          created_at, created_by, superseded_by, schema_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        goal.goalId,
        goal.version,
        goal.description,
        JSON.stringify(goal.constraints),
        JSON.stringify(goal.acceptanceCriteria),
        goal.createdAt,
        goal.createdBy,
        goal.supersededBy ?? null,
        this.schemaVersion,
      ],
    );
  }
}

function rowToGoal(row: GoalRow): Goal {
  return {
    goalId: row.goal_id,
    version: row.version,
    description: row.description,
    constraints: JSON.parse(row.constraints_json) as Constraint[],
    acceptanceCriteria: JSON.parse(row.acceptance_json) as AcceptanceCriterion[],
    createdAt: row.created_at,
    createdBy: row.created_by as Goal['createdBy'],
    ...(row.superseded_by === null ? {} : { supersededBy: row.superseded_by }),
  };
}

function wrapConstraint(err: unknown, id: string): unknown {
  if (err && typeof err === 'object' && 'code' in err && (err as { code: unknown }).code === 'DB_CONSTRAINT') {
    return new RepoError('ALREADY_EXISTS', 'Goal', id);
  }
  return err;
}
