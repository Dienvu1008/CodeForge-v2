// ShellPolicy — P3-SH1. Allowlist contract for the run_command tool.
//
// SE-003/SE-007: subprocesses are only allowed when the command is in an
// explicit allowlist. Arguments are NEVER interpolated into a shell string
// (SECURITY_MODEL §9.4 shell:false). The allowlist is the last line of
// defence against model-injected arbitrary command execution.
//
// Design rules:
//   - Allowlist is a Set<string> of bare command names (e.g. 'npm', 'node').
//     Full absolute paths are also supported (e.g. '/usr/bin/python3').
//   - Matching is case-sensitive on Unix; case-insensitive on Windows is
//     handled by the caller normalising to lowercase before checking.
//   - The policy is immutable after construction (ReadonlySet semantics).
//   - The default policy is intentionally narrow — only common dev-tool
//     commands. Callers can extend it via `createShellPolicy([...DEFAULTS, 'myTool'])`.

// ── ShellPolicy ───────────────────────────────────────────────────────────────

export interface ShellPolicy {
  /**
   * Immutable set of allowed command names / absolute paths.
   * Shell*Executor checks this before spawning (SE-003).
   */
  readonly allowedCommands: ReadonlySet<string>;

  /**
   * Default timeout in ms for run_command when the caller does not supply one.
   * Must be > 0. Enforced as the upper bound; ToolDefinition.argsSchema also
   * caps at 300 000 ms (SECURITY_MODEL §9 SE-007).
   */
  readonly defaultTimeoutMs: number;

  /**
   * Hard maximum timeout — even if the caller supplies a higher value, this
   * wins (SE-007: no process runs forever).
   */
  readonly maxTimeoutMs: number;
}

// ── ShellPolicyError ──────────────────────────────────────────────────────────

export class ShellPolicyError extends Error {
  public readonly code: 'COMMAND_NOT_ALLOWED' | 'TIMEOUT_EXCEEDED' | 'ARGS_INVALID';
  public readonly command: string;

  constructor(
    code: ShellPolicyError['code'],
    command: string,
    message?: string,
  ) {
    super(message ?? `${code}: ${command}`);
    this.name = 'ShellPolicyError';
    this.code = code;
    this.command = command;
  }
}

// ── Default allowlist ─────────────────────────────────────────────────────────

/**
 * Default set of allowed command names for the development-agent use case.
 *
 * Rationale per entry:
 *   echo, printf  — basic output (safe, stateless)
 *   cat, head, tail, wc, grep, find  — read-only filesystem inspection
 *   ls, dir       — directory listing
 *   pwd, hostname — workspace/identity info (read-only)
 *   mkdir, cp, mv, rm — safe within the workspace boundary (WorkspaceManager
 *                        enforces root; ShellExecutor passes cwd=root)
 *   node, npm, npx, yarn, pnpm  — Node.js toolchain (builds, installs)
 *   tsc, eslint, vitest, jest   — TypeScript/test toolchain
 *   git           — git operations (overlaps with GitExecutor; allowed for
 *                   scripts that call git directly)
 *   python3, pip3 — Python toolchain (common in mixed repos)
 *   curl          — HTTP read (SE-009: network access must be explicit; curl
 *                   is in the allowlist but callers should review policy)
 *
 * This is NOT a security boundary by itself — `WorkspaceManager.checkPath`
 * and `EnvGuard` are the primary controls. The allowlist prevents the model
 * from invoking arbitrary binaries (e.g. `rm -rf /`, `curl | bash`).
 */
export const DEFAULT_SHELL_ALLOWLIST: ReadonlySet<string> = new Set([
  // Output
  'echo',
  'printf',
  // Filesystem inspection (read)
  'cat',
  'head',
  'tail',
  'wc',
  'grep',
  'find',
  // Directory listing
  'ls',
  'dir',
  // Info
  'pwd',
  'hostname',
  // Filesystem mutation (within workspace)
  'mkdir',
  'cp',
  'mv',
  'rm',
  // Node.js toolchain
  'node',
  'npm',
  'npx',
  'yarn',
  'pnpm',
  // TypeScript / lint / test
  'tsc',
  'eslint',
  'vitest',
  'jest',
  // Git (also covered by GitExecutor)
  'git',
  // Python toolchain
  'python3',
  'pip3',
  // Network (read-only intent)
  'curl',
  'wget',
]);

// ── createShellPolicy factory ─────────────────────────────────────────────────

/**
 * Create an immutable ShellPolicy from a list of allowed command names.
 *
 * @param allowedCommands  Iterable of command names/paths to allow. Pass
 *   `DEFAULT_SHELL_ALLOWLIST` to start from the default set.
 * @param defaultTimeoutMs Default timeout (ms). Default: 30 000.
 * @param maxTimeoutMs     Hard cap on caller-supplied timeout. Default: 300 000.
 */
export function createShellPolicy(
  allowedCommands: Iterable<string> = DEFAULT_SHELL_ALLOWLIST,
  defaultTimeoutMs = 30_000,
  maxTimeoutMs     = 300_000,
): ShellPolicy {
  if (defaultTimeoutMs <= 0) {
    throw new RangeError(`defaultTimeoutMs must be > 0, got ${defaultTimeoutMs}`);
  }
  if (maxTimeoutMs < defaultTimeoutMs) {
    throw new RangeError(
      `maxTimeoutMs (${maxTimeoutMs}) must be >= defaultTimeoutMs (${defaultTimeoutMs})`,
    );
  }
  return {
    allowedCommands: new Set(allowedCommands),
    defaultTimeoutMs,
    maxTimeoutMs,
  };
}

/**
 * Default production ShellPolicy — DEFAULT_SHELL_ALLOWLIST,
 * 30 s default timeout, 300 s max.
 */
export const DEFAULT_SHELL_POLICY: ShellPolicy = createShellPolicy();

// ── checkCommand ──────────────────────────────────────────────────────────────

/**
 * Verify that `command` is allowed by `policy`.
 *
 * On Windows, the bare command name may arrive as 'npm.cmd' or 'NPM'.
 * We normalise by also checking the lowercase base name without extension,
 * and the original value.  The allowlist itself stores bare names ('npm').
 *
 * Throws `ShellPolicyError('COMMAND_NOT_ALLOWED')` if the command is blocked.
 */
export function checkCommand(command: string, policy: ShellPolicy): void {
  if (policy.allowedCommands.has(command)) return;

  // Try bare name (last path component, drop extension).
  const base = command.split(/[/\\]/).pop() ?? command;
  const baseLower = base.replace(/\.[^.]+$/, '').toLowerCase();
  if (policy.allowedCommands.has(base) || policy.allowedCommands.has(baseLower)) return;

  throw new ShellPolicyError(
    'COMMAND_NOT_ALLOWED',
    command,
    `command "${command}" is not in the ShellPolicy allowlist`,
  );
}

/**
 * Resolve the effective timeout:
 *   1. Use caller-supplied value if present and within bounds.
 *   2. Cap at policy.maxTimeoutMs (SE-007).
 *   3. Fall back to policy.defaultTimeoutMs.
 */
export function resolveTimeout(
  callerTimeoutMs: number | undefined,
  policy: ShellPolicy,
): number {
  if (callerTimeoutMs === undefined || !Number.isFinite(callerTimeoutMs) || callerTimeoutMs <= 0) {
    return policy.defaultTimeoutMs;
  }
  return Math.min(callerTimeoutMs, policy.maxTimeoutMs);
}
