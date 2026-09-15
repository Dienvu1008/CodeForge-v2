// Case sensitivity — WORKSPACE_SPEC §3.3, PLATFORM_SUPPORT §7.1.
//
// Policy MUST NOT be hardcoded per-OS; detect at runtime for the actual workspace root
// (e.g. WSL2 /home is case-sensitive but /mnt/c is not). Falls back to a platform default.

import { mkdtemp, writeFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Detect whether the filesystem hosting `dir` is case-sensitive by creating a
 * lowercase probe file and checking whether its uppercase name resolves.
 *
 * Deterministic per filesystem. Cleans up after itself.
 */
export async function detectCaseSensitivity(dir?: string): Promise<boolean> {
  const base = dir ?? (await mkdtemp(join(tmpdir(), 'cf2-case-')));
  const lower = join(base, 'cf2_probe_case');
  const upper = join(base, 'CF2_PROBE_CASE');
  const createdTemp = dir === undefined;
  try {
    await writeFile(lower, '');
    try {
      await access(upper);
      // Uppercase resolved to the lowercase file => case-insensitive.
      return false;
    } catch {
      // Uppercase not found => case-sensitive.
      return true;
    }
  } finally {
    await rm(lower, { force: true });
    if (createdTemp) await rm(base, { recursive: true, force: true });
  }
}

/** Platform default when runtime detection is not available. */
export function defaultCaseSensitivity(
  platform: 'win32' | 'linux' = process.platform === 'win32' ? 'win32' : 'linux',
): boolean {
  // Windows/NTFS: insensitive. Linux/ext4 (WSL2 /home): sensitive.
  return platform !== 'win32';
}

/**
 * Detect a case collision within a set of canonical relative paths, assuming a
 * case-insensitive filesystem. Returns the first colliding pair, or null.
 *
 * Enforces WORKSPACE_SPEC §3.3: reject when two paths differ only by case on a
 * case-insensitive FS (would lose a file when copied cross-platform).
 */
export function findCaseCollision(paths: readonly string[]): readonly [string, string] | null {
  const seen = new Map<string, string>();
  for (const p of paths) {
    const key = p.toLowerCase();
    const prev = seen.get(key);
    if (prev !== undefined && prev !== p) {
      return [prev, p];
    }
    if (prev === undefined) seen.set(key, p);
  }
  return null;
}
