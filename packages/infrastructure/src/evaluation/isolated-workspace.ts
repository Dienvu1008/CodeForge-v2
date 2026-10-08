// IsolatedWorkspace — materializes a BenchmarkTask's seed files into a throwaway temp directory,
// tracks which files changed after the agent runs, and cleans up. Benchmark execution must NEVER
// touch the developer's real workspace (master prompt §12): every case gets its own directory
// under the OS temp dir, and cleanup removes it.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, relative, sep } from 'node:path';

export interface IsolatedWorkspaceHandle {
  /** Absolute path to the isolated workspace root. */
  readonly root: string;
  /** Snapshot of relative paths → content hash taken right after seeding. */
  readonly seededSnapshot: ReadonlyMap<string, string>;
}

/** Directories never scanned when diffing (noise / huge). */
const IGNORED_DIRS = new Set(['node_modules', '.git', '.codeforge', 'dist']);

/**
 * Create a fresh isolated workspace and write the seed files into it. Parent directories are
 * created as needed. Returns a handle with the root path + a post-seed file snapshot used to
 * compute `filesChanged` later.
 */
export function createIsolatedWorkspace(seedFiles: Readonly<Record<string, string>>): IsolatedWorkspaceHandle {
  const root = mkdtempSync(join(tmpdir(), 'cf-bench-'));
  for (const [rel, content] of Object.entries(seedFiles)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, 'utf8');
  }
  return { root, seededSnapshot: snapshot(root) };
}

/** Remove an isolated workspace. Best-effort — a cleanup failure must not fail the run. */
export function destroyIsolatedWorkspace(handle: IsolatedWorkspaceHandle): void {
  try { rmSync(handle.root, { recursive: true, force: true }); } catch { /* best-effort */ }
}

/** Relative paths whose content differs from (or is new since) the seed snapshot. Sorted. */
export function changedFiles(handle: IsolatedWorkspaceHandle): readonly string[] {
  const after = snapshot(handle.root);
  const changed: string[] = [];
  for (const [path, hash] of after) {
    if (handle.seededSnapshot.get(path) !== hash) changed.push(path);
  }
  // Deletions also count as changes.
  for (const path of handle.seededSnapshot.keys()) {
    if (!after.has(path)) changed.push(path);
  }
  return [...new Set(changed)].sort();
}

/** A cheap content fingerprint (length + a rolling sum) — enough to detect change deterministically. */
function fingerprint(content: string): string {
  let sum = 0;
  for (let i = 0; i < content.length; i++) sum = (sum * 31 + content.charCodeAt(i)) >>> 0;
  return `${content.length}:${sum.toString(16)}`;
}

function snapshot(root: string): Map<string, string> {
  const map = new Map<string, string>();
  const walk = (dir: string): void => {
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const name of entries) {
      if (IGNORED_DIRS.has(name)) continue;
      const abs = join(dir, name);
      let st;
      try { st = statSync(abs); } catch { continue; }
      if (st.isDirectory()) { walk(abs); continue; }
      if (!st.isFile()) continue;
      const rel = relative(root, abs).split(sep).join('/');
      try { map.set(rel, fingerprint(readFileSync(abs, 'utf8'))); } catch { /* skip unreadable */ }
    }
  };
  walk(root);
  return map;
}
