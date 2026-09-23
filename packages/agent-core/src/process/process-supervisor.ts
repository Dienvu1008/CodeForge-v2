// ProcessSupervisor — SECURITY_MODEL §9, PHASE_1_5_ROADMAP §4.1.
//
// Contract for supervised process execution. Enforces:
//   - SE-007: every subprocess has a mandatory timeout (no process runs forever).
//   - SE-008: the full process tree is bound and cleaned up on exit/timeout/kill.
//   - TG-010: a timeout event transitions ToolCall to TIMEOUT state, not left RUNNING.
//
// Design rules (SECURITY_MODEL §9):
//   - Never shell:true — arguments are an array, never a shell string (avoids injection).
//   - Working directory MUST be within the workspace root (caller's responsibility to
//     validate before calling; supervisor enforces the constraint structurally by not
//     providing a shell invocation path that could escape).
//   - Environment comes from EnvGuard-filtered SafeEnv (SE-004), not raw process.env.
//   - SIGTERM → wait gracePeriodMs → SIGKILL to the entire process tree.
//
// The concrete implementation (NodeProcessSupervisor) lives in @codeforge/infrastructure
// (DC-002: domain does not import Node APIs). Tests use FakeProcessSupervisor.

/** Filtered environment safe to pass to a subprocess (SE-004). */
export type SafeEnv = Readonly<Record<string, string>>;

/** Options for a supervised spawn. */
export interface SpawnOptions {
  /**
   * Command to execute (must be an absolute path or resolvable in PATH).
   * Never passed to a shell — arguments are separate.
   */
  readonly command: string;

  /** Arguments array. Never interpolate model output here (SECURITY_MODEL §9.4). */
  readonly args: readonly string[];

  /** Absolute path for cwd. Must be within workspace root (caller validates). */
  readonly cwd: string;

  /** Filtered environment (from EnvGuard). Defaults to empty env if omitted. */
  readonly env?: SafeEnv;

  /**
   * Hard timeout in milliseconds (SE-007). Required — no open-ended execution.
   * When exceeded: SIGTERM → gracePeriodMs → SIGKILL, then SpawnResult.timedOut=true.
   */
  readonly timeoutMs: number;

  /**
   * Grace period between SIGTERM and SIGKILL (default 3000 ms).
   * Applies on timeout AND on explicit kill().
   */
  readonly gracePeriodMs?: number;
}

/** Outcome of a supervised process. Immutable after resolve. */
export interface SpawnResult {
  /** Process exit code, or null if killed/timed-out before natural exit. */
  readonly exitCode: number | null;
  /** Collected stdout text (may be empty if caller did not request collection). */
  readonly stdout: string;
  /** Collected stderr text. */
  readonly stderr: string;
  /** True when the process was terminated because it exceeded timeoutMs (SE-007). */
  readonly timedOut: boolean;
  /** True when killed explicitly via kill() before natural exit. */
  readonly killed: boolean;
  /** Wall-clock duration from spawn to exit/kill, in milliseconds. */
  readonly durationMs: number;
}

/**
 * ProcessSupervisor — the single boundary through which the runtime spawns subprocesses.
 *
 * Concrete implementation lives in infrastructure; test double in @codeforge/testing.
 * This interface is the domain contract (DC-002: agent-core imports no Node builtins).
 */
export interface ProcessSupervisor {
  /**
   * Spawn a supervised subprocess. Resolves when the process exits or is killed.
   * Always resolves (never rejects for non-zero exit codes or timeouts — callers
   * inspect SpawnResult.exitCode / timedOut / killed). Rejects only on internal
   * infrastructure errors (e.g., command not found).
   */
  spawn(options: SpawnOptions): Promise<SpawnResult>;
}

/** Error thrown when the supervisor cannot launch the subprocess (e.g., ENOENT). */
export class SpawnError extends Error {
  public readonly code: 'COMMAND_NOT_FOUND' | 'PERMISSION_DENIED' | 'SPAWN_FAILED';
  constructor(code: SpawnError['code'], message?: string) {
    super(message ?? code);
    this.name = 'SpawnError';
    this.code = code;
  }
}
