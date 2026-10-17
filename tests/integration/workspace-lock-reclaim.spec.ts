// workspace-lock-reclaim (P12.23) — crash recovery for a wedged workspace lock.
//
// A hard crash (SIGKILL, the Electron-ABI exit) leaves a lock row with released_at IS NULL, so
// every subsequent goal is rejected with "workspace already locked". reclaimStale() releases such
// a lock IFF the owning PID is provably dead on THIS host — never a live owner or a different host.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  SqliteDatabaseAdapter,
  SqliteWorkspaceLockService,
  runMigrations,
  createMigrationRegistry,
} from '@codeforge/infrastructure';
import type { DatabaseAdapter } from '@codeforge/infrastructure';

let db: DatabaseAdapter;
let lock: SqliteWorkspaceLockService;
const NOW = '2026-01-01T00:00:00.000Z';
const LATER = '2026-01-01T00:05:00.000Z';

beforeEach(() => {
  db = new SqliteDatabaseAdapter(':memory:');
  db.open();
  runMigrations(db, createMigrationRegistry(), { now: () => NOW });
  lock = new SqliteWorkspaceLockService(db);
});
afterEach(() => { db.close(); });

async function hold(workspaceId: string, hostname: string, processId: number): Promise<void> {
  await lock.acquire({
    lockId: 'L1', workspaceId, sessionId: 'S1', hostname, processId, at: NOW,
  });
}

const dead = (): boolean => false;      // every PID is dead
const alive = (): boolean => true;      // every PID is alive

describe('SqliteWorkspaceLockService.reclaimStale', () => {
  it('reclaims a lock whose owner PID is dead on this host, freeing the workspace', async () => {
    await hold('W', 'host-a', 4242);
    expect((await lock.getActive('W'))?.sessionId).toBe('S1');

    const reclaimed = await lock.reclaimStale('W', 'host-a', dead, LATER);
    expect(reclaimed).toBe(true);
    expect(await lock.getActive('W')).toBeNull();

    // After reclaim a new session can acquire the workspace again.
    await expect(lock.acquire({
      lockId: 'L2', workspaceId: 'W', sessionId: 'S2', hostname: 'host-a', processId: 777, at: LATER,
    })).resolves.toMatchObject({ sessionId: 'S2' });
  });

  it('does NOT reclaim a lock whose owner is still alive', async () => {
    await hold('W', 'host-a', 4242);
    const reclaimed = await lock.reclaimStale('W', 'host-a', alive, LATER);
    expect(reclaimed).toBe(false);
    expect((await lock.getActive('W'))?.sessionId).toBe('S1');
  });

  it('does NOT reclaim a lock owned by a different host (even if we think its PID is dead)', async () => {
    await hold('W', 'other-host', 4242);
    const reclaimed = await lock.reclaimStale('W', 'host-a', dead, LATER);
    expect(reclaimed).toBe(false);
    expect((await lock.getActive('W'))?.sessionId).toBe('S1');
  });

  it('is a no-op when the workspace holds no lock', async () => {
    const reclaimed = await lock.reclaimStale('W', 'host-a', dead, LATER);
    expect(reclaimed).toBe(false);
    expect(await lock.getActive('W')).toBeNull();
  });
});
