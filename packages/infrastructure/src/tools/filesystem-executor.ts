// FilesystemExecutor — P3-FS1. Real filesystem tool execution.
//
// Implements ToolExecutor for the standard filesystem tools:
//   read_file, write_file, list_dir, delete_file.
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
