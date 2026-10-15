// SweBenchWorkspaceSetup (infrastructure) — prepares an isolated workspace for a SWE-bench case
// and applies the judging test patch, over an injected ProcessSupervisor (so it is fully testable
// with a fake supervisor and never shells out directly).
//
// Two phases, matching the SWE-bench harness contract:
//   prepareBaseline(root, setup)  BEFORE the agent runs: materialise the repo at base_commit in
//                                 the isolated workspace. The agent then edits this tree to fix
//                                 the issue described in the task.
//   applyTestPatch(root, setup)   AFTER the agent runs, BEFORE the check: apply the test_patch
//                                 (the harness-owned tests) on top of the agent's edits, so the
//                                 command check runs the FAIL_TO_PASS/PASS_TO_PASS selection.
//
// IMPORTANT (evaluation integrity): the test_patch and the gold patch are applied/handled ONLY by
// this harness — never written where the agent can read them before it is judged. prepareBaseline
// must NOT apply the test_patch; applyTestPatch runs only after the agent's run has ended.
//
// Repo source: SWE-bench's reference harness uses pre-built Docker images per instance. Without
// Docker, this setup clones the GitHub repo and checks out base_commit. The clone source is
// injectable (`resolveRepoUrl`) so a caller can point at a local mirror/cache instead of the
// network — the production path for reproducibility. Dependency installation (pip/tox) is left to
// the caller's test command / environment, as in the reference harness.
import { promises as fsp } from 'node:fs';
import { join } from 'node:path';
import type { ProcessSupervisor, SpawnResult } from '@codeforge/agent-core';
import type { SweBenchSetup } from '@codeforge/agent-core';

export interface SweBenchWorkspaceSetupDeps {
  readonly supervisor: ProcessSupervisor;
  /** git executable (default 'git'). */
  readonly git?: string;
  /**
   * Map a "owner/name" repo to a clone URL (or a local path). Default: the public GitHub HTTPS
   * URL. Override to use a local mirror/cache for offline, reproducible runs.
   */
  readonly resolveRepoUrl?: (repo: string) => string;
  /** Per-git-step timeout (ms). Default 600_000 (clones can be large). */
  readonly stepTimeoutMs?: number;
}

export interface SweBenchSetupResult {
  readonly ok: boolean;
  /** Which step failed (for an INVALID case attribution), when ok=false. */
  readonly failedStep?: 'clone' | 'checkout' | 'apply_test_patch';
  readonly detail?: string;
}

const DEFAULT_STEP_TIMEOUT_MS = 600_000;

export class SweBenchWorkspaceSetup {
  private readonly git: string;
  private readonly resolveRepoUrl: (repo: string) => string;
  private readonly stepTimeoutMs: number;

  constructor(private readonly deps: SweBenchWorkspaceSetupDeps) {
    this.git = deps.git ?? 'git';
    this.resolveRepoUrl = deps.resolveRepoUrl ?? ((repo) => `https://github.com/${repo}.git`);
    this.stepTimeoutMs = deps.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
  }

  /**
   * Clone the repo into `root` and check out base_commit. Returns ok=false (not throw) on any git
   * failure so the runner records the case as INVALID rather than a crash. The test_patch is NOT
   * applied here — the agent must never see the judging tests before it is evaluated.
   */
  async prepareBaseline(root: string, setup: SweBenchSetup): Promise<SweBenchSetupResult> {
    const url = this.resolveRepoUrl(setup.repo);
    // Clone into the workspace root itself (clone to '.'). Use a shallow-ish full clone so any
    // base_commit is reachable (SWE-bench commits can be deep): no --depth, but --no-tags to trim.
    const clone = await this.gitIn(root, ['clone', '--no-tags', url, '.']);
    if (!this.succeeded(clone)) {
      return { ok: false, failedStep: 'clone', detail: this.detail(clone) };
    }
    const checkout = await this.gitIn(root, ['checkout', '--force', setup.baseCommit]);
    if (!this.succeeded(checkout)) {
      return { ok: false, failedStep: 'checkout', detail: this.detail(checkout) };
    }
    return { ok: true };
  }

  /**
   * Apply the harness test_patch on top of the current tree (the agent's edits). Writes the patch
   * to a temp file inside the workspace scratch area and runs `git apply`. Returns ok=false on a
   * failed apply (e.g. the agent's edits conflict with the test files — a real failure signal).
   */
  async applyTestPatch(root: string, setup: SweBenchSetup): Promise<SweBenchSetupResult> {
    if (setup.testPatch.trim() === '') return { ok: true }; // nothing to apply
    const patchDir = join(root, '.codeforge');
    const patchPath = join(patchDir, 'swe-bench-test.patch');
    try {
      await fsp.mkdir(patchDir, { recursive: true });
      await fsp.writeFile(patchPath, setup.testPatch, 'utf8');
    } catch (e) {
      return { ok: false, failedStep: 'apply_test_patch', detail: `write patch: ${String(e)}` };
    }
    // --3way lets it apply even when context lines drifted from the agent's edits; --whitespace
    // is left default so a genuinely broken patch still fails (a real signal, not silently fixed).
    const apply = await this.gitIn(root, ['apply', '--3way', patchPath]);
    if (!this.succeeded(apply)) {
      return { ok: false, failedStep: 'apply_test_patch', detail: this.detail(apply) };
    }
    return { ok: true };
  }

  // ── internals ───────────────────────────────────────────────────────────────

  private gitIn(cwd: string, args: readonly string[]): Promise<SpawnResult> {
    return this.deps.supervisor.spawn({
      command: this.git,
      args: ['--no-pager', ...args],
      cwd,
      env: {
        PATH: process.env['PATH'] ?? '/usr/bin:/usr/local/bin:/bin',
        GIT_TERMINAL_PROMPT: '0', // never block on a credential prompt
        GIT_CONFIG_NOSYSTEM: '1',
        // Fallback HOME = the workspace itself, so git never reads a developer's global config.
        HOME: process.env['HOME'] ?? cwd,
        TERM: 'dumb',
      },
      timeoutMs: this.stepTimeoutMs,
    });
  }

  private succeeded(r: SpawnResult): boolean {
    return r.exitCode === 0 && !r.timedOut && !r.killed;
  }

  private detail(r: SpawnResult): string {
    const text = (r.stderr || r.stdout || '').trim();
    if (r.timedOut) return `timed out${text ? `: ${text.slice(0, 500)}` : ''}`;
    return `exit ${String(r.exitCode)}${text ? `: ${text.slice(0, 500)}` : ''}`;
  }
}
