/*
 * Copyright 2026 DienVu (Dienvu1008)
 * SPDX-License-Identifier: Apache-2.0
 */

// ContainedProcessSupervisor (kernel-shadow-ablation, design C9). Measurement-only (SA-001).
//
// Subprocess containment for Phase 2 replays (Requirement 7.6), applied identically in both arms.
// It wraps the real supervisor (`NodeProcessSupervisor` for the shell, `WorkspaceProcessSupervisor`
// for verification) and forwards a spawn ONLY when BOTH hold:
//
//   - `[command, ...args].join(' ')` equals one entry of `allowedExact` exactly (the case's declared
//     benchmark check commands plus the commands of `buildVerificationPolicy(inspectProject(root))`
//     computed on the seeded sandbox before the run), and
//   - `cwd` IS `sandbox.root`: string equality after normalizing separators to `/`, dropping a
//     trailing slash and case-folding on win32 — no realpath, no prefix match. The normalization
//     exists because `NodeWorkspaceManager` stores its root with forward slashes, and ShellExecutor
//     passes `workspace.root` as cwd, so a raw `===` would never match on Windows. Build the arm's
//     workspace on `sandbox.root`; a subdirectory cwd is simulated.
//
// Every other spawn performs no process creation: it returns {@link SHADOW_SIMULATED_SPAWN} and
// records a `command-simulated` containment event. The env is never touched here; it is whatever
// the caller passed (the EnvGuard-filtered env from ShellExecutor / the verification supervisor).
//
// The event `target` is the command line after `redact` and truncation to ARGS_PREVIEW_MAX, so no
// secret placed in an argument reaches the ledger or the report (Requirement 10.8). The `cwd` is
// not recorded: the two arms run in different mkdtemp sandboxes and must record identical events.
//
// Phase 1 does not use this class: the arm's supervisor is a FakeProcessSupervisor (Requirement
// 7.5). The constructor refuses a sandbox root outside the OS temp dir (Requirement 6.5).
import type { ProcessSupervisor, SpawnOptions, SpawnResult } from '@codeforge/agent-core';
import { redact } from '@codeforge/infrastructure';
import { ARGS_PREVIEW_MAX, type DecisionLedger } from './decision-ledger.js';
import { assertSandboxRoot, type Sandbox } from './sandbox.js';

/** Result of every simulated spawn (same shape as a real SpawnResult). */
export const SHADOW_SIMULATED_SPAWN: SpawnResult = Object.freeze({
  exitCode: 0,
  stdout: '[shadow-simulated] command not executed',
  stderr: '',
  timedOut: false,
  killed: false,
  durationMs: 0,
});

export interface ContainedProcessSupervisorOptions {
  readonly sandbox: Sandbox;
  /** Exact command lines (`[command, ...args].join(' ')`) allowed to run for real. */
  readonly allowedExact: readonly string[];
  readonly ledger: DecisionLedger;
}

/** The exact-match key of a spawn. */
export function commandLine(command: string, args: readonly string[]): string {
  return [command, ...args].join(' ');
}

/** Same-directory key: `/` separators, no trailing slash, case-folded on win32. */
function dirKey(p: string): string {
  const s = p.replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? s.toLowerCase() : s;
}

function eventTarget(line: string): string {
  const red = redact(line);
  return red.length <= ARGS_PREVIEW_MAX ? red : `${red.slice(0, ARGS_PREVIEW_MAX)}…`;
}

export class ContainedProcessSupervisor implements ProcessSupervisor {
  private readonly rootKey: string;
  private readonly allowed: ReadonlySet<string>;
  private readonly ledger: DecisionLedger;

  constructor(
    private readonly inner: ProcessSupervisor,
    opts: ContainedProcessSupervisorOptions,
  ) {
    assertSandboxRoot(opts.sandbox.root);
    this.rootKey = dirKey(opts.sandbox.root);
    this.allowed = new Set(opts.allowedExact);
    this.ledger = opts.ledger;
  }

  /** `true` iff `options` would be executed for real. */
  wouldExecute(options: SpawnOptions): boolean {
    return dirKey(options.cwd) === this.rootKey && this.allowed.has(commandLine(options.command, options.args));
  }

  async spawn(options: SpawnOptions): Promise<SpawnResult> {
    if (this.wouldExecute(options)) return this.inner.spawn(options);
    this.ledger.contained({
      kind: 'command-simulated',
      op: 'spawn',
      target: eventTarget(commandLine(options.command, options.args)),
    });
    return { ...SHADOW_SIMULATED_SPAWN };
  }
}
