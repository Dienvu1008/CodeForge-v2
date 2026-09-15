// Canonical workspace hash — WORKSPACE_SPEC §6.
//
// Cross-platform reproducible, no false negatives, no Git/mtime dependence.
// Enforces WS-001 (canonical cross-platform), WS-002 (no false negative), WS-009 (no Git).

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { blake3 } from '@noble/hashes/blake3';
import { bytesToHex } from '@noble/hashes/utils';
import { fileLine, symlinkLine, dirLine, nfc } from './canonical-line.js';
import { walkWorkspace, type WalkOptions } from './walk.js';

export type HashAlgorithm = 'blake3' | 'sha256';

export interface WorkspaceHashOptions {
  /** canonical workspace root, '/'-separated */
  readonly root: string;
  /** scratch prefixes (canonical relative paths) to exclude */
  readonly scratchPrefixes?: readonly string[];
  /** overall hash algorithm; default blake3 */
  readonly algorithm?: HashAlgorithm;
  readonly onWarn?: (message: string) => void;
}

export interface WorkspaceHashResult {
  readonly hash: string; // hex
  readonly algorithm: HashAlgorithm;
  readonly fileCount: number;
  readonly totalBytes: number;
  /** NFC-normalized canonical relpaths included in the hash, sorted (files, symlinks, empty dirs) */
  readonly includedPaths: readonly string[];
  /** the concatenated canonical lines (useful for debugging vectors) */
  readonly canonicalManifest: string;
}

/** Streaming SHA-256 of a file's raw bytes (never load > chunk into memory). */
export function hashFileContent(absPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    const stream = createReadStream(absPath, { highWaterMark: 1024 * 1024 });
    stream.on('data', (chunk) => h.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(h.digest('hex')));
  });
}

/** Byte-wise comparison of two strings' UTF-8 encodings (WORKSPACE_SPEC §6.2 step 3). */
function compareUtf8(a: string, b: string): number {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return Buffer.compare(ba, bb);
}

export async function computeWorkspaceHash(
  opts: WorkspaceHashOptions,
): Promise<WorkspaceHashResult> {
  const algorithm: HashAlgorithm = opts.algorithm ?? 'blake3';

  const walkOpts: WalkOptions = {
    root: opts.root,
    scratchPrefixes: opts.scratchPrefixes ?? [],
    ...(opts.onWarn ? { onWarn: opts.onWarn } : {}),
  };
  const entries = await walkWorkspace(walkOpts);

  // Sort by NFC-normalized relpath, byte-wise on UTF-8 (stable, deterministic).
  entries.sort((x, y) => compareUtf8(nfc(x.relpath), nfc(y.relpath)));

  let manifest = '';
  let fileCount = 0;
  let totalBytes = 0;
  const includedPaths: string[] = [];

  for (const e of entries) {
    includedPaths.push(nfc(e.relpath));
    if (e.type === 'FILE') {
      const st = await stat(e.absPath);
      const size = st.size;
      const contentHash = await hashFileContent(e.absPath);
      manifest += fileLine(e.relpath, size, contentHash);
      fileCount++;
      totalBytes += size;
    } else if (e.type === 'SYMLINK') {
      manifest += symlinkLine(e.relpath, e.linkTarget ?? '');
    } else {
      manifest += dirLine(e.relpath);
    }
  }

  const manifestBytes = Buffer.from(manifest, 'utf8');
  const hash =
    algorithm === 'blake3'
      ? bytesToHex(blake3(manifestBytes))
      : createHash('sha256').update(manifestBytes).digest('hex');

  return { hash, algorithm, fileCount, totalBytes, includedPaths, canonicalManifest: manifest };
}
