// P1-F5 Repository implementations acceptance — DOMAIN_CONTRACTS §23, RI-1..RI-8.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  SqliteDatabaseAdapter,
  SqliteSessionRepository,
  SqliteTaskRepository,
  SqliteTaskRunRepository,
  SqliteVerificationRepository,
  SqliteTaskGraphRepository,
  RepoError,
  runMigrations,
  createMigrationRegistry,
} from '@codeforge/infrastructure';
import type {
  Session,
  Task,
  TaskRun,
  VerificationReport,
  TaskGraph,
  GraphMutation,
  WorkspaceRevision,
  Provenance,
} from '@codeforge/agent-core';

let db: SqliteDatabaseAdapter;

beforeEach(() => {
  db = new SqliteDatabaseAdapter(':memory:');
  db.open();
  runMigrations(db, createMigrationRegistry(), { now: () => '2026-01-01T00:00:00.000Z' });
});
afterEach(() => db.close());

// ---- fixtures ----
const REVISION: WorkspaceRevision = {
  revisionId: 'rev1',
  canonicalFormVersion: 'v1',
  root: '/r',
  includedPaths: [],
  excludedScratchPaths: [],
  hashAlgorithm: 'blake3',
  hash: 'deadbeef',
  fileCount: 0,
  totalBytes: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  createdBy: { sessionId: 'S', reason: 'session_start' },
};
const PROVENANCE: Provenance = {
  provenanceId: 'P',
  source: { kind: 'planner' as never, id: 'p' } as Provenance['source'],
  inputs: [],
  reason: 'test',
  at: '2026-01-01T00:00:00.000Z',
};

function session(overrides: Partial<Session> = {}): Session {
  return {
    sessionId: 'S',
    workspaceId: 'W',
    workspaceRoot: '/r',
    goalId: 'G',
    graphVersion: 1,
    state: 'RUNNING',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    runtimeVersion: '0.1.0',
    schemaVersion: 1,
    budgetId: 'B',
    lockId: 'L',
    metadata: {
      hostname: 'h',
      processId: 1,
      ollamaEndpoint: 'http://localhost:11434',
      ollamaModels: { planner: 'p', critic: 'c', executor: 'e', analyzer: 'a' },
    },
    ...overrides,
  };
}
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
async function seedSession(id = 'S'): Promise<void> {
  await new SqliteSessionRepository(db).create(session({ sessionId: id }));
}

describe('SqliteSessionRepository (RI-1) — mutable aggregate + optimistic lock', () => {
  it('creates and reads a session', async () => {
    const repo = new SqliteSessionRepository(db);
    await repo.create(session());
    const got = await repo.getById('S');
    expect(got?.state).toBe('RUNNING');
    expect(got?.metadata.ollamaModels.planner).toBe('p');
  });

  it('rejects a duplicate create with ALREADY_EXISTS', async () => {
    const repo = new SqliteSessionRepository(db);
    await repo.create(session());
    await expect(repo.create(session())).rejects.toMatchObject({ code: 'ALREADY_EXISTS' });
  });

  it('updates a session and bumps the internal version', async () => {
    const repo = new SqliteSessionRepository(db);
    await repo.create(session());
    await repo.update(session({ state: 'AWAITING_HUMAN' }));
    expect((await repo.getById('S'))?.state).toBe('AWAITING_HUMAN');
  });

  it('update on a missing session throws NOT_FOUND', async () => {
    const repo = new SqliteSessionRepository(db);
    await expect(repo.update(session({ sessionId: 'GHOST' }))).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('successive updates each bump the internal version (optimistic-lock column advances)', async () => {
    const repo = new SqliteSessionRepository(db);
    await repo.create(session());
    await repo.update(session({ state: 'CANCELLING' }));
    await repo.update(session({ state: 'RUNNING' }));
    const v = db.query<{ version: number }>("SELECT version FROM sessions WHERE session_id = 'S'")[0]
      ?.version;
    expect(v).toBe(3); // created at 1, +1 per update
  });

  it('getActiveByWorkspace ignores terminal sessions', async () => {
    const repo = new SqliteSessionRepository(db);
    await repo.create(session({ sessionId: 'S1', state: 'COMPLETED' }));
    expect(await repo.getActiveByWorkspace('W')).toBeNull();
    await repo.create(session({ sessionId: 'S2', state: 'RUNNING' }));
    expect((await repo.getActiveByWorkspace('W'))?.sessionId).toBe('S2');
  });
});

describe('SqliteTaskRepository (RI-2/RI-7) — immutable + supersede', () => {
  it('creates and reads a task; has no update()', async () => {
    const repo = new SqliteTaskRepository(db);
    await repo.create(task('T1'));
    expect((await repo.getById('T1'))?.description).toBe('task T1');
    expect('update' in repo).toBe(false);
  });

  it('supersede inserts the new task and links the old one', async () => {
    const repo = new SqliteTaskRepository(db);
    await repo.create(task('T1'));
    await repo.supersede('T1', task('T2'));
    expect((await repo.getById('T1'))?.supersededBy).toBe('T2');
    expect((await repo.getById('T2'))?.taskId).toBe('T2');
  });

  it('rejects superseding an already-superseded task (TI-004)', async () => {
    const repo = new SqliteTaskRepository(db);
    await repo.create(task('T1'));
    await repo.supersede('T1', task('T2'));
    await expect(repo.supersede('T1', task('T3'))).rejects.toMatchObject({
      code: 'IMMUTABLE_VIOLATION',
    });
  });

  it('rejects superseding a missing task', async () => {
    const repo = new SqliteTaskRepository(db);
    await expect(repo.supersede('NOPE', task('T2'))).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('SqliteTaskRunRepository (RI-4/RI-7) — finalize once', () => {
  function run(overrides: Partial<TaskRun> = {}): TaskRun {
    return {
      taskRunId: 'R1',
      taskId: 'T1',
      sessionId: 'S',
      attemptNumber: 1,
      state: 'RUNNING',
      graphVersionAtStart: 1,
      workspaceRevisionAtStart: REVISION,
      strategyUsed: { kind: 'generate' },
      startedAt: '2026-01-01T00:00:00.000Z',
      toolCalls: [],
      failures: [],
      budgetConsumed: { wallClockMs: 0, modelTokens: 0, toolCalls: 0, recoveryAttempts: 0 },
      ...overrides,
    };
  }

  beforeEach(async () => {
    await seedSession();
    await new SqliteTaskRepository(db).create(task('T1'));
  });

  it('creates a RUNNING run and reads it back', async () => {
    const repo = new SqliteTaskRunRepository(db);
    await repo.create(run());
    expect((await repo.getById('R1'))?.state).toBe('RUNNING');
    expect('update' in repo).toBe(false);
  });

  it('finalizes exactly once', async () => {
    const repo = new SqliteTaskRunRepository(db);
    await repo.create(run());
    await repo.finalize('R1', {
      state: 'SUCCEEDED',
      endedAt: '2026-01-01T00:01:00.000Z',
      workspaceRevisionAtEnd: REVISION,
      verificationId: 'V1',
    });
    const got = await repo.getById('R1');
    expect(got?.state).toBe('SUCCEEDED');
    expect(got?.endedAt).toBe('2026-01-01T00:01:00.000Z');
    expect(got?.verificationId).toBe('V1');
  });

  it('rejects a second finalize (EX-001)', async () => {
    const repo = new SqliteTaskRunRepository(db);
    await repo.create(run());
    await repo.finalize('R1', { state: 'SUCCEEDED', endedAt: 't' });
    await expect(repo.finalize('R1', { state: 'FAILED', endedAt: 't2' })).rejects.toMatchObject({
      code: 'IMMUTABLE_VIOLATION',
    });
  });
});

describe('SqliteVerificationRepository (RI-5) — append-only', () => {
  function report(id: string, overrides: Partial<VerificationReport> = {}): VerificationReport {
    return {
      verificationId: id,
      sessionId: 'S',
      taskId: 'T1',
      taskRunId: 'R1',
      targetWorkspaceRevision: REVISION,
      canonicalFormVersion: 'v1',
      scope: 'FULL',
      checks: [],
      status: 'PASS',
      startedAt: '2026-01-01T00:00:00.000Z',
      endedAt: '2026-01-01T00:01:00.000Z',
      toolVersions: {},
      artifacts: [],
      invariantsChecked: [],
      schemaVersion: 1,
      ...overrides,
    };
  }
  beforeEach(async () => {
    await seedSession();
  });

  it('creates and reads by id + by task', async () => {
    const repo = new SqliteVerificationRepository(db);
    await repo.create(report('V1'));
    await repo.create(report('V2', { status: 'FAIL' }));
    expect((await repo.getById('V1'))?.status).toBe('PASS');
    const byTask = await repo.getByTask('T1');
    expect(byTask.map((r) => r.verificationId)).toEqual(['V1', 'V2']);
  });

  it('getLatestForRevision finds the newest report for a revision', async () => {
    const repo = new SqliteVerificationRepository(db);
    await repo.create(report('V1', { endedAt: '2026-01-01T00:01:00.000Z' }));
    await repo.create(report('V2', { endedAt: '2026-01-01T00:02:00.000Z' }));
    expect((await repo.getLatestForRevision('rev1'))?.verificationId).toBe('V2');
    expect(await repo.getLatestForRevision('nope')).toBeNull();
  });
});

describe('SqliteTaskGraphRepository (RI-3) — atomic commit across 3 tables (GI-008)', () => {
  function graph(version: number, overrides: Partial<TaskGraph> = {}): TaskGraph {
    return {
      graphId: 'G',
      sessionId: 'S',
      version,
      nodes: [{ taskId: 'T1', addedInVersion: version }],
      edges: [
        {
          edgeId: `E-${version}`,
          fromTaskId: 'T1',
          toTaskId: 'T2',
          kind: 'depends_on',
          addedInVersion: version,
        },
      ],
      createdAt: '2026-01-01T00:00:00.000Z',
      createdBy: 'planner',
      canonicalHash: `hash-${version}`,
      schemaVersion: 1,
      canonicalFormVersion: 'v1',
      ...overrides,
    };
  }
  function mutation(baseVersion: number): GraphMutation {
    return {
      mutationId: `M-${baseVersion}`,
      sessionId: 'S',
      baseVersion,
      operations: [],
      proposedBy: 'planner',
      reason: 'init',
      provenance: PROVENANCE,
      createdAt: '2026-01-01T00:00:00.000Z',
      status: 'COMMITTED',
    };
  }
  beforeEach(async () => {
    await seedSession();
  });

  it('commits a version and reads it back with nodes + edges', async () => {
    const repo = new SqliteTaskGraphRepository(db);
    await repo.commit(graph(1), mutation(0));
    const current = await repo.getCurrent('S');
    expect(current.version).toBe(1);
    expect(current.nodes.map((n) => n.taskId)).toEqual(['T1']);
    expect(current.edges[0]?.kind).toBe('depends_on');
  });

  it('getCurrent returns the highest version', async () => {
    const repo = new SqliteTaskGraphRepository(db);
    await repo.commit(graph(1), mutation(0));
    await repo.commit(graph(2), mutation(1));
    expect((await repo.getCurrent('S')).version).toBe(2);
    expect((await repo.getVersion('S', 1))?.version).toBe(1);
    expect(await repo.getVersion('S', 99)).toBeNull();
  });

  it('rejects committing an existing version (GI-003 monotonic)', async () => {
    const repo = new SqliteTaskGraphRepository(db);
    await repo.commit(graph(1), mutation(0));
    await expect(repo.commit(graph(1), mutation(0))).rejects.toBeInstanceOf(RepoError);
  });

  it('getCurrent throws NOT_FOUND when the session has no graph', async () => {
    const repo = new SqliteTaskGraphRepository(db);
    await expect(repo.getCurrent('S')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
