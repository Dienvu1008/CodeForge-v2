// WorkspaceProcessSupervisor (P10.1) — a ProcessSupervisor adapter used for VERIFICATION
// checks. The VerificationEngine (Phase 1.5, frozen) spawns checks with a hardcoded
// cwd:'/' and env:{} and shell:false. Real tools (npm, npx, tsc) need (a) the workspace
// as cwd, (b) a PATH to be found, and (c) on Windows the .cmd wrapper (shell:false can't
// resolve a bare `npm`). This adapter wraps NodeProcessSupervisor and fixes exactly those
// three things WITHOUT touching the frozen engine.
//
// Scope: used only for verification spawns. Tool execution (filesystem/git/shell) keeps
// its own path through the ToolGateway. This adapter does not relax any security
// invariant — it still runs shell:false, with a minimal (not inherited-wholesale) env.
import type { ProcessSupervisor } from '@codeforge/agent-core';
import type { SpawnOptions, SpawnResult } from '@codeforge/agent-core';
import { NodeProcessSupervisor } from '../process/index.js';

const IS_WINDOWS = process.platform === 'win32';

/** npm-family launchers that are `.cmd` batch shims on Windows. */
const WINDOWS_CMD_SHIMS = new Set(['npm', 'npx', 'yarn', 'pnpm']);

/**
 * Resolve the (command, args) pair for the platform.
 *
 * On Windows the npm family (`npm`, `npx`, ...) are `.cmd` batch shims. Since Node 18.20 /
 * 20.12 / 22+ (CVE-2024-27980) `child_process.spawn` REFUSES to launch a `.cmd`/`.bat`
 * file when `shell:false` — it throws `EINVAL`. The frozen VerificationEngine always
 * spawns with `shell:false`, so we cannot invoke `npm.cmd` directly.
 *
 * The safe fix is to launch a real executable — `cmd.exe` — and pass the batch file as an
 * argument: `cmd.exe /d /s /c npm.cmd run test --silent`. This keeps Node's `shell:false`
 * (no shell-string parsing of attacker-controlled input; argv stays an array), while
 * giving Windows a launchable binary. `/d` skips AutoRun, `/s /c` run the command then
 * exit. Non-shim commands (node, absolute paths, `.exe`) pass through unchanged.
 */
function resolveSpawn(command: string, args: readonly string[]): { command: string; args: string[] } {
  if (!IS_WINDOWS || !WINDOWS_CMD_SHIMS.has(command)) {
    return { command, args: [...args] };
  }
  return {
    command: 'cmd.exe',
    args: ['/d', '/s', '/c', `${command}.cmd`, ...args],
  };
}

/**
 * Build a minimal, safe env for verification checks: PATH (so node/npm resolve) plus the
 * OS essentials a child process needs on each platform. We deliberately pass a filtered
 * env, not the whole process.env, to avoid leaking secrets (SE-004 spirit).
 */
function buildCheckEnv(extra: Readonly<Record<string, string>> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  const path = process.env['PATH'] ?? process.env['Path'] ?? '';
  env['PATH'] = path;
  if (IS_WINDOWS) {
    // npm.cmd / node need these on Windows.
    if (process.env['SystemRoot'] !== undefined) env['SystemRoot'] = process.env['SystemRoot'];
    if (process.env['windir'] !== undefined) env['windir'] = process.env['windir'];
    if (process.env['TEMP'] !== undefined) env['TEMP'] = process.env['TEMP'];
    if (process.env['APPDATA'] !== undefined) env['APPDATA'] = process.env['APPDATA'];
    if (process.env['ProgramFiles'] !== undefined) env['ProgramFiles'] = process.env['ProgramFiles'];
    // cmd.exe launcher needs COMSPEC + PATHEXT to find and run npm.cmd (shell:false path).
    if (process.env['COMSPEC'] !== undefined) env['COMSPEC'] = process.env['COMSPEC'];
    if (process.env['ComSpec'] !== undefined) env['ComSpec'] = process.env['ComSpec'];
    env['PATHEXT'] = process.env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD';
    // Node's own bin dir, in case PATH omits it.
    env['Path'] = path;
  } else {
    if (process.env['HOME'] !== undefined) env['HOME'] = process.env['HOME'];
  }
  return { ...env, ...extra };
}

export interface WorkspaceProcessSupervisorOptions {
  /** Absolute workspace root — forced as cwd for every verification spawn. */
  readonly workspaceRoot: string;
  /** Extra env entries to merge (e.g. a node bin dir). Optional. */
  readonly extraEnv?: Readonly<Record<string, string>>;
}

export class WorkspaceProcessSupervisor implements ProcessSupervisor {
  private readonly inner = new NodeProcessSupervisor();
  private readonly env: Record<string, string>;

  constructor(private readonly opts: WorkspaceProcessSupervisorOptions) {
    this.env = buildCheckEnv(opts.extraEnv);
  }

  async spawn(options: SpawnOptions): Promise<SpawnResult> {
    // Override the engine's hardcoded cwd:'/' and env:{}; resolve the command for the OS
    // (on Windows, launch npm-family .cmd shims via cmd.exe — see resolveSpawn).
    const resolved = resolveSpawn(options.command, options.args);
    return this.inner.spawn({
      ...options,
      command: resolved.command,
      args: resolved.args,
      cwd: this.opts.workspaceRoot,
      env: this.env,
    });
  }
}
