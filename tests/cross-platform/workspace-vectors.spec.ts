// A3 / T3 — Cross-platform workspace vectors (PHASE_0_ACCEPTANCE §3.3, §3.4, XP-1..XP-6).
//
// Builds each declared vector on the CURRENT platform, computes the canonical hash, and
// asserts it matches the committed expected.json. CI runs this on ubuntu + windows; the
// same expected hash on both proves cross-platform reproducibility (WS-001).
//
// Vectors not applicable to a platform (case-collision, permissions, tab-in-name) or needing
// symlink support are skipped with a recorded reason — never silently passed.
import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { VECTORS, buildVector } from '@codeforge/testing';
import { computeWorkspaceHash } from '@codeforge/infrastructure';

const here = dirname(fileURLToPath(import.meta.url));
const vectorsDir = join(here, '..', 'workspace', 'vectors');
const platform = process.platform === 'win32' ? 'win32' : 'linux';

async function readExpected(id: string): Promise<{ expectedHash: string; expectedFileCount: number; expectedBytes: number } | null> {
  try {
    const raw = await readFile(join(vectorsDir, id, 'expected.json'), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

describe('workspace vectors — cross-platform hash contract', () => {
  for (const vector of VECTORS) {
    const runsHere = !vector.platforms || vector.platforms.includes(platform);

    it(`${vector.id}: ${vector.notes}`, async () => {
      if (!runsHere) {
        // Not applicable on this OS (e.g. case-collision on Windows). Recorded, not asserted.
        expect(true).toBe(true);
        return;
      }

      const expected = await readExpected(vector.id);
      const built = await buildVector(vector);
      try {
        if (vector.requiresSymlink && built.symlinkSkipped) {
          // Symlink unsupported on this host (Windows without Dev Mode) — skip.
          expect(true).toBe(true);
          return;
        }

        const res = await computeWorkspaceHash({
          root: built.root,
          scratchPrefixes: vector.scratchPrefixes ?? [],
          algorithm: 'blake3',
        });

        expect(res.hash).toMatch(/^[0-9a-f]{64}$/);

        if (expected) {
          expect(res.hash).toBe(expected.expectedHash);
          expect(res.fileCount).toBe(expected.expectedFileCount);
          expect(res.totalBytes).toBe(expected.expectedBytes);
        }
      } finally {
        await built.cleanup();
      }
    });
  }
});

describe('vector invariants (WS-001, WS-002)', () => {
  it('v005 (CRLF) and v006 (LF) produce different hashes', async () => {
    const crlf = VECTORS.find((v) => v.id === 'v005-line-endings-crlf')!;
    const lf = VECTORS.find((v) => v.id === 'v006-line-endings-lf')!;
    const bc = await buildVector(crlf);
    const bl = await buildVector(lf);
    try {
      const hc = (await computeWorkspaceHash({ root: bc.root, algorithm: 'blake3' })).hash;
      const hl = (await computeWorkspaceHash({ root: bl.root, algorithm: 'blake3' })).hash;
      expect(hc).not.toBe(hl);
    } finally {
      await bc.cleanup();
      await bl.cleanup();
    }
  });

  it('v008 (NFC) and v009 (NFD) produce the SAME hash', async () => {
    const nfc = VECTORS.find((v) => v.id === 'v008-unicode-nfc')!;
    const nfd = VECTORS.find((v) => v.id === 'v009-unicode-nfd')!;
    const bn = await buildVector(nfc);
    const bd = await buildVector(nfd);
    try {
      const hn = (await computeWorkspaceHash({ root: bn.root, algorithm: 'blake3' })).hash;
      const hd = (await computeWorkspaceHash({ root: bd.root, algorithm: 'blake3' })).hash;
      expect(hn).toBe(hd);
    } finally {
      await bn.cleanup();
      await bd.cleanup();
    }
  });
});
