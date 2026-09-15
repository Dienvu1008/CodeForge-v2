// P1-S2 Goal — GoalService + SqliteGoalRepository (GL-001..GL-004).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  SqliteDatabaseAdapter,
  SqliteGoalRepository,
  SqliteEventLog,
  runMigrations,
  createMigrationRegistry,
} from '@codeforge/infrastructure';
import { GoalService, GoalError } from '@codeforge/agent-core';
import type { Goal, AcceptanceCriterion } from '@codeforge/agent-core';

let db: SqliteDatabaseAdapter;
let repo: SqliteGoalRepository;
let events: SqliteEventLog;
let service: GoalService;

const AC: AcceptanceCriterion[] = [
  { criterionId: 'c1', description: 'builds', mandatory: true },
];

function goal(overrides: Partial<Goal> = {}): Goal {
  return {
    goalId: 'G1',
    version: 1,
    description: 'ship it',
    constraints: [],
    acceptanceCriteria: AC,
    createdAt: '2026-01-01T00:00:00.000Z',
    createdBy: 'user',
    ...overrides,
  };
}

function seedSession(): void {
  db.execute(
    `INSERT INTO sessions
      (session_id, workspace_id, workspace_root, goal_id, graph_version, state,
       created_at, updated_at, runtime_version, schema_version, budget_id, lock_id, metadata_json)
     VALUES ('S','W','/r','G1',1,'RUNNING','t','t','0.1.0',1,'B','L','{}')`,
  );
}

beforeEach(() => {
  db = new SqliteDatabaseAdapter(':memory:');
  db.open();
  runMigrations(db, createMigrationRegistry(), { now: () => '2026-01-01T00:00:00.000Z' });
  seedSession();
  repo = new SqliteGoalRepository(db);
  events = new SqliteEventLog(db);
  let n = 0;
  service = new GoalService({
    goals: repo,
    events,
    sessionId: 'S',
    now: () => '2026-01-01T00:00:00.000Z',
    nextId: () => `ID-${n++}`,
  });
});
afterEach(() => db.close());

describe('SqliteGoalRepository (GL-001/GL-004)', () => {
  it('creates and reads the latest version', async () => {
    await repo.create(goal());
    expect((await repo.getById('G1'))?.version).toBe(1);
  });

  it('supersede inserts a new version and links the old', async () => {
    await repo.create(goal());
    await repo.supersede('G1', goal({ version: 2, description: 'ship it better' }));
    expect((await repo.getById('G1'))?.version).toBe(2);
    expect((await repo.getVersion('G1', 1))?.supersededBy).toBe('G1');
    expect((await repo.getVersion('G1', 2))?.description).toBe('ship it better');
  });

  it('rejects reusing a version (GL-004, composite PK)', async () => {
    await repo.create(goal());
    await expect(repo.create(goal({ description: 'dup v1' }))).rejects.toMatchObject({
      code: 'ALREADY_EXISTS',
    });
  });

  it('supersede on a missing goal throws NOT_FOUND', async () => {
    await expect(repo.supersede('NOPE', goal({ version: 2 }))).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});

describe('GoalService.create — validation', () => {
  it('creates a valid v1 goal and emits GOAL_CREATED', async () => {
    await service.create(goal());
    const evs = await events.query({ sessionId: 'S' });
    expect(evs.map((e) => e.type)).toEqual(['GOAL_CREATED']);
  });

  it('rejects a goal with no acceptance criteria (GL-003)', async () => {
    await expect(service.create(goal({ acceptanceCriteria: [] }))).rejects.toMatchObject({
      code: 'MISSING_ACCEPTANCE',
    });
  });

  it('rejects a non-user/import creator (GL-002)', async () => {
    // Force an LLM-originated creator past the type via a cast — the runtime guard must catch it.
    await expect(
      service.create(goal({ createdBy: 'model' as unknown as Goal['createdBy'] })),
    ).rejects.toMatchObject({ code: 'LLM_MUTATION' });
  });

  it('rejects a first goal that is not version 1', async () => {
    await expect(service.create(goal({ version: 2 }))).rejects.toMatchObject({
      code: 'INVALID_VERSION',
    });
  });
});

describe('GoalService.supersede — versioning (GL-001/GL-004)', () => {
  beforeEach(async () => {
    await service.create(goal());
  });

  it('supersedes to version+1 and emits GOAL_SUPERSEDED', async () => {
    await service.supersede('G1', goal({ version: 2, description: 'v2' }));
    expect((await repo.getById('G1'))?.version).toBe(2);
    const types = (await events.query({ sessionId: 'S' })).map((e) => e.type);
    expect(types).toEqual(['GOAL_CREATED', 'GOAL_SUPERSEDED']);
  });

  it('rejects a non-consecutive version (GL-004)', async () => {
    await expect(service.supersede('G1', goal({ version: 3 }))).rejects.toMatchObject({
      code: 'VERSION_REUSE',
    });
  });

  it('rejects superseding a missing goal', async () => {
    await expect(service.supersede('NOPE', goal({ version: 2 }))).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});
