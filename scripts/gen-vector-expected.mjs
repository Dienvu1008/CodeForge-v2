// One-shot generator: builds each workspace vector, computes its blake3 hash on THIS
// platform, and writes tests/workspace/vectors/<id>/expected.json + a manifest.json.
//
// The generated expected.json is the cross-platform contract: CI on ubuntu + windows
// must reproduce the same hash. Run on any supported OS to (re)generate.
//
// Usage: node scripts/gen-vector-expected.mjs
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { VECTORS, buildVector } from '../packages/testing/dist/workspace-vectors/index.js';
import { computeWorkspaceHash } from '../packages/infrastructure/dist/index.js';

const CANONICAL_FORM_VERSION = 'v1';
const vectorsDir = join(process.cwd(), 'tests', 'workspace', 'vectors');
const platform = process.platform === 'win32' ? 'win32' : 'linux';

const manifest = { canonicalFormVersion: CANONICAL_FORM_VERSION, generatedOn: platform, vectors: [] };

for (const vector of VECTORS) {
  const runsHere = !vector.platforms || vector.platforms.includes(platform);
  const entry = {
    id: vector.id,
    notes: vector.notes,
    platforms: vector.platforms ?? ['linux', 'win32'],
    requiresSymlink: vector.requiresSymlink ?? false,
    scratchPrefixes: vector.scratchPrefixes ?? [],
  };

  if (!runsHere) {
    manifest.vectors.push({ ...entry, generated: false, reason: `not applicable on ${platform}` });
    console.log(`SKIP ${vector.id} (platform ${platform})`);
    continue;
  }

  const built = await buildVector(vector);
  try {
    if (vector.requiresSymlink && built.symlinkSkipped) {
      manifest.vectors.push({ ...entry, generated: false, reason: 'symlink unsupported on this host' });
      console.log(`SKIP ${vector.id} (no symlink support)`);
      continue;
    }
    const res = await computeWorkspaceHash({
      root: built.root,
      scratchPrefixes: vector.scratchPrefixes ?? [],
      algorithm: 'blake3',
    });
    const expected = {
      vectorId: vector.id,
      canonicalFormVersion: CANONICAL_FORM_VERSION,
      hashAlgorithm: 'blake3',
      expectedHash: res.hash,
      expectedFileCount: res.fileCount,
      expectedBytes: res.totalBytes,
      notes: vector.notes,
    };
    const dir = join(vectorsDir, vector.id);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'expected.json'), JSON.stringify(expected, null, 2) + '\n');
    manifest.vectors.push({ ...entry, generated: true, expectedHash: res.hash, expectedFileCount: res.fileCount, expectedBytes: res.totalBytes });
    console.log(`OK   ${vector.id}  ${res.hash.slice(0, 16)}...  files=${res.fileCount} bytes=${res.totalBytes}`);
  } finally {
    await built.cleanup();
  }
}

await mkdir(vectorsDir, { recursive: true });
await writeFile(join(vectorsDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`\nWrote manifest with ${manifest.vectors.length} vectors.`);
