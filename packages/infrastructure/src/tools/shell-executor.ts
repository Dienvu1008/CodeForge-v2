/*
 * Copyright 2026 DienVu (Dienvu1008)
 * SPDX-License-Identifier: Apache-2.0
 */

// ShellExecutor — P3-SH1. Allowlisted run_command via NodeProcessSupervisor.
//
// Implements ToolExecutor for the `run_command` tool.
//
// Security rules (SECURITY_MODEL §9):
//   SE-003: only commands in ShellPolicy.allowedCommands may execute.
//   SE-004: env is filtered through EnvGuard (DEFAULT_ENV_POLICY by default).
//   SE-007: every spawn has a hard timeout (enforced by ProcessSupervisor).
//   SE-008: full process tree killed on timeout (NodeProcessSupervisor).
//   §9.4:  shell:false always — args is an array, never a shell string.
//
// cwd = WorkspaceManager.root (caller-validated workspace boundary; WS-005).
// Arguments come from call.arguments.args — NEVER interpolated into a shell
// string; passed directly to ProcessSupervisor as a string array.
//
// NOT called directly — invoked by ToolGateway after approval (TG-001).
import { isAbsolute } from 'node:path';
import type {
  WorkspaceManager,
  ToolExecutor,
  ExecutorResult,
  ToolCall,
  ProcessSupervisor,
  SpawnResult,
} from '@codeforge/agent-core';
import {
  safeEnv,
  DEFAULT_ENV_POLICY,
  type EnvPolicy,
  checkCommand,
  resolveTimeout,
  type ShellPolicy,
  DEFAULT_SHELL_POLICY,
  ShellPolicyError,
  WorkspaceError,
  normalizeInvocation,
  extractShellArguments,
  MUTATING_PATH_COMMANDS,
  ENV_EXPANSION_EXEMPT_COMMANDS,
  type PathAccess,
} from '@codeforge/agent-core';

// ── ShellExecutorDeps ─────────────────────────────────────────────────────────

export interface ShellExecutorDeps {
  /** WorkspaceManager — provides workspace.root as cwd for all commands. */
  readonly workspace:  WorkspaceManager;
  /** ProcessSupervisor — NodeProcessSupervisor in production; fake in tests. */
  readonly supervisor: ProcessSupervisor;
  /**
   * ShellPolicy defining allowed command names and timeout bounds.
   * Defaults to DEFAULT_SHELL_POLICY (DEFAULT_SHELL_ALLOWLIST, 30 s / 300 s).
   */
  readonly shellPolicy?: ShellPolicy;
  /**
   * EnvPolicy for filtering process.env before passing to the subprocess.
   * Defaults to DEFAULT_ENV_POLICY (SECURITY_MODEL §7).
   */
  readonly envPolicy?: EnvPolicy;
}

// ── ShellExecutor ─────────────────────────────────────────────────────────────

export class ShellExecutor implements ToolExecutor {
  private readonly shellPolicy: ShellPolicy;
  private readonly envPolicy:   EnvPolicy;

  constructor(private readonly deps: ShellExecutorDeps) {
    this.shellPolicy = deps.shellPolicy ?? DEFAULT_SHELL_POLICY;
    this.envPolicy   = deps.envPolicy   ?? DEFAULT_ENV_POLICY;
  }

  async execute(call: ToolCall): Promise<ExecutorResult> {
    if (call.toolName !== 'run_command') {
      return {
        exitCode: 1,
        stdout:   '',
        stderr:   `ShellExecutor: unknown tool "${call.toolName}"`,
        timedOut: false,
      };
    }

    const raw = call.arguments as Record<string, unknown>;
    return this.runCommand(raw);
  }

  // ── run_command ────────────────────────────────────────────────────────────

  private async runCommand(raw: Record<string, unknown>): Promise<ExecutorResult> {
    // ── 1. Extract + validate arguments ──────────────────────────────────────

    const command = typeof raw['command'] === 'string' ? raw['command'].trim() : '';
    if (command === '') {
      return {
        exitCode: 1,
        stdout:   '',
        stderr:   'run_command: "command" argument is required and must be a non-empty string',
        timedOut: false,
      };
    }

    // args: optional array of string arguments.
    const argsRaw = Array.isArray(raw['args']) ? raw['args'] : [];
    const args    = (argsRaw as unknown[]).map(String);

    // timeoutMs: optional, capped by policy.
    const callerTimeout =
      typeof raw['timeoutMs'] === 'number' && Number.isFinite(raw['timeoutMs'])
        ? raw['timeoutMs']
        : undefined;
    const timeoutMs = resolveTimeout(callerTimeout, this.shellPolicy);

    // ── 2. Check allowlist (SE-003) ───────────────────────────────────────────

    try {
      checkCommand(command, this.shellPolicy);
    } catch (err) {
      if (err instanceof ShellPolicyError) {
        return {
          exitCode: 1,
          stdout:   '',
          stderr:   err.message,
          timedOut: false,
        };
      }
      throw err;
    }

    // ── 2b. Argument boundary + access checks (SE-011, SE-012, WS-011) ────────
    // Heuristic layer (not an OS sandbox): path-like arguments must stay inside the
    // workspace; file-like arguments must not be sensitive (or protected, for mutators).

    const argFailure = await this.checkArguments(command, args);
    if (argFailure !== null) {
      return { exitCode: 1, stdout: '', stderr: argFailure, timedOut: false };
    }

    // ── 3. Filter environment (SE-004) ────────────────────────────────────────

    const env = safeEnv(
      process.env as Record<string, string | undefined>,
      this.envPolicy,
    );

    // ── 4. Spawn ──────────────────────────────────────────────────────────────

    try {
      const result = await this.deps.supervisor.spawn({
        command,
        args,
        cwd:       this.deps.workspace.root,
        env,
        timeoutMs,
      });
      return this.toResult(result);
    } catch (err) {
      // SpawnError (COMMAND_NOT_FOUND / PERMISSION_DENIED / SPAWN_FAILED).
      return {
        exitCode: 1,
        stdout:   '',
        stderr:   err instanceof Error ? err.message : String(err),
        timedOut: false,
      };
    }
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  /** Returns a failure message (starting with the error code) or null when all checks pass. */
  private async checkArguments(command: string, args: readonly string[]): Promise<string | null> {
    const inv  = normalizeInvocation(command, args);
    const view = extractShellArguments(inv);
    const envExempt = ENV_EXPANSION_EXEMPT_COMMANDS.has(inv.name);
    // extractShellArguments reports the value after `=`; show the original argument.
    const shown = (v: string): string =>
      inv.args.find((a) => a === v || a.endsWith(`=${v}`)) ?? v;

    for (const a of view.pathLike) {
      const label = shown(a);
      if (view.envExpansions.includes(a)) {
        if (envExempt) continue;
        return `PATH_ESCAPE: argument "${label}" contains an environment expansion that cannot be checked; use a literal workspace-relative path`;
      }
      // checkPath treats "~" and drive-letter forms as in-root names on some platforms.
      // A drive-letter path is only a real absolute path on Windows (where checkPath judges it).
      if (a.startsWith('~') || (/^[A-Za-z]:/.test(a) && !isAbsolute(a))) {
        return `PATH_ESCAPE: argument "${label}" points outside the workspace; use a workspace-relative path`;
      }
      try {
        await this.deps.workspace.checkPath(a);
      } catch (err) {
        if (err instanceof WorkspaceError) {
          return `PATH_ESCAPE: argument "${label}" is outside the workspace (${err.message}); use a workspace-relative path`;
        }
        throw err;
      }
    }

    const access: PathAccess = MUTATING_PATH_COMMANDS.has(inv.name) ? 'write' : 'read';
    for (const a of view.fileCandidates) {
      try {
        await this.deps.workspace.checkAccess?.(access, a);
      } catch (err) {
        if (err instanceof WorkspaceError) {
          return `${err.code}: argument "${shown(a)}" is not accessible to the agent (${err.message})`;
        }
        throw err;
      }
    }
    return null;
  }

  private toResult(r: SpawnResult): ExecutorResult {
    return {
      exitCode: r.exitCode,
      stdout:   r.stdout,
      stderr:   r.stderr,
      timedOut: r.timedOut,
    };
  }
}
