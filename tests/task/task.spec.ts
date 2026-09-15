// P1-T1 Task — TaskService over SqliteTaskRepository (TI-001..TI-004).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  SqliteDatabaseAdapter,
  SqliteTaskRepository,
  SqliteEventLog,
  runMigrations,
  createMigrationRegistry,
} from '@codeforge/infrastructure';
import { TaskService, TaskError } from '@codeforge/agent-core';
import type { Task } from '@codeforge/agent-core';

let db: SqliteDatabaseAdapter;
let repo: SqliteTaskRepository;
let events: SqliteEventLog;
let service: TaskService;

function task(id: string, overrides: Partial<Task> = {}): Task {
  return {
    taskId: id,
    description: `task ${id}`,
    acceptanceCriteria: [],
    constraints: [],
    priority: 0,
    strategy: { kind: 'generate' },
    createdAt: '2026-01-01T00:00:00.000Z',
    createdBy: 'planner',
    ...overrides,
  };
}

function seedSession(): void {
  db.execute(
    `INSERT INTO sessions
      (session_id, workspace_id, workspace_root, goal_id, graph_version, state,
       created_at, updated_at, runtime_version, schema_version, budget_id, lock_id, metadata_json)
     VALUES ('S','W','/r','G',1,'RUNNING','t','t','0.1.0',1,'B','L','{}')`,
  );
}

beforeEach(() => {
  db = new SqliteDatabaseAdapter(':memory:');
  db.open();
  runMigrations(db, createMigrationRegistry(), { now: () => '2026-01-01T00:00:00.000Z' });
  seedSession();
  repo = new SqliteTaskRepository(db);
  events = new SqliteEventLog(db);
  let n = 0;
  service = new TaskService({
    tasks: repo,
    events,
    sessionId: 'S',
    now: () => '2026-01-01T00:00:00.000Z',
    nextId: () => `ID-${n++}`,
  });
});
afterEach(() => db.close());

describe('TaskService.create — validation + TI-001', () => {
  it('creates a task and emits TASK_CREATED', async () => {
    await service.create(task('T1'));
    expect((await repo.getById('T1'))?.description).toBe('task T1');
    const evs = await events.query({ sessionId: 'S' });
    expect(evs.map((e) => e.type)).toEqual(['TASK_CREATED']);
    expect(evs[0]?.aggregate).toEqual({ kind: 'task', id: 'T1' });
  });

  it('rejects reusing an existing identity (TI-001)', async () => {
    await service.create(task('T1'));
    await expect(service.create(task('T1'))).rejects.toBeInstanceOf(TaskError);
    await expect(service.create(task('T1'))).rejects.toMatchObject({ code: 'IDENTITY_REUSE' });
  });

  it('rejects an empty description', async () => {
    await expect(service.create(task('T1', { description: '   ' }))).rejects.toMatchObject({
      code: 'EMPTY_DESCRIPTION',
    });
  });

  it('rejects a task carrying dependency data (TI-003)', async () => {
    const withDeps = { ...task('T1'), dependencies: ['T0'] } as unknown as Task;
    await expect(service.create(withDeps)).rejects.toMatchObject({ code: 'DEP_IN_TASK' });
  });
});

describe('TaskService.supersede — TI-004 (change via supersede only)', () => {
  beforeEach(async () => {
    await service.create(task('T1'));
  });

  it('supersedes with a new identity and links the old task', async () => {
    await service.supersede('T1', task('T2', { description: 'refined' }));
    expect((await repo.getById('T1'))?.supersededBy).toBe('T2');
    expect((await repo.getById('T2'))?.description).toBe('refined');
    const types = (await events.query({ sessionId: 'S' })).map((e) => e.type);
    expect(types).toEqual(['TASK_CREATED', 'TASK_SUPERSEDED']);
  });

  it('rejects superseding with the SAME identity (TI-001/TI-004)', async () => {
    await expect(service.supersede('T1', task('T1'))).rejects.toMatchObject({
      code: 'IDENTITY_REUSE',
    });
  });

  it('rejects superseding a missing task', async () => {
    await expect(service.supersede('NOPE', task('T2'))).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('rejects superseding an already-superseded task (repo TI-004 guard)', async () => {
    await service.supersede('T1', task('T2'));
    await expect(service.supersede('T1', task('T3'))).rejects.toMatchObject({
      code: 'IMMUTABLE_VIOLATION',
    });
  });
});
