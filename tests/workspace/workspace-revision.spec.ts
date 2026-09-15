// C2 — WorkspaceRevision acceptance (PHASE_0_ACCEPTANCE §3.5, WR-1..WR-10).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, realpath as fsRealpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeWorkspaceRevision } from '@codeforge/infrastructure';
import { isFresh, isUlid, CANONICAL_FORM_VERSION, type UlidSources } from '@codeforge/agent-core';

let root: string;

const sources: UlidSources = {
  now: () => 1_700_000_000_000,
  randomBytes: (n) => new Uint8Array(n).fill(42),
};

const createdBy = { sessionId: 'S-1', reason: 'session_start' as const };

beforeEach(async () => {
  const parent = await mkdtemp(join(tmpdir(), 'cf2-rev-'));
  root = (await fsRealpath(parent)).replace(/\\/g, '/');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function write(rel: string, content: string): Promise<void> {
  const abs = join(root, rel);
  await mkdir(join(abs, '..'), { recursive: true });
  await writeFile(abs, content);
}

describe('computeWorkspaceRevision — schema (WR-1)', () => {
  it('has all required fields matching WORKSPACE_SPEC §5.2', async () => {
    await write('a.txt', 'x');
    const rev = await computeWorkspaceRevision({ root, createdBy, sources });
    expect(rev).toMatchObject({
      canonicalFormVersion: CANONICAL_FORM_VERSION,
      root,
      hashAlgorithm: 'blake3',
      fileCount: 1,
      createdBy: { sessionId: 'S-1', reason: 'session_start' },
    });
    expect(rev.includedPaths).toContain('a.txt');
    expect(typeof rev.hash).toBe('string');
    expect(typeof rev.createdAt).toBe('string');
  });
});

describe('WR-2: revisionId is a ULID', () => {
  it('generates a valid ULID', async () => {
    const rev = await computeWorkspaceRevision({ root, createdBy, sources });
    expect(isUlid(rev.revisionId)).toBe(true);
  });
});

describe('WR-3: hash is deterministic', () => {
  it('same content + same sources → same revision fields', async () => {
    await write('a.txt', 'x');
    const r1 = await computeWorkspaceRevision({ root, createdBy, sources });
    const r2 = await computeWorkspaceRevision({ root, createdBy, sources });
    expect(r2.hash).toBe(r1.hash);
    expect(r2.revisionId).toBe(r1.revisionId); // deterministic sources
  });
});

describe('WR-7: canonicalFormVersion recorded', () => {
  it('is "v1"', async () => {
    const rev = await computeWorkspaceRevision({ root, createdBy, sources });
    expect(rev.canonicalFormVersion).toBe('v1');
  });
});

describe('WR-6/WR-9: gitMetadata optional & not used for freshness', () => {
  it('omits gitMetadata when not provided', async () => {
    const rev = await computeWorkspaceRevision({ root, createdBy, sources });
    expect(rev.gitMetadata).toBeUndefined();
  });

  it('includes gitMetadata when provided but freshness ignores it', async () => {
    await write('a.txt', 'x');
    const withGit = await computeWorkspaceRevision({
      root,
      createdBy,
      sources,
      gitMetadata: { head: 'abc', branch: 'main', isDirty: true, hasStagedChanges: false },
    });
    const withoutGit = await computeWorkspaceRevision({ root, createdBy, sources });
    // Different git metadata, same content → still fresh (WS-009).
    expect(isFresh(withGit, withoutGit)).toBe(true);
    expect(withGit.gitMetadata).toBeDefined();
  });
});

describe('WR-8: revision binds to canonical root', () => {
  it('records the canonical root', async () => {
    const rev = await computeWorkspaceRevision({ root, createdBy, sources });
    expect(rev.root).toBe(root);
  });
});

describe('WR-10 / freshness (isFresh)', () => {
  it('fresh when hash + canonicalFormVersion match', async () => {
    await write('a.txt', 'x');
    const r1 = await computeWorkspaceRevision({ root, createdBy, sources });
    const r2 = await computeWorkspaceRevision({ root, createdBy, sources });
    expect(isFresh(r1, r2)).toBe(true);
  });

  it('stale when content changes (hash differs)', async () => {
    await write('a.txt', 'x');
    const before = await computeWorkspaceRevision({ root, createdBy, sources });
    await write('a.txt', 'y');
    const after = await computeWorkspaceRevision({ root, createdBy, sources });
    expect(isFresh(before, after)).toBe(false);
  });

  it('stale when canonicalFormVersion differs', () => {
    const a = { hash: 'deadbeef', canonicalFormVersion: 'v1' };
    const b = { hash: 'deadbeef', canonicalFormVersion: 'v2' };
    expect(isFresh(a, b)).toBe(false);
  });

  it('scratch changes do not affect freshness', async () => {
    await write('src/a.ts', 'x');
    const opts = { root, createdBy, sources, scratchPrefixes: ['node_modules'] };
    const before = await computeWorkspaceRevision(opts);
    await write('node_modules/pkg/i.js', 'junk');
    const after = await computeWorkspaceRevision(opts);
    expect(isFresh(before, after)).toBe(true);
    expect(after.excludedScratchPaths).toContain('node_modules');
  });
});

describe('WR-5: revision is a plain immutable value', () => {
  it('includedPaths and excludedScratchPaths are sorted', async () => {
    await write('b.txt', '2');
    await write('a.txt', '1');
    const rev = await computeWorkspaceRevision({
      root,
      createdBy,
      sources,
      scratchPrefixes: ['dist', 'build'],
    });
    const inc = [...rev.includedPaths];
    expect(inc).toEqual([...inc].sort());
    expect([...rev.excludedScratchPaths]).toEqual(['build', 'dist']);
  });
});
