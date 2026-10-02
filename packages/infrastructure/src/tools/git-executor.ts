// GitExecutor — P3-GIT1. Real git tool execution via NodeProcessSupervisor.
//
// Implements ToolExecutor for the standard git tools:
//   git_status, git_diff, git_add, git_commit, git_log.
//
// Security rules:
//   - shell: false enforced by NodeProcessSupervisor (SECURITY_MODEL §9.4).
//   - Arguments are arrays — never interpolated into a shell string.
//   - env is a minimal safe set (PATH + git-identity vars); never raw process.env.
//   - cwd = WorkspaceManager.root (caller-validated workspace boundary).
//   - Every spawn has a hard timeoutMs (SE-007).
//
// NOT called directly — invoked by ToolGateway after approval (TG-001).
import type {
  WorkspaceManager,
  ToolExecutor,
  ExecutorResult,
  ToolCall,
  ProcessSupervisor,
  SpawnResult,
} from '@codeforge/agent-core';

// ── GitExecutorDeps ───────────────────────────────────────────────────────────

export interface GitExecutorDeps {
  /** WorkspaceManager — provides workspace.root as cwd for git commands. */
  readonly workspace:  WorkspaceManager;
  /** ProcessSupervisor — NodeProcessSupervisor in production; fake in tests. */
  readonly supervisor: ProcessSupervisor;
  /**
   * Path to the git binary. Defaults to 'git' (resolved from PATH).
   * Can be set to an absolute path for environments where git is not on PATH.
   */
  readonly gitPath?:   string;
  /**
   * Hard timeout per git operation in ms (SE-007). Default: 30 000.
   * Long diffs on large repos may need higher values.
   */
  readonly timeoutMs?: number;
  /**
   * Optional git identity overrides (used for git_commit).
   * If not provided, git uses its own config lookup.
   * Passing these avoids "Please tell me who you are" errors in CI/containers.
   */
  readonly gitIdentity?: {
    readonly name:  string;
    readonly email: string;
  };
}

// ── GitExecutor ───────────────────────────────────────────────────────────────

export class GitExecutor implements ToolExecutor {
  private readonly git:       string;
  private readonly timeoutMs: number;

  constructor(private readonly deps: GitExecutorDeps) {
    this.git       = deps.gitPath  ?? 'git';
    this.timeoutMs = deps.timeoutMs ?? 30_000;
  }

  async execute(call: ToolCall): Promise<ExecutorResult> {
    const args = call.arguments as Record<string, unknown>;
    try {
      switch (call.toolName) {
        case 'git_status': return await this.gitStatus();
        case 'git_diff':   return await this.gitDiff(args);
        case 'git_add':    return await this.gitAdd(args);
        case 'git_commit': return await this.gitCommit(args);
        case 'git_log':    return await this.gitLog(args);
        default:
          return {
            exitCode: 1,
            stdout:   '',
            stderr:   `unknown git tool: ${call.toolName}`,
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

  /**
   * git_status — porcelain v1 output so it is machine-parseable.
   * Example output: "M  src/foo.ts\n?? new.ts"
   */
  private async gitStatus(): Promise<ExecutorResult> {
    return this.toResult(await this.spawn(['status', '--porcelain=v1']));
  }

  /**
   * git_diff — unified diff.
   * If args.path is supplied, restrict to that path (workspace-relative).
   * If args.staged is truthy, show staged diff (--cached).
   */
  private async gitDiff(args: Record<string, unknown>): Promise<ExecutorResult> {
    const gitArgs: string[] = ['diff', '--no-color'];
    if (args['staged'] === true) gitArgs.push('--cached');
    const path = args['path'] !== undefined ? String(args['path']) : undefined;
    if (path !== undefined && path !== '') gitArgs.push('--', path);
    return this.toResult(await this.spawn(gitArgs));
  }

  /**
   * git_add — stage files.
   * args.paths must be a non-empty string array of workspace-relative paths.
   */
  private async gitAdd(args: Record<string, unknown>): Promise<ExecutorResult> {
    const paths = Array.isArray(args['paths'])
      ? (args['paths'] as unknown[]).map(String).filter(Boolean)
      : [];
    if (paths.length === 0) {
      return {
        exitCode: 1,
        stdout:   '',
        stderr:   'git_add: paths must be a non-empty array of strings',
        timedOut: false,
      };
    }
    return this.toResult(await this.spawn(['add', '--', ...paths]));
  }

  /**
   * git_commit — create a commit with all currently staged changes.
   * args.message is required and must be non-empty.
   * Uses --allow-empty-message only when message is explicitly ' ' or similar.
   */
  private async gitCommit(args: Record<string, unknown>): Promise<ExecutorResult> {
    const message = String(args['message'] ?? '').trim();
    if (message === '') {
      return {
        exitCode: 1,
        stdout:   '',
        stderr:   'git_commit: message is required and must be non-empty',
        timedOut: false,
      };
    }
    // --no-edit: do not open an editor; --no-gpg-sign: avoid GPG prompts in CI.
    return this.toResult(
      await this.spawn(['commit', '--no-edit', '--no-gpg-sign', '-m', message]),
    );
  }

  /**
   * git_log — one-line log, most recent first.
   * args.n: max number of commits (1–100, default 10).
   */
  private async gitLog(args: Record<string, unknown>): Promise<ExecutorResult> {
    const raw = Number(args['n'] ?? 10);
    // Clamp to [1, 100] to avoid unbounded output.
    const n = Math.min(100, Math.max(1, Number.isFinite(raw) ? raw : 10));
    return this.toResult(
      await this.spawn(['log', `--max-count=${n}`, '--oneline', '--no-color']),
    );
  }

  // ── private helpers ────────────────────────────────────────────────────────

  /**
   * Spawn a git command.
   * - cwd = workspace root (WS-003: always within boundary).
   * - env is minimal: PATH + optional HOME + optional git identity vars.
   *   NodeProcessSupervisor REPLACES the env entirely — never inherits secrets.
   * - shell: false enforced by NodeProcessSupervisor.
   * - --no-pager appended to all commands so git never waits for user input.
   */
  private spawn(gitArgs: string[]): Promise<SpawnResult> {
    const env: Record<string, string> = {
      PATH: process.env['PATH'] ?? '/usr/bin:/usr/local/bin:/bin',
    };
    // HOME is needed so git can read ~/.gitconfig (user.name, user.email etc.).
    if (process.env['HOME'] !== undefined) env['HOME'] = process.env['HOME'];
    // On Windows, USERPROFILE plays the role of HOME.
    if (process.env['USERPROFILE'] !== undefined) {
      env['USERPROFILE'] = process.env['USERPROFILE'];
    }
    // Inject identity overrides for CI / container environments.
    if (this.deps.gitIdentity !== undefined) {
      env['GIT_AUTHOR_NAME']     = this.deps.gitIdentity.name;
      env['GIT_AUTHOR_EMAIL']    = this.deps.gitIdentity.email;
      env['GIT_COMMITTER_NAME']  = this.deps.gitIdentity.name;
      env['GIT_COMMITTER_EMAIL'] = this.deps.gitIdentity.email;
    }
    // GIT_TERMINAL_PROMPT=0: never prompt for credentials (would hang).
    env['GIT_TERMINAL_PROMPT'] = '0';
    // TERM=dumb: prevents escape-code output in some git versions.
    env['TERM'] = 'dumb';

    return this.deps.supervisor.spawn({
      command:   this.git,
      // --no-pager: git output goes to stdout directly, never to a pager process.
      args:      ['--no-pager', ...gitArgs],
      cwd:       this.deps.workspace.root,
      env,
      timeoutMs: this.timeoutMs,
    });
  }

  /** Convert SpawnResult → ExecutorResult (same shape, direct mapping). */
  private toResult(r: SpawnResult): ExecutorResult {
    return {
      exitCode: r.exitCode,
      stdout:   r.stdout,
      stderr:   r.stderr,
      timedOut: r.timedOut,
    };
  }
}
