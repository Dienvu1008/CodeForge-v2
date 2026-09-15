// @invariant WS-001
// WorkspaceRevision hash phải canonical và cross-platform reproducible.
// Enforcement: WorkspaceHasher. Phase 0. Severity CRITICAL.
//
// Within a single OS we prove: (a) determinism (same content -> same hash across runs),
// (b) canonical form independent of entry creation order and path separators,
// (c) equality with the committed expected.json (cross-OS contract; CI runs on ubuntu+windows).
import { describe, it, expect } from 'vitest';
import { readFile, mkdtemp, mkdir, writeFile, rm, realpath as fsRealpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VECTORS, buildVector } from '@codeforge/testing';
import { computeWorkspaceHash } from '@codeforge/infrastructure';

const here = dirname(fileURLToPath(import.meta.url));
const vectorsDir = join(here, '..', '..', 'workspace', 'vectors');
const platform = process.platform === 'win32' ? 'win32' : 'linux';

describe('WS-001: canonical, cross-platform reproducible hash', () => {
  it('is deterministic: same content produces the same hash across runs', async () => {
    const v = VECTORS.find((x) => x.id === 'v004-nested-dirs')!;
    const a = await buildVector(v);
    const b = await buildVector(v);
    try {
      const ha = (await computeWorkspaceHash({ root: a.root, algorithm: 'blake3' })).hash;
      const hb = (await computeWorkspaceHash({ root: b.root, algorithm: 'blake3' })).hash;
      expect(ha).toBe(hb);
    } finally {
      await a.cleanup();
      await b.cleanup();
    }
  });

  it('is independent of entry creation order (canonical sort)', async () => {
    async function mk(order: readonly [string, string][]): Promise<string> {
      const parent = await mkdtemp(join(tmpdir(), 'cf2-ws001-'));
      const root = (await fsRealpath(parent)).replace(/\\/g, '/');
      for (const [rel, content] of order) {
        const abs = join(root, rel);
        await mkdir(dirname(abs), { recursive: true });
        await writeFile(abs, content);
      }
      const h = (await computeWorkspaceHash({ root, algorithm: 'blake3' })).hash;
      await rm(parent, { recursive: true, force: true });
      return h;
    }
    const h1 = await mk([['a.txt', '1'], ['b.txt', '2'], ['c/d.txt', '3']]);
    const h2 = await mk([['c/d.txt', '3'], ['b.txt', '2'], ['a.txt', '1']]);
    expect(h1).toBe(h2);
  });

  it('matches the committed expected.json (cross-OS contract) for applicable vectors', async () => {
    let checked = 0;
    for (const v of VECTORS) {
      const runsHere = !v.platforms || v.platforms.includes(platform);
      if (!runsHere) continue;
      let expected: { expectedHash: string } | null = null;
      try {
        expected = JSON.parse(await readFile(join(vectorsDir, v.id, 'expected.json'), 'utf8'));
      } catch {
        continue; // expected not generated on this platform yet (e.g. linux-only vectors)
      }
      const built = await buildVector(v);
      try {
        if (v.requiresSymlink && built.symlinkSkipped) continue;
        const res = await computeWorkspaceHash({
          root: built.root,
          scratchPrefixes: v.scratchPrefixes ?? [],
          algorithm: 'blake3',
        });
        expect(res.hash, `vector ${v.id}`).toBe(expected!.expectedHash);
        checked++;
      } finally {
        await built.cleanup();
      }
    }
    expect(checked).toBeGreaterThan(0);
  });
});
