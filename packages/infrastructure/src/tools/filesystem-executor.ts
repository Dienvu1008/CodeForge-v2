/*
 * Copyright 2026 DienVu (Dienvu1008)
 * SPDX-License-Identifier: Apache-2.0
 */

// FilesystemExecutor — P3-FS1. Real filesystem tool execution.
//
// Implements ToolExecutor for the standard filesystem tools:
//   read_file, write_file, edit_file, list_dir, delete_file, grep, glob.
//
// grep (content regex) and glob (path pattern) are READ_ONLY search tools: they recurse the
// workspace via WorkspaceManager.listDir/readFile (so the WS-003/004/005 boundary still applies
// to every path), skip noise dirs (node_modules/.git/dist/…), and return bounded, structured
// results. They are the first-class, cross-platform, in-process alternative to shelling out to
// `grep`/`find` (which are not cross-platform and carry the SYSTEM risk class via run_command).
//
// All paths go through WorkspaceManager (WS-003/004/005).
// Write/delete operations return ChangeRecords for WS-010 tracking.
// Results are plain text (stdout-like) so they can be stored as artifacts.
//
// This is NOT invoked directly — it is called by ToolGateway after approval.
import type { WorkspaceManager } from '@codeforge/agent-core';
import type { ToolExecutor, ExecutorResult } from '@codeforge/agent-core';
import type { ToolCall } from '@codeforge/agent-core';

// ── FilesystemExecutorDeps ────────────────────────────────────────────────────

export interface FilesystemExecutorDeps {
  readonly workspace:  WorkspaceManager;
  /** Max bytes to read when returning file content. Default: 256 KB. */
  readonly maxReadBytes?: number;
}

/** Directory names never descended into by grep/glob (build output, VCS, deps, scratch). */
const SEARCH_SKIP_DIRS: ReadonlySet<string> = new Set([
  'node_modules', '.git', 'dist', 'build', 'coverage', '.cache', '.codeforge', '.cf2',
]);
/** Default + hard cap on results returned by grep/glob (keeps output bounded for the model). */
const DEFAULT_SEARCH_RESULTS = 100;
const MAX_SEARCH_RESULTS = 1000;
/** Files larger than this are skipped by grep (avoid scanning huge/minified/binary blobs). */
const GREP_MAX_FILE_BYTES = 512 * 1024;

// ── FilesystemExecutor ────────────────────────────────────────────────────────

export class FilesystemExecutor implements ToolExecutor {
  private readonly maxReadBytes: number;

  constructor(private readonly deps: FilesystemExecutorDeps) {
    this.maxReadBytes = deps.maxReadBytes ?? 256 * 1024;
  }

  async execute(call: ToolCall): Promise<ExecutorResult> {
    const args = call.arguments as Record<string, unknown>;
    try {
      switch (call.toolName) {
        case 'read_file':   return await this.readFile(args, call);
        case 'write_file':  return await this.writeFile(args, call);
        case 'edit_file':   return await this.editFile(args, call);
        case 'list_dir':    return await this.listDir(args);
        case 'grep':        return await this.grep(args);
        case 'glob':        return await this.glob(args);
        case 'delete_file': return await this.deleteFile(args, call);
        default:
          return {
            exitCode: 1,
            stdout:   '',
            stderr:   `unknown filesystem tool: ${call.toolName}`,
            timedOut: false,
          };
      }
    } catch (err) {
      return {
        exitCode: 1,
        stdout:   '',
        stderr:   err instanceof Error ? err.message : String(err),
        timedOut: false,
      };
    }
  }

  // ── tool handlers ──────────────────────────────────────────────────────────

  private async readFile(args: Record<string, unknown>, call: ToolCall): Promise<ExecutorResult> {
    const relpath = String(args['path'] ?? '');
    const bytes = await this.deps.workspace.readFileBytes(relpath);

    if (bytes.length > this.maxReadBytes) {
      const snippet = bytes.slice(0, this.maxReadBytes).toString('utf8');
      return {
        exitCode: 0,
        stdout:   `[truncated: ${bytes.length} bytes, showing first ${this.maxReadBytes}]\n${snippet}`,
        stderr:   '',
        timedOut: false,
      };
    }

    // Detect binary: null byte in first 1 KB.
    const sample = bytes.slice(0, 1024);
    if (sample.includes(0)) {
      return {
        exitCode: 0,
        stdout:   `[binary file: ${bytes.length} bytes, path: ${relpath}]`,
        stderr:   '',
        timedOut: false,
      };
    }

    void call; // call available for provenance; not needed in basic impl
    return { exitCode: 0, stdout: bytes.toString('utf8'), stderr: '', timedOut: false };
  }

  private async writeFile(args: Record<string, unknown>, call: ToolCall): Promise<ExecutorResult> {
    const relpath  = String(args['path'] ?? '');
    const content  = String(args['content'] ?? '');
    const change   = await this.deps.workspace.writeFile(relpath, content, call.sessionId ?? 'unknown');
    return {
      exitCode: 0,
      stdout:   `wrote ${content.length} chars to ${relpath} (changeId: ${change.changeId})`,
      stderr:   '',
      timedOut: false,
    };
  }

  /**
   * edit_file — an in-place find/replace on an EXISTING file. Replaces exactly ONE literal
   * occurrence of `oldString` with `newString`. This is the surgical alternative to write_file
   * (which overwrites the whole file): a model fixing one line does not have to reproduce the
   * entire file, which is where reasoning models tended to give up and declare "done" instead.
   *
   * Safety by construction:
   *   - the file must exist (no accidental create — use write_file for new files);
   *   - `oldString` must occur EXACTLY once (0 → NOT_FOUND, >1 → AMBIGUOUS), so an edit can never
   *     silently change the wrong occurrence. The model is told to add surrounding context to
   *     disambiguate, mirroring how a human review would pin the hunk;
   *   - the match is a literal substring (no regex), so no injection surprises (SE-003 spirit);
   *   - the write still goes through WorkspaceManager.writeFile, so WS-003/004/005 (path/symlink
   *     boundary) and ChangeRecord tracking (WS-008) apply exactly as for write_file.
   */
  private async editFile(args: Record<string, unknown>, call: ToolCall): Promise<ExecutorResult> {
    const relpath   = String(args['path'] ?? '');
    const oldString = typeof args['oldString'] === 'string' ? args['oldString'] : undefined;
    const newString = typeof args['newString'] === 'string' ? args['newString'] : undefined;

    if (relpath.length === 0 || oldString === undefined || newString === undefined) {
      return { exitCode: 1, stdout: '', stderr: 'edit_file requires "path", "oldString", and "newString" (strings)', timedOut: false };
    }
    if (oldString.length === 0) {
      return { exitCode: 1, stdout: '', stderr: 'edit_file "oldString" must be non-empty (use write_file to create or fully replace a file)', timedOut: false };
    }
    if (oldString === newString) {
      return { exitCode: 1, stdout: '', stderr: 'edit_file "oldString" and "newString" are identical — no change', timedOut: false };
    }

    const bytes   = await this.deps.workspace.readFileBytes(relpath);
    const content = bytes.toString('utf8');

    // Count literal occurrences — must be exactly one (unambiguous edit).
    let count = 0;
    let idx = content.indexOf(oldString);
    const firstIdx = idx;
    while (idx !== -1) { count++; idx = content.indexOf(oldString, idx + oldString.length); }

    if (count === 0) {
      return { exitCode: 1, stdout: '', stderr: `edit_file: "oldString" not found in ${relpath}. Read the file and copy the exact text (including whitespace) you want to replace.`, timedOut: false };
    }
    if (count > 1) {
      return { exitCode: 1, stdout: '', stderr: `edit_file: "oldString" occurs ${count} times in ${relpath} — ambiguous. Include more surrounding context so it matches exactly once.`, timedOut: false };
    }

    const updated = content.slice(0, firstIdx) + newString + content.slice(firstIdx + oldString.length);
    const change  = await this.deps.workspace.writeFile(relpath, updated, call.sessionId ?? 'unknown');
    return {
      exitCode: 0,
      stdout:   `edited ${relpath}: replaced 1 occurrence (${oldString.length} → ${newString.length} chars) (changeId: ${change.changeId})`,
      stderr:   '',
      timedOut: false,
    };
  }

  private async listDir(args: Record<string, unknown>): Promise<ExecutorResult> {
    const relpath = String(args['path'] ?? '.');
    const entries = await this.deps.workspace.listDir(relpath);
    const lines   = entries.map((e) => `${e.isDir ? 'd' : 'f'} ${e.name}`);
    return { exitCode: 0, stdout: lines.join('\n'), stderr: '', timedOut: false };
  }

  /**
   * grep — search file CONTENTS by regular expression across the workspace (or a subtree when
   * `path` is given). Returns up to `maxResults` `path:line:text` lines. READ_ONLY. Recurses via
   * WorkspaceManager.listDir/readFile so the path boundary (WS-003/004/005) applies to every file;
   * skips SEARCH_SKIP_DIRS and files larger than GREP_MAX_FILE_BYTES / apparent binaries.
   */
  private async grep(args: Record<string, unknown>): Promise<ExecutorResult> {
    const pattern = typeof args['pattern'] === 'string' ? args['pattern'] : '';
    if (pattern === '') {
      return { exitCode: 1, stdout: '', stderr: 'grep requires a non-empty "pattern" (regular expression)', timedOut: false };
    }
    const root = normalizeDir(typeof args['path'] === 'string' ? args['path'] : '.');
    const include = typeof args['include'] === 'string' && args['include'] !== '' ? args['include'] : undefined;
    const caseSensitive = args['caseSensitive'] === true;
    const limit = clampResults(args['maxResults']);

    let re: RegExp;
    try {
      re = new RegExp(pattern, caseSensitive ? 'g' : 'gi');
    } catch (err) {
      return { exitCode: 1, stdout: '', stderr: `grep: invalid regular expression: ${err instanceof Error ? err.message : String(err)}`, timedOut: false };
    }
    const includeRe = include !== undefined ? globToRegExp(include) : undefined;

    const files = await this.walkFiles(root);
    const lines: string[] = [];
    let truncated = false;
    for (const rel of files) {
      if (includeRe !== undefined && !includeRe.test(rel)) continue;
      let content: string;
      try {
        const bytes = await this.deps.workspace.readFileBytes(rel);
        if (bytes.length > GREP_MAX_FILE_BYTES) continue;
        if (bytes.subarray(0, 1024).includes(0)) continue; // skip binary
        content = bytes.toString('utf8');
      } catch { continue; }

      const fileLines = content.split('\n');
      for (let i = 0; i < fileLines.length; i++) {
        re.lastIndex = 0;
        if (re.test(fileLines[i]!)) {
          lines.push(`${rel}:${i + 1}:${fileLines[i]!.trim().slice(0, 300)}`);
          if (lines.length >= limit) { truncated = true; break; }
        }
      }
      if (truncated) break;
    }

    const header = lines.length === 0
      ? `grep: no matches for /${pattern}/`
      : `grep: ${lines.length} match(es)${truncated ? ` (capped at ${limit})` : ''}`;
    return { exitCode: 0, stdout: `${header}\n${lines.join('\n')}`.trimEnd(), stderr: '', timedOut: false };
  }

  /**
   * glob — find files whose workspace-relative path matches a glob pattern (e.g. "src/**\/*.ts").
   * Returns up to `maxResults` sorted paths. READ_ONLY. Recurses via listDir (boundary applies);
   * skips SEARCH_SKIP_DIRS.
   */
  private async glob(args: Record<string, unknown>): Promise<ExecutorResult> {
    const pattern = typeof args['pattern'] === 'string' ? args['pattern'] : '';
    if (pattern === '') {
      return { exitCode: 1, stdout: '', stderr: 'glob requires a non-empty "pattern" (e.g. "src/**/*.ts")', timedOut: false };
    }
    const limit = clampResults(args['maxResults']);
    const re = globToRegExp(pattern);

    const files = await this.walkFiles('.');
    const matched: string[] = [];
    for (const rel of files) {
      if (re.test(rel)) {
        matched.push(rel);
        if (matched.length >= limit) break;
      }
    }
    matched.sort();
    const truncated = matched.length >= limit;
    const header = matched.length === 0
      ? `glob: no files match "${pattern}"`
      : `glob: ${matched.length} file(s)${truncated ? ` (capped at ${limit})` : ''}`;
    return { exitCode: 0, stdout: `${header}\n${matched.join('\n')}`.trimEnd(), stderr: '', timedOut: false };
  }

  /**
   * Recursively collect every file path ('/'-separated, workspace-relative) under `dir`, using
   * WorkspaceManager.listDir so each traversal step is boundary-checked. Skips SEARCH_SKIP_DIRS.
   * Deterministic order (listDir entries are walked as returned; callers sort when needed).
   */
  private async walkFiles(dir: string): Promise<readonly string[]> {
    const out: string[] = [];
    const visit = async (rel: string): Promise<void> => {
      let entries;
      try { entries = await this.deps.workspace.listDir(rel === '' ? '.' : rel); }
      catch { return; } // unreadable / out-of-bounds dir — skip
      for (const e of entries) {
        if (e.isDir) {
          if (SEARCH_SKIP_DIRS.has(e.name)) continue;
          await visit(e.relpath);
        } else if (e.isFile) {
          out.push(e.relpath);
        }
      }
    };
    await visit(normalizeDir(dir));
    return out;
  }

  private async deleteFile(args: Record<string, unknown>, call: ToolCall): Promise<ExecutorResult> {
    const relpath = String(args['path'] ?? '');
    const change  = await this.deps.workspace.deleteFile(relpath, call.sessionId ?? 'unknown');
    return {
      exitCode: 0,
      stdout:   `deleted ${relpath} (changeId: ${change.changeId})`,
      stderr:   '',
      timedOut: false,
    };
  }
}

// ── search helpers (pure) ─────────────────────────────────────────────────────

/** Normalise a directory arg to a '/'-separated workspace-relative path ('' = root). */
function normalizeDir(path: string): string {
  const p = path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  return p === '.' || p === '/' ? '' : p;
}

/** Clamp a caller maxResults to [1, MAX_SEARCH_RESULTS], defaulting to DEFAULT_SEARCH_RESULTS. */
function clampResults(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return DEFAULT_SEARCH_RESULTS;
  return Math.max(1, Math.min(MAX_SEARCH_RESULTS, Math.floor(raw)));
}

/**
 * Convert a glob pattern to an anchored RegExp over '/'-separated paths. Supports:
 *   **  → any number of path segments (incl. none)      *  → any run of non-'/' chars
 *   ?   → a single non-'/' char                          {a,b} → alternation
 * All other regex metacharacters are escaped literally. Deterministic + pure.
 */
function globToRegExp(glob: string): RegExp {
  const g = glob.replace(/\\/g, '/').replace(/^\.\//, '');
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const ch = g[i]!;
    if (ch === '*') {
      if (g[i + 1] === '*') {
        // '**' — match across segments. Consume an optional trailing '/'.
        i++;
        if (g[i + 1] === '/') i++;
        re += '(?:[^/]*(?:/[^/]*)*/?)?';
      } else {
        re += '[^/]*';
      }
    } else if (ch === '?') {
      re += '[^/]';
    } else if (ch === '{') {
      const end = g.indexOf('}', i);
      if (end > i) {
        const alts = g.slice(i + 1, end).split(',').map((a) => a.replace(/[.+^${}()|[\]\\]/g, '\\$&'));
        re += `(?:${alts.join('|')})`;
        i = end;
      } else {
        re += '\\{';
      }
    } else if ('.+^$()|[]\\'.includes(ch)) {
      re += `\\${ch}`;
    } else {
      re += ch;
    }
  }
  return new RegExp(`^${re}$`);
}
