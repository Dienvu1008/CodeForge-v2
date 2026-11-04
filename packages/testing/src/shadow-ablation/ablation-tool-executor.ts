/*
 * Copyright 2026 DienVu (Dienvu1008)
 * SPDX-License-Identifier: Apache-2.0
 */

// AblationToolExecutor (kernel-shadow-ablation, design C9). Measurement-only (SA-001).
//
// A ToolExecutor decorator that is the EP-SHELL and EP-ENV observer and records one
// `ExecutedAction` per executed tool call, in BOTH arms. It never decides anything itself: the
// Kernel decision comes from the Kernel's own `checkCommand` (EP-SHELL) and `filterEnv` (EP-ENV)
// (Requirement 4.3); the actual execution is delegated to the inner `NodeToolExecutor`.
//
// ── How the arm runner (task 6.1) must build the inner executor ──────────────────────────────
//
// `ShellExecutor` receives its allowlist ONLY through the constructor option
// `NodeToolExecutorDeps.shell.shellPolicy` (`ShellExecutorDeps.shellPolicy`, default
// `DEFAULT_SHELL_POLICY`); there is no setter and agent-core / infrastructure are not edited. So:
//
//   const inner = new NodeToolExecutor({
//     filesystem: { workspace },                       // the AblationWorkspaceManager
//     git:        { workspace, supervisor },
//     shell:      { workspace, supervisor, shellPolicy: innerShellPolicyFor(mode) },
//   });
//   const executor = new AblationToolExecutor(inner, {
//     mode, shellPolicy: DEFAULT_SHELL_POLICY, envSource: process.env, ledger,
//   });
//
//   enforce: inner ShellExecutor keeps DEFAULT_SHELL_POLICY → it makes the very decision the
//            ledger records (COMMAND_NOT_ALLOWED → exit 1 → tool FAILED, non-fatal). Behavior is
//            exactly the Kernel's (Requirement 4.2).
//   shadow:  inner ShellExecutor gets SHADOW_SHELL_POLICY (allowlist = ALLOW_ANY_COMMAND) → every
//            command reaches the arm's ProcessSupervisor, which is the containment layer:
//            FakeProcessSupervisor in Phase 1 (Requirement 7.5), ContainedProcessSupervisor in
//            Phase 2 (Requirement 7.6). The ledger records `wouldBlock` (Requirement 5.3).
//
// The shadow policy is an object literal because `createShellPolicy` copies its iterable into a
// real `Set`, which would turn ALLOW_ANY_COMMAND into an EMPTY allowlist (block everything).
//
// EP-ENV is not shadowable by design: both arms pass the same EnvGuard-filtered env (the inner
// ShellExecutor calls `safeEnv(process.env)` itself). The ledger records the names `filterEnv`
// removed — sorted, NEVER values (Requirement 5.7). `envSource` must be what ShellExecutor reads
// (`process.env`, the default) for the recorded names to describe the real spawn env.
//
// Entry order mirrors ShellExecutor: an empty `command` is an argument error (no policy decision,
// no entry); EP-SHELL is recorded next; EP-ENV only when the command reaches env filtering in THIS
// arm (enforce: Kernel allowed it; shadow: always).
//
// `ExecutedAction.effect` is derived deterministically: `simulated` if the ledger gained a
// containment event for the current step during this call (escape-simulated, command-simulated or
// kernelMiss), else `sandbox` if the tool can mutate the workspace and SUCCEEDED (for run_command:
// the spawn was delivered to the arm's supervisor with cwd = the sandbox), else `none`. Tool calls
// run sequentially in TaskExecutor, so the before/after count is unambiguous.
import {
  DEFAULT_ENV_POLICY,
  DEFAULT_SHELL_POLICY,
  ShellPolicyError,
  checkCommand,
  filterEnv,
  type ExecutorResult,
  type ShellPolicy,
  type ToolCall,
  type ToolExecutor,
} from '@codeforge/agent-core';
import { previewArgs, type DecisionLedger, type ExecutedAction } from './decision-ledger.js';

export type AblationExecutorMode = 'enforce' | 'shadow';

function allowAnyIterator(): IterableIterator<string> {
  return [][Symbol.iterator]();
}

function allowAnyPairIterator(): IterableIterator<[string, string]> {
  return ([] as Array<[string, string]>)[Symbol.iterator]();
}

/**
 * Shadow-only allowlist: `has()` is always `true`, `size` is 0 and iteration yields nothing. A
 * frozen ReadonlySet-compatible object (not a `Set`), so nothing can be added and copying it into
 * a real Set yields the empty set — which is why {@link SHADOW_SHELL_POLICY} is an object literal.
 */
export const ALLOW_ANY_COMMAND: ReadonlySet<string> = Object.freeze({
  has: (): boolean => true,
  get size(): number {
    return 0;
  },
  forEach: (): void => undefined,
  entries: allowAnyPairIterator,
  keys: allowAnyIterator,
  values: allowAnyIterator,
  [Symbol.iterator]: allowAnyIterator,
});

/**
 * ShellPolicy for the SHADOW arm's inner ShellExecutor only: allows any command name, same timeout
 * bounds as DEFAULT_SHELL_POLICY (SE-007 still holds). Never use it for an enforce arm.
 */
export const SHADOW_SHELL_POLICY: ShellPolicy = Object.freeze({
  allowedCommands: ALLOW_ANY_COMMAND,
  defaultTimeoutMs: DEFAULT_SHELL_POLICY.defaultTimeoutMs,
  maxTimeoutMs: DEFAULT_SHELL_POLICY.maxTimeoutMs,
});

/** The policy to pass as `NodeToolExecutorDeps.shell.shellPolicy` for an arm in `mode`. */
export function innerShellPolicyFor(mode: AblationExecutorMode): ShellPolicy {
  return mode === 'shadow' ? SHADOW_SHELL_POLICY : DEFAULT_SHELL_POLICY;
}

/** Tools whose success means the workspace (sandbox) may have changed. */
const WORKSPACE_EFFECT_TOOLS: ReadonlySet<string> = new Set([
  'write_file',
  'edit_file',
  'delete_file',
  'move_file',
  'git_add',
  'git_commit',
  'run_command',
]);

/** Argument keys that name workspace paths (FilesystemExecutor uses `path`; moves use from/to). */
const PATH_ARG_KEYS = ['path', 'from', 'to'] as const;

export interface AblationToolExecutorOptions {
  readonly mode: AblationExecutorMode;
  /** The ENFORCED shell policy the Kernel decision is computed against (DEFAULT_SHELL_POLICY). */
  readonly shellPolicy: ShellPolicy;
  /** Raw environment ShellExecutor filters (`process.env`). Only variable NAMES are recorded. */
  readonly envSource: Readonly<Record<string, string | undefined>>;
  readonly ledger: DecisionLedger;
}

function outcomeOf(r: ExecutorResult): ExecutedAction['outcome'] {
  // Same mapping as ToolGateway's terminal state.
  if (r.timedOut) return 'TIMEOUT';
  return r.exitCode === 0 ? 'SUCCEEDED' : 'FAILED';
}

function touchedPaths(args: unknown): string[] {
  if (args === null || typeof args !== 'object') return [];
  const rec = args as Record<string, unknown>;
  const out: string[] = [];
  for (const key of PATH_ARG_KEYS) {
    const v = rec[key];
    if (typeof v === 'string' && v !== '') out.push(v.split('\\').join('/'));
  }
  return out;
}

export class AblationToolExecutor implements ToolExecutor {
  constructor(
    private readonly inner: ToolExecutor,
    private readonly opts: AblationToolExecutorOptions,
  ) {
    if (opts.mode !== 'enforce' && opts.mode !== 'shadow') {
      throw new Error(`AblationToolExecutor: unknown mode ${String(opts.mode)}`);
    }
    if (opts.shellPolicy.allowedCommands === ALLOW_ANY_COMMAND) {
      // The decision must be computed against the ENFORCED policy, never the shadow one.
      throw new Error('AblationToolExecutor: shellPolicy must be the enforced policy, not SHADOW_SHELL_POLICY');
    }
  }

  async execute(call: ToolCall): Promise<ExecutorResult> {
    const { ledger } = this.opts;
    const argsPreview = previewArgs(call.arguments);
    if (call.toolName === 'run_command') this.observeShell(call, argsPreview);

    const step = ledger.currentStep();
    const before = this.containmentCount(step);
    let result: ExecutorResult;
    try {
      result = await this.inner.execute(call);
    } catch (err) {
      this.recordAction(call, argsPreview, 'FAILED', step, before);
      throw err;
    }
    this.recordAction(call, argsPreview, outcomeOf(result), step, before);
    return result;
  }

  // ── EP-SHELL / EP-ENV ───────────────────────────────────────────────────────

  private observeShell(call: ToolCall, argsPreview: string): void {
    const { ledger, mode, shellPolicy, envSource } = this.opts;
    const raw = (call.arguments ?? {}) as Record<string, unknown>;
    // Same extraction as ShellExecutor: an empty command never reaches the policy.
    const command = typeof raw['command'] === 'string' ? raw['command'].trim() : '';
    if (command === '') return;

    let blockedReason: string | undefined;
    try {
      checkCommand(command, shellPolicy);
    } catch (err) {
      if (!(err instanceof ShellPolicyError)) throw err;
      blockedReason = err.code;
    }

    const shadow = mode === 'shadow';
    if (blockedReason === undefined) {
      ledger.record({
        tool: call.toolName, argsPreview, point: 'EP-SHELL', decision: 'allow',
        reason: 'allowlisted', effective: 'allow', wouldBlock: false,
      });
    } else {
      ledger.record({
        tool: call.toolName, argsPreview, point: 'EP-SHELL', decision: 'block',
        reason: blockedReason, effective: shadow ? 'allow' : 'block', wouldBlock: shadow,
      });
      // Enforce: ShellExecutor returns before filtering the env — no EP-ENV decision is made.
      if (!shadow) return;
    }

    const denied = [...filterEnv(envSource, DEFAULT_ENV_POLICY).denied].sort();
    if (denied.length === 0) {
      ledger.record({
        tool: call.toolName, argsPreview, point: 'EP-ENV', decision: 'allow',
        reason: 'no variables filtered', effective: 'allow', wouldBlock: false,
      });
    } else {
      ledger.record({
        tool: call.toolName, argsPreview, point: 'EP-ENV', decision: 'filter',
        reason: `denied: ${denied.join(',')}`, effective: 'filter', wouldBlock: false,
      });
    }
  }

  // ── ExecutedAction ──────────────────────────────────────────────────────────

  private containmentCount(step: number): number {
    return this.opts.ledger.snapshot().containment.filter((c) => c.step === step).length;
  }

  private recordAction(
    call: ToolCall,
    argsPreview: string,
    outcome: ExecutedAction['outcome'],
    step: number,
    before: number,
  ): void {
    const simulated = this.containmentCount(step) > before;
    const effect: ExecutedAction['effect'] = simulated
      ? 'simulated'
      : outcome === 'SUCCEEDED' && WORKSPACE_EFFECT_TOOLS.has(call.toolName)
        ? 'sandbox'
        : 'none';
    this.opts.ledger.executed({
      tool: call.toolName,
      argsPreview,
      outcome,
      effect,
      touched: touchedPaths(call.arguments),
    });
  }
}
