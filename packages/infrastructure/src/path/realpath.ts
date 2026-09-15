// Realpath resolution (filesystem-touching) — WORKSPACE_SPEC §3.1, §3.4.
//
// Resolves symlinks and enforces:
//   - target must stay within workspace root (WS-004: SYMLINK_ESCAPE)
//   - symlink loops are rejected (SYMLINK_LOOP)
//
// Kept separate from lexical `canonicalize.ts` so most path logic is testable
// without creating symlinks (which need Dev Mode on Windows, PLATFORM_SUPPORT §7.2).

import { realpath as fsRealpath } from 'node:fs/promises';
import { canonicalizePath, isWithinRoot, toCanonicalSeparators } from './canonicalize.js';
import { PathError } from './errors.js';

export interface RealpathOptions {
  readonly root: string;
  readonly platform?: 'win32' | 'linux';
}

interface FsError extends Error {
  code?: string;
}

/**
 * Canonicalize lexically, then resolve realpath and re-check the boundary.
 *
 * Returns the resolved canonical ('/'-separated) absolute path, guaranteed within root.
 * Throws:
 *   - PATH_ESCAPE   if lexical form is outside root
 *   - SYMLINK_ESCAPE if the realpath resolves outside root
 *   - SYMLINK_LOOP   if the OS reports a symlink loop
 *   - NOT_FOUND      if the path does not exist
 */
export async function resolveRealpath(input: string, opts: RealpathOptions): Promise<string> {
  const platform = opts.platform ?? (process.platform === 'win32' ? 'win32' : 'linux');

  // Lexical canonicalization first (cheap, catches escape/null-byte/reserved).
  const lexical = canonicalizePath(input, { root: opts.root, platform });

  // Also resolve the root itself so symlinked roots compare correctly.
  let resolvedRoot: string;
  try {
    resolvedRoot = toCanonicalSeparators(await fsRealpath(opts.root));
  } catch {
    // If root cannot be resolved, fall back to the given root (lexical boundary still holds).
    resolvedRoot = toCanonicalSeparators(opts.root);
  }

  let resolved: string;
  try {
    resolved = toCanonicalSeparators(await fsRealpath(lexical));
  } catch (err) {
    const e = err as FsError;
    if (e.code === 'ELOOP') {
      throw new PathError('SYMLINK_LOOP', input, `symlink loop resolving ${input}`);
    }
    if (e.code === 'ENOENT') {
      throw new PathError('NOT_FOUND', input, `path not found: ${input}`);
    }
    throw err;
  }

  if (!isWithinRoot(resolved, resolvedRoot, platform)) {
    throw new PathError('SYMLINK_ESCAPE', input, `symlink target escapes root: ${resolved}`);
  }

  return resolved;
}
