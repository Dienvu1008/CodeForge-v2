// Workspace walk — WORKSPACE_SPEC §6.2.
//
// Produces a deterministic list of entries (FILE | SYMLINK | DIR) with canonical
// relative paths ('/'-separated). Applies scratch-zone exclusion by path prefix,
// skips symlinks whose realpath escapes the root, and records empty directories
// (only directories that contain no files matter — §6.2 step 2f).

import { readdir, lstat, readlink, realpath as fsRealpath } from 'node:fs/promises';
import type { EntryType } from './canonical-line.js';
import { toCanonicalSeparators } from '../path/canonicalize.js';

export interface WalkEntry {
  readonly type: EntryType;
  /** canonical relative path, '/'-separated, NOT yet NFC/escape-normalized */
  readonly relpath: string;
  /** absolute path on disk (native separators) */
  readonly absPath: string;
  /** symlink target string (only for SYMLINK) */
  readonly linkTarget?: string;
}

export interface WalkOptions {
  /** canonical workspace root, '/'-separated */
  readonly root: string;
  /**
   * scratch prefixes as canonical relative paths ('/'-separated), e.g. ["node_modules", "dist"].
   * A path P is excluded if P === prefix or P starts with prefix + "/".
   */
  readonly scratchPrefixes?: readonly string[];
  /** optional sink for skip warnings (symlink escape) */
  readonly onWarn?: (message: string) => void;
}

function isExcluded(relpath: string, prefixes: readonly string[]): boolean {
  for (const prefix of prefixes) {
    const p = prefix.replace(/\/+$/, '');
    if (p === '') continue;
    if (relpath === p || relpath.startsWith(`${p}/`)) return true;
  }
  return false;
}

/** True if `resolved` (canonical '/') is within `root` (canonical '/'). Case-sensitive compare. */
function withinRoot(resolved: string, root: string): boolean {
  const r = root.replace(/\/+$/, '');
  return resolved === r || resolved.startsWith(`${r}/`);
}

export async function walkWorkspace(opts: WalkOptions): Promise<WalkEntry[]> {
  const scratch = opts.scratchPrefixes ?? [];
  const rootNative = opts.root;
  const entries: WalkEntry[] = [];

  async function recurse(dirAbs: string, dirRel: string): Promise<void> {
    const names = await readdir(dirAbs);
    let childCount = 0;

    for (const name of names) {
      const childAbs = joinNative(dirAbs, name);
      const childRel = dirRel === '' ? name : `${dirRel}/${name}`;

      if (isExcluded(childRel, scratch)) continue;

      const st = await lstat(childAbs);

      if (st.isSymbolicLink()) {
        // Do NOT follow. Record target; skip if realpath escapes root.
        const target = await readlink(childAbs);
        let escapes = false;
        try {
          const resolved = toCanonicalSeparators(await fsRealpath(childAbs));
          escapes = !withinRoot(resolved, opts.root);
        } catch {
          // Broken symlink: keep it recorded (target string still meaningful).
          escapes = false;
        }
        if (escapes) {
          opts.onWarn?.(`symlink escapes root, skipped: ${childRel}`);
          continue;
        }
        childCount++;
        entries.push({
          type: 'SYMLINK',
          relpath: childRel,
          absPath: childAbs,
          linkTarget: toCanonicalSeparators(target),
        });
      } else if (st.isDirectory()) {
        childCount++;
        await recurse(childAbs, childRel);
      } else if (st.isFile()) {
        childCount++;
        entries.push({ type: 'FILE', relpath: childRel, absPath: childAbs });
      }
      // Other entry kinds (sockets, devices) are ignored.
    }

    // Empty directory matters (§6.2 step 2f). Root itself is never emitted as DIR.
    if (childCount === 0 && dirRel !== '') {
      entries.push({ type: 'DIR', relpath: dirRel, absPath: dirAbs });
    }
  }

  await recurse(rootNative, '');
  return entries;
}

// Absolute paths are kept '/'-separated. Node's fs accepts forward slashes on Windows,
// so a single canonical separator works cross-platform for reading from disk.
function joinNative(dir: string, name: string): string {
  const base = dir.replace(/\/+$/, '');
  return `${base}/${name}`;
}
