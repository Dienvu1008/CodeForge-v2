// SqliteTaskRepository — DOMAIN_CONTRACTS §23.2, RI-2/RI-7.
//
// Task is IMMUTABLE: there is no update(). Change is expressed by creating a NEW task
// and marking the old one superseded (TI-004). `supersede` does both atomically.
import type {
  Task,
  TaskRepository,
  AcceptanceCriterion,
  Constraint,
  TaskStrategy,
} from '@codeforge/agent-core';
import type { DatabaseAdapter } from '../sqlite/types.js';
import { RepoError } from './errors.js';

interface TaskRow {
  task_id: string;
  description: string;
  acceptance_json: string;
  constraints_json: string;
  priority: number;
  strategy_json: string;
  created_at: string;
  created_by: string;
  superseded_by: string | null;
  schema_version: number;
}

export class SqliteTaskRepository implements TaskRepository {
  constructor(
    private readonly db: DatabaseAdapter,
    private readonly schemaVersion = 1,
  ) {}

  async create(task: Task): Promise<void> {
    try {
      this.insert(task);
    } catch (err) {
      throw wrapConstraint(err, task.taskId);
    }
  }

  async getById(taskId: string): Promise<Task | null> {
    const rows = this.db.query<TaskRow>('SELECT * FROM tasks WHERE task_id = ?', [taskId]);
    return rows[0] ? rowToTask(rows[0]) : null;
  }

  async supersede(oldTaskId: string, newTask: Task): Promise<void> {
    this.db.transaction((tx) => {
      const existing = tx.query<{ superseded_by: string | null }>(
        'SELECT superseded_by FROM tasks WHERE task_id = ?',
        [oldTaskId],
      );
      if (existing.length === 0) {
        throw new RepoError('NOT_FOUND', 'Task', oldTaskId);
      }
      if (existing[0]?.superseded_by !== null) {
        // Superseding an already-superseded task would fork history (TI-004).
        throw new RepoError('IMMUTABLE_VIOLATION', 'Task', oldTaskId, 'task already superseded');
      }
      // Insert the new task, then point the old one at it.
      tx.execute(
        `INSERT INTO tasks
           (task_id, description, acceptance_json, constraints_json, priority, strategy_json,
            created_at, created_by, superseded_by, schema_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          newTask.taskId,
          newTask.description,
          JSON.stringify(newTask.acceptanceCriteria),
          JSON.stringify(newTask.constraints),
          newTask.priority,
          JSON.stringify(newTask.strategy),
          newTask.createdAt,
          newTask.createdBy,
          newTask.supersededBy ?? null,
          this.schemaVersion,
        ],
      );
      tx.execute('UPDATE tasks SET superseded_by = ? WHERE task_id = ?', [
        newTask.taskId,
        oldTaskId,
      ]);
    });
  }

  private insert(task: Task): void {
    this.db.execute(
      `INSERT INTO tasks
         (task_id, description, acceptance_json, constraints_json, priority, strategy_json,
          created_at, created_by, superseded_by, schema_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        task.taskId,
        task.description,
        JSON.stringify(task.acceptanceCriteria),
        JSON.stringify(task.constraints),
        task.priority,
        JSON.stringify(task.strategy),
        task.createdAt,
        task.createdBy,
        task.supersededBy ?? null,
        this.schemaVersion,
      ],
    );
  }
}

function rowToTask(row: TaskRow): Task {
  return {
    taskId: row.task_id,
    description: row.description,
    acceptanceCriteria: JSON.parse(row.acceptance_json) as AcceptanceCriterion[],
    constraints: JSON.parse(row.constraints_json) as Constraint[],
    priority: row.priority,
    strategy: JSON.parse(row.strategy_json) as TaskStrategy,
    createdAt: row.created_at,
    createdBy: row.created_by as Task['createdBy'],
    ...(row.superseded_by === null ? {} : { supersededBy: row.superseded_by }),
  };
}

function wrapConstraint(err: unknown, id: string): unknown {
  if (err && typeof err === 'object' && 'code' in err && (err as { code: unknown }).code === 'DB_CONSTRAINT') {
    return new RepoError('ALREADY_EXISTS', 'Task', id);
  }
  return err;
}
