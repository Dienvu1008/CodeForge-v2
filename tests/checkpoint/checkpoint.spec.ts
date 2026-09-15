// P1-C1 Checkpoint — CheckpointService + SqliteCheckpointRepository (CP-002/009/010/011/012).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  SqliteDatabaseAdapter,
  SqliteCheckpointRepository,
  SqliteEventLog,
  runMigrations,
  createMigrationRegistry,
} from '@codeforge/infrastructure';
import { CheckpointService } from '@codeforge/agent-core';
import type { WorkspaceRevision, ChangeRecord, CaptureInput } from '@codeforge/agent-core';

let db: SqliteDatabaseAdapter;
let repo: SqliteCheckpointRepository;
let events: SqliteEventLog;
let service: CheckpointService;

function revision(hash = 'HASH-1'): WorkspaceRevision {
  return {
    revisionId: 'rev',
    canonicalFormVersion: 'v1',
    root: '/r',
    includedPaths: [],
    excludedScratchPaths: [],
    hashAlgorithm: 'blake3',
    hash,
    fileCount: 0,
    totalBytes: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    createdBy: { sessionId: 'S', reason: 'pre_checkpoint' },
  };
}
const CHANGE: ChangeRecord = {
  changeId: 'chg1',
  sessionId: 'S',
  kind: 'modify',
  relpath: 'src/a.ts',
  ownedBy: 'agent',
  inScratchZone: false,
  at: '2026-01-01T00:00:00.000Z',
};

function capture(over: Partial<CaptureInput> = {}): CaptureInput {
  return {
    sessionId: 'S',
    graphVersion: 2,
    workspaceRevision: revision(),
    agentChangeSet: [CHANGE],
    sessionState: 'RUNNING',
    taskStates: { T1: 'PASSED', T2: 'RUNNING' },
    budgetState: 'ACTIVE',
    lastEventId: 'E-99',
    capturedAt: '2026-01-01T00:00:05.000Z',
    schemaVersion: 1,
    ...over,
  };
}

beforeEach(() => {
  db = new SqliteDatabaseAdapter(':memory:');
  db.open();
  runMigrations(db, createMigrationRegistry(), { now: () => '2026-01-01T00:00:00.000Z' });
  db.execute(
    `INSERT INTO sessions
      (session_id, workspace_id, workspace_root, goal_id, graph_version, state,
       created_at, updated_at, runtime_version, schema_version, budget_id, lock_id, metadata_json)
     VALUES ('S','W','/r','G',2,'RUNNING','t','t','0.1.0',1,'B','L','{}')`,
  );
  repo = new SqliteCheckpointRepository(db);
  events = new SqliteEventLog(db);
  let n = 0;
  service = new CheckpointService({
    checkpoints: repo,
    events,
    now: () => '2026-01-01T00:00:10.000Z',
    nextId: () => `CID-${n++}`,
  });
});
afterEach(() => db.close());

describe('CheckpointService.capture — CP-002 all 5 components atomic', () => {
  it('persists all metadata and round-trips it', async () => {
    const cp = await service.capture(capture());
    const loaded = await repo.getById(cp.checkpointId);
    expect(loaded?.graphVersion).toBe(2);
    expect(loaded?.workspaceRevision.hash).toBe('HASH-1');
    expect(loaded?.agentChangeSet).toHaveLength(1);
    expect(loaded?.sessionState).toBe('RUNNING');
    expect(loaded?.taskStates).toEqual({ T1: 'PASSED', T2: 'RUNNING' });
    expect(loaded?.budgetState).toBe('ACTIVE');
    expect(loaded?.lastEventId).toBe('E-99');
  });

  it('emits CHECKPOINT_CREATED when the filesystem did not drift', async () => {
    await service.capture(capture(), 'HASH-1'); // observed == captured
    const types = (await events.query({ sessionId: 'S' })).map((e) => e.type);
    expect(types).toEqual(['CHECKPOINT_CREATED']);
  });
});

describe('CheckpointService — CP-010/CP-011 capture-then-commit drift', () => {
  it('flags CHECKPOINT_DIRTY_AT_CAPTURE when hash drifted after commit', async () => {
    const cp = await service.capture(capture(), 'HASH-DRIFTED'); // observed != captured
    const evs = await events.query({ sessionId: 'S' });
    expect(evs.map((e) => e.type)).toEqual(['CHECKPOINT_DIRTY_AT_CAPTURE']);
    // Checkpoint remains immutable — the captured hash is preserved as a claim (CP-010).
    expect((await repo.getById(cp.checkpointId))?.workspaceRevision.hash).toBe('HASH-1');
  });
});

describe('CheckpointService.load — CP-012 drift detection', () => {
  beforeEach(async () => {
    await service.capture(capture(), 'HASH-1');
  });

  it('reports drift=false when current hash matches the checkpoint', async () => {
    const r = await service.load('S', 'HASH-1');
    expect(r?.drift).toBe(false);
    expect(r?.checkpoint.graphVersion).toBe(2);
  });

  it('reports drift=true when current hash differs (must reconcile)', async () => {
    const r = await service.load('S', 'HASH-CHANGED');
    expect(r?.drift).toBe(true);
    const types = (await events.query({ sessionId: 'S' })).map((e) => e.type);
    expect(types).toContain('CHECKPOINT_LOADED');
  });

  it('returns null when the session has no checkpoint', async () => {
    expect(await service.load('OTHER', 'X')).toBeNull();
  });
});

describe('CheckpointRepository.getLatest — CP-003 deterministic', () => {
  it('returns the newest checkpoint by capturedAt', async () => {
    await service.capture(capture({ graphVersion: 2, capturedAt: '2026-01-01T00:00:05.000Z' }), 'HASH-1');
    await service.capture(capture({ graphVersion: 3, capturedAt: '2026-01-01T00:00:09.000Z' }), 'HASH-1');
    expect((await repo.getLatest('S'))?.graphVersion).toBe(3);
  });
});
