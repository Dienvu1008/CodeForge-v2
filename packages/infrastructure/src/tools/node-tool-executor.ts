// NodeToolExecutor — P3-TE1. Composite ToolExecutor that routes by toolName.
//
// Wraps the real tool executors (FilesystemExecutor, GitExecutor, ShellExecutor)
// and dispatches each ToolCall to the right one based on the toolName.
//
// Routing rules:
//   read_file, write_file, list_dir, delete_file, move_file  → FilesystemExecutor
//   git_status, git_diff, git_add, git_commit, git_log       → GitExecutor
//   run_command                                               → ShellExecutor
//   anything else                                             → error (no bypass)
//
// This is injected into TaskExecutor as the single ToolExecutor. The ToolGateway
// still enforces policy (TG-001) — NodeToolExecutor is the physical executor layer.
import type { ToolExecutor, ExecutorResult, ToolCall } from '@codeforge/agent-core';
import type { FilesystemExecutorDeps } from './filesystem-executor.js';
import type { GitExecutorDeps }        from './git-executor.js';
import type { ShellExecutorDeps }      from './shell-executor.js';
import { FilesystemExecutor }          from './filesystem-executor.js';
import { GitExecutor }                 from './git-executor.js';
import { ShellExecutor }               from './shell-executor.js';

// ── Tool name routing sets ────────────────────────────────────────────────────

const FILESYSTEM_TOOLS = new Set([
  'read_file', 'write_file', 'list_dir', 'delete_file', 'move_file',
]);

const GIT_TOOLS = new Set([
  'git_status', 'git_diff', 'git_add', 'git_commit', 'git_log',
]);

// ── NodeToolExecutorDeps ──────────────────────────────────────────────────────

export interface NodeToolExecutorDeps {
  /** Dependencies forwarded to FilesystemExecutor. */
  readonly filesystem: FilesystemExecutorDeps;
  /** Dependencies forwarded to GitExecutor. */
  readonly git: GitExecutorDeps;
  /** Dependencies forwarded to ShellExecutor. */
  readonly shell: ShellExecutorDeps;
}

// ── NodeToolExecutor ──────────────────────────────────────────────────────────

/**
 * Routes each approved ToolCall to the appropriate concrete executor.
 * All executors share the same WorkspaceManager root (WS-003: unified boundary).
 */
export class NodeToolExecutor implements ToolExecutor {
  private readonly fs:    FilesystemExecutor;
  private readonly git:   GitExecutor;
  private readonly shell: ShellExecutor;

  constructor(deps: NodeToolExecutorDeps) {
    this.fs    = new FilesystemExecutor(deps.filesystem);
    this.git   = new GitExecutor(deps.git);
    this.shell = new ShellExecutor(deps.shell);
  }

  async execute(call: ToolCall): Promise<ExecutorResult> {
    if (FILESYSTEM_TOOLS.has(call.toolName)) {
      return this.fs.execute(call);
    }
    if (GIT_TOOLS.has(call.toolName)) {
      return this.git.execute(call);
    }
    if (call.toolName === 'run_command') {
      return this.shell.execute(call);
    }

    // Unknown tool — no bypass (TG-001: all tools must be registered + routed).
    return {
      exitCode: 1,
      stdout:   '',
      stderr:   `NodeToolExecutor: no executor registered for tool "${call.toolName}"`,
      timedOut: false,
    };
  }
}
