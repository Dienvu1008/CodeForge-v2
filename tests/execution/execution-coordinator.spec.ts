// P1-T2 TaskExecution projection — ExecutionCoordinator over SQLite (EX-002/EX-003).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  SqliteDatabaseAdapter,
  SqliteTaskExecutionRepository,
  SqliteTaskRepository,
  runMigrations,
  createMigrationRegistry,
} from '@codeforge/infrastructure';
import { ExecutionCoordinator, ExecutionError } from '@codeforge/agent-core';
import type { Task } from '@codeforge/agent-core';

let db: SqliteDatabaseAdapter;
let repo: SqliteTaskExecutionRepository;
let coord: ExecutionCoordinator;

function task(id: string): Task {
  return {
    taskId: id,
    description: `task ${id}`,
    acceptanceCriteria: [],
    constraints: [],
    priority: 0,
    strategy: { kind: 'generate' },
    createdAt: '2026-01-01T00:00:00.000Z',
    createdBy: 'planner',
  };
}

beforeEach(async () => {
  db = new SqliteDatabaseAdapter(':memory:');
  db.open();
  runMigrations(db, createMigrationRegistry(), { now: () => '2026-01-01T00:00:00.000Z' });
  // task_executions has an FK to tasks — seed the task first.
  await new SqliteTaskRepository(db).create(task('T1'));
  repo = new SqliteTaskExecutionRepository(db);
  let t = 0;
  coord = new ExecutionCoordinator({
    executions: repo,
    now: () => `2026-01-01T00:00:${String(t++).padStart(2, '0')}.000Z`,
  });
  await coord.init('T1');
});
afterEach(() => db.close());

describe('ExecutionCoordinator — init + run lifecycle', () => {
  it('initializes a PENDING projection with no runs', async () => {
    const e = await coord.get('T1');
    expect(e?.currentState).toBe('PENDING');
    expect(e?.currentRunId).toBeUndefined();
    expect(e?.attempts).toBe(0);
  });

  it('onRunStarted bumps attempts, sets currentRunId, state RUNNING', async () => {
    const e = await coord.onRunStarted('T1', 'R1');
    expect(e.currentState).toBe('RUNNING');
    expect(e.currentRunId).toBe('R1');
    expect(e.attempts).toBe(1);
  });

  it('onRunEnded(SUCCEEDED) clears currentRunId and projects VERIFYING', async () => {
    await coord.onRunStarted('T1', 'R1');
    const e = await coord.onRunEnded('T1', 'R1', 'SUCCEEDED', { verificationId: 'V1' });
    expect(e.currentRunId).toBeUndefined();
    expect(e.currentState).toBe('VERIFYING');
    expect(e.latestVerificationId).toBe('V1');
    expect(e.attempts).toBe(1); // attempts unchanged on end
  });

  it('projects FAILED for TIMEOUT/INTERRUPTED and ABORTED for CANCELLED', async () => {
    await coord.onRunStarted('T1', 'R1');
    expect((await coord.onRunEnded('T1', 'R1', 'TIMEOUT')).currentState).toBe('FAILED');
    await coord.onRunStarted('T1', 'R2');
    expect((await coord.onRunEnded('T1', 'R2', 'CANCELLED')).currentState).toBe('ABORTED');
  });
});

describe('ExecutionCoordinator — EX-002 (one active run)', () => {
  it('rejects a second run while one is active', async () => {
    await coord.onRunStarted('T1', 'R1');
    await expect(coord.onRunStarted('T1', 'R2')).rejects.toBeInstanceOf(ExecutionError);
    await expect(coord.onRunStarted('T1', 'R2')).rejects.toMatchObject({
      code: 'MULTIPLE_ACTIVE_RUNS',
    });
    expect(await coord.hasActiveRun('T1')).toBe(true);
  });

  it('allows a new run after the previous one ends', async () => {
    await coord.onRunStarted('T1', 'R1');
    await coord.onRunEnded('T1', 'R1', 'FAILED');
    expect(await coord.hasActiveRun('T1')).toBe(false);
    const e = await coord.onRunStarted('T1', 'R2');
    expect(e.currentRunId).toBe('R2');
    expect(e.attempts).toBe(2); // second attempt
  });

  it('onRunEnded rejects a stale run id (not the active run)', async () => {
    await coord.onRunStarted('T1', 'R1');
    await expect(coord.onRunEnded('T1', 'RX', 'SUCCEEDED')).rejects.toMatchObject({
      code: 'NO_ACTIVE_RUN',
    });
  });
});

describe('ExecutionCoordinator — EX-003 (projection derivable, not authority)', () => {
  it('re-deriving the projection from the same event sequence is deterministic', async () => {
    // Apply a run sequence.
    await coord.onRunStarted('T1', 'R1');
    await coord.onRunEnded('T1', 'R1', 'FAILED');
    await coord.onRunStarted('T1', 'R2');
    await coord.onRunEnded('T1', 'R2', 'SUCCEEDED', { verificationId: 'V2' });
    const first = await coord.get('T1');

    // Rebuild in a FRESH db from the SAME ordered events → identical projection.
    const db2 = new SqliteDatabaseAdapter(':memory:');
    db2.open();
    runMigrations(db2, createMigrationRegistry(), { now: () => '2026-01-01T00:00:00.000Z' });
    await new SqliteTaskRepository(db2).create(task('T1'));
    let t = 0;
    const coord2 = new ExecutionCoordinator({
      executions: new SqliteTaskExecutionRepository(db2),
      now: () => `2026-01-01T00:00:${String(t++).padStart(2, '0')}.000Z`,
    });
    await coord2.init('T1');
    await coord2.onRunStarted('T1', 'R1');
    await coord2.onRunEnded('T1', 'R1', 'FAILED');
    await coord2.onRunStarted('T1', 'R2');
    await coord2.onRunEnded('T1', 'R2', 'SUCCEEDED', { verificationId: 'V2' });
    const rebuilt = await coord2.get('T1');
    db2.close();

    // Same derived state, attempts, refs — projection is a pure function of the run history.
    expect(rebuilt?.currentState).toBe(first?.currentState);
    expect(rebuilt?.attempts).toBe(first?.attempts);
    expect(rebuilt?.latestVerificationId).toBe(first?.latestVerificationId);
    expect(first?.currentState).toBe('VERIFYING');
    expect(first?.attempts).toBe(2);
  });

  it('setState projects a derived terminal state (e.g. PASSED)', async () => {
    await coord.onRunStarted('T1', 'R1');
    await coord.onRunEnded('T1', 'R1', 'SUCCEEDED');
    const e = await coord.setState('T1', 'PASSED');
    expect(e.currentState).toBe('PASSED');
  });
});
