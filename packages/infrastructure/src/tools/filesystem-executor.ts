// FilesystemExecutor — P3-FS1. Real filesystem tool execution.
//
// Implements ToolExecutor for the standard filesystem tools:
//   read_file, write_file, edit_file, list_dir, delete_file.
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
