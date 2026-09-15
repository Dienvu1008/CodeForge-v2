// @invariant WS-009
// Workspace revision hash không phụ thuộc Git (no git command, no git metadata in hash).
// Enforcement: WorkspaceHasher. Phase 0. Severity HIGH.
//
// The canonical hash is a pure function of file/dir/symlink content under the root. Git
// metadata (head/branch/dirty) is informational only and MUST NOT affect the hash or freshness.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, realpath as fsRealpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { computeWorkspaceHash, computeWorkspaceRevision } from '@codeforge/infrastructure';
import { isFresh, type UlidSources, type WorkspaceRevision } from '@codeforge/agent-core';

let root: string;
const sources: UlidSources = { now: () => 1_700_000_000_000, randomBytes: (n) => new Uint8Array(n).fill(1) };
const createdBy = { sessionId: 'S-1', reason: 'session_start' as const };

beforeEach(async () => {
  const parent = await mkdtemp(join(tmpdir(), 'cf2-ws009-'));
  root = (await fsRealpath(parent)).replace(/\\/g, '/');
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function write(rel: string, content: string): Promise<void> {
  const abs = join(root, rel);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, content);
}

describe('WS-009: hash does not depend on Git', () => {
  it('different gitMetadata + same content => same hash and still fresh', async () => {
    await write('src/a.ts', 'x');
    const revA: WorkspaceRevision = await computeWorkspaceRevision({
      root,
      createdBy,
      sources,
      gitMetadata: { head: 'aaaa', branch: 'main', isDirty: false, hasStagedChanges: false },
    });
    const revB: WorkspaceRevision = await computeWorkspaceRevision({
      root,
      createdBy,
      sources,
      gitMetadata: { head: 'bbbb', branch: 'feature', isDirty: true, hasStagedChanges: true },
    });
    expect(revA.hash).toBe(revB.hash);
    expect(isFresh(revA, revB)).toBe(true);
  });

  it('presence/absence of gitMetadata does not change the hash', async () => {
    await write('a.txt', 'content');
    const withGit = await computeWorkspaceRevision({
      root,
      createdBy,
      sources,
      gitMetadata: { head: 'zzzz', branch: 'x', isDirty: true, hasStagedChanges: false },
    });
    const withoutGit = await computeWorkspaceRevision({ root, createdBy, sources });
    expect(withGit.hash).toBe(withoutGit.hash);
  });

  it('computeWorkspaceHash is a pure function of content (no git invocation)', async () => {
    // Simulate a repo: a ".git"-like folder present. When declared scratch, it is excluded;
    // the source-only hash must be stable regardless of what lives under it.
    await write('src/a.ts', 'x');
    const base = (await computeWorkspaceHash({ root, scratchPrefixes: ['.git'], algorithm: 'blake3' })).hash;
    await write('.git/HEAD', 'ref: refs/heads/main');
    await write('.git/config', '[core]\n');
    const afterGit = (await computeWorkspaceHash({ root, scratchPrefixes: ['.git'], algorithm: 'blake3' })).hash;
    expect(afterGit).toBe(base);
  });
});
