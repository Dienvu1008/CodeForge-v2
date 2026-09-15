// @invariant WS-002
// WorkspaceRevision không được có false-negative hash (different content -> different hash).
// Enforcement: WorkspaceHasher. Phase 0. Severity CRITICAL.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, realpath as fsRealpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { computeWorkspaceHash } from '@codeforge/infrastructure';

let root: string;

beforeEach(async () => {
  const parent = await mkdtemp(join(tmpdir(), 'cf2-ws002-'));
  root = (await fsRealpath(parent)).replace(/\\/g, '/');
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function write(rel: string, content: string | Buffer): Promise<void> {
  const abs = join(root, rel);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, content);
}
async function hash(): Promise<string> {
  return (await computeWorkspaceHash({ root, algorithm: 'blake3' })).hash;
}

describe('WS-002: no false-negative hash', () => {
  it('changing one byte (same length) changes the hash', async () => {
    await write('a.txt', 'content');
    const h1 = await hash();
    await write('a.txt', 'contenu');
    expect(await hash()).not.toBe(h1);
  });

  it('adding a file changes the hash', async () => {
    await write('a.txt', 'x');
    const h1 = await hash();
    await write('b.txt', 'y');
    expect(await hash()).not.toBe(h1);
  });

  it('removing a file changes the hash', async () => {
    await write('a.txt', 'x');
    await write('b.txt', 'y');
    const h1 = await hash();
    await rm(join(root, 'b.txt'), { force: true });
    expect(await hash()).not.toBe(h1);
  });

  it('renaming a file (same content) changes the hash', async () => {
    await write('a.txt', 'same');
    const h1 = await hash();
    await rm(join(root, 'a.txt'), { force: true });
    await write('b.txt', 'same');
    expect(await hash()).not.toBe(h1);
  });

  it('CRLF vs LF changes the hash (line ending is a real change)', async () => {
    await write('a.txt', Buffer.from('l1\r\nl2', 'utf8'));
    const crlf = await hash();
    await write('a.txt', Buffer.from('l1\nl2', 'utf8'));
    expect(await hash()).not.toBe(crlf);
  });

  it('moving a file to a different directory changes the hash', async () => {
    await write('src/a.txt', 'x');
    const h1 = await hash();
    await rm(join(root, 'src'), { recursive: true, force: true });
    await write('lib/a.txt', 'x');
    expect(await hash()).not.toBe(h1);
  });
});
