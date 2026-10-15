// WorkspaceSnapshotRollback (P12.14) — content snapshot + restore over a real temp workspace.
//
// Verifies the ROLLBACK port's revert semantics: after captureClean(), an agent's edits (modify,
// create, delete) are all undone by rollbackToLastClean() back to the exact clean baseline.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkspaceSnapshotRollback } from '@codeforge/infrastructure';

let dir: string;
let rb: WorkspaceSnapshotRollback;

async function exists(rel: string): Promise<boolean> {
  try { await access(join(dir, rel)); return true; } catch { return false; }
}
const read  = (rel: string): Promise<string> => readFile(join(dir, rel), 'utf8');
async function write(rel: string, content: string): Promise<void> {
  const abs = join(dir, rel);
  const slash = abs.lastIndexOf('/') >= 0 ? abs.lastIndexOf('/') : abs.lastIndexOf('\\');
  if (slash > 0) await mkdir(abs.slice(0, slash), { recursive: true });
  await writeFile(abs, content, 'utf8');
}

describe('WorkspaceSnapshotRollback (P12.14)', () => {
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cf2-rollback-'));
    rb  = new WorkspaceSnapshotRollback({ root: dir });
    // Seed a clean baseline: two source files in a nested dir.
    await write('src/a.js', 'module.exports = 1;\n');
    await write('src/b.js', 'module.exports = 2;\n');
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('restores a MODIFIED file to its clean content', async () => {
    await rb.captureClean('S');
    await write('src/a.js', 'BROKEN syntax {{{');
    expect(await rb.rollbackToLastClean('S')).toBe(true);
    expect(await read('src/a.js')).toBe('module.exports = 1;\n');
  });

  it('deletes a file the agent CREATED after the clean point', async () => {
    await rb.captureClean('S');
    await write('src/new.js', 'extra');
    expect(await exists('src/new.js')).toBe(true);
    expect(await rb.rollbackToLastClean('S')).toBe(true);
    expect(await exists('src/new.js')).toBe(false);
  });

  it('re-creates a file the agent DELETED after the clean point', async () => {
    await rb.captureClean('S');
    await rm(join(dir, 'src/b.js'));
    expect(await exists('src/b.js')).toBe(false);
    expect(await rb.rollbackToLastClean('S')).toBe(true);
    expect(await read('src/b.js')).toBe('module.exports = 2;\n');
  });

  it('handles a mix of modify + create + delete in one revert', async () => {
    await rb.captureClean('S');
    await write('src/a.js', 'junk');       // modify
    await write('src/c.js', 'created');    // create
    await rm(join(dir, 'src/b.js'));       // delete
    expect(await rb.rollbackToLastClean('S')).toBe(true);
    expect(await read('src/a.js')).toBe('module.exports = 1;\n');
    expect(await exists('src/c.js')).toBe(false);
    expect(await read('src/b.js')).toBe('module.exports = 2;\n');
  });

  it('returns false when no clean snapshot was captured for the session (nothing to revert)', async () => {
    expect(rb.hasSnapshot('S')).toBe(false);
    expect(await rb.rollbackToLastClean('S')).toBe(false);
  });

  it('is per-session: a snapshot for one session does not revert another', async () => {
    await rb.captureClean('S1');
    await write('src/a.js', 'changed');
    expect(await rb.rollbackToLastClean('S2')).toBe(false); // S2 has no snapshot
    expect(await read('src/a.js')).toBe('changed');          // untouched
    expect(await rb.rollbackToLastClean('S1')).toBe(true);
    expect(await read('src/a.js')).toBe('module.exports = 1;\n');
  });

  it('captureClean replaces the prior baseline (latest clean point wins)', async () => {
    await rb.captureClean('S');                 // baseline 1
    await write('src/a.js', 'version 2\n');
    await rb.captureClean('S');                 // baseline 2 (now the clean point)
    await write('src/a.js', 'version 3 broken');
    expect(await rb.rollbackToLastClean('S')).toBe(true);
    expect(await read('src/a.js')).toBe('version 2\n'); // reverts to baseline 2, not 1
  });
});
