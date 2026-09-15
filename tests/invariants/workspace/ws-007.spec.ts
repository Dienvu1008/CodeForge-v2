// @invariant WS-007
// Scratch zone phải được declare tường minh (chỉ path được declare mới bị loại khỏi hash).
// Enforcement: WorkspaceManager. Phase 0. Severity HIGH.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, realpath as fsRealpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { computeWorkspaceHash } from '@codeforge/infrastructure';

let root: string;

beforeEach(async () => {
  const parent = await mkdtemp(join(tmpdir(), 'cf2-ws007-'));
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
async function hash(scratch: string[]): Promise<string> {
  return (await computeWorkspaceHash({ root, scratchPrefixes: scratch, algorithm: 'blake3' })).hash;
}

describe('WS-007: scratch zone must be explicitly declared', () => {
  it('a DECLARED scratch prefix is excluded from the hash', async () => {
    await write('src/a.ts', 'x');
    const baseline = await hash(['node_modules']);
    await write('node_modules/pkg/index.js', 'junk');
    expect(await hash(['node_modules'])).toBe(baseline);
  });

  it('the SAME path counts when NOT declared as scratch (no implicit exclusion)', async () => {
    await write('src/a.ts', 'x');
    const baseline = await hash([]);
    await write('node_modules/pkg/index.js', 'junk');
    expect(await hash([])).not.toBe(baseline);
  });

  it('scratch is prefix-based, not glob: undeclared sibling still counts', async () => {
    await write('src/a.ts', 'x');
    const baseline = await hash(['dist']);
    await write('build/out.js', 'y'); // "build" is NOT declared, only "dist"
    expect(await hash(['dist'])).not.toBe(baseline);
  });

  it('declaring multiple scratch prefixes excludes each', async () => {
    await write('src/a.ts', 'x');
    const baseline = await hash(['dist', 'build']);
    await write('dist/o.js', 'a');
    await write('build/o.js', 'b');
    expect(await hash(['dist', 'build'])).toBe(baseline);
  });
});
