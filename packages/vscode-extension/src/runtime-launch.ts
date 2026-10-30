/*
 * Copyright 2026 DienVu (Dienvu1008)
 * SPDX-License-Identifier: Apache-2.0
 */

// runtime-launch.ts (P12.23) — PURE, OFFLINE-TESTABLE helpers for the "Start Runtime Here"
// command. It builds the `node runtime-cli.js ...` argv and resolves the runtime entry path
// WITHOUT importing `vscode` or `child_process`, so the decision logic (which path, which flags)
// is unit tested. The extension's VS Code edge does the actual spawn + Output-channel streaming.
//
// Design intent (OB-006 / INFRASTRUCTURE_SPEC §14): the extension never embeds runtime logic. It
// starts the runtime as a SEPARATE child process in the open workspace folder, then connects to
// it over HTTP exactly like any other client. Easy to debug, easy to kill.

/** Everything needed to spawn a runtime in the open workspace. */
export interface RuntimeLaunchSpec {
  /** Absolute path to packages/infrastructure/dist/cli/runtime-cli.js. */
  readonly entryPath: string;
  /** Absolute path to the workspace folder the runtime should operate in. */
  readonly workspace: string;
  /** Model id to run (e.g. "qwen2.5-coder:latest"). */
  readonly model: string;
  /** HTTP port for the observability server. */
  readonly port: number;
  /** Provider endpoint (default Ollama). */
  readonly endpoint?: string;
  /** Autonomy mode. */
  readonly autonomy?: 'readonly' | 'edits' | 'full';
}

/** Inputs we resolve the runtime entry path from. */
export interface RuntimeEntryInputs {
  /** User override from the `codeforge.runtimePath` setting (absolute path), if set. */
  readonly configuredPath?: string;
  /** The repo root we can derive the default entry from (dev install). */
  readonly repoRoot?: string;
}

/** The known-good relative location of the runtime CLI inside the monorepo. */
export const RUNTIME_ENTRY_RELATIVE = 'packages/infrastructure/dist/cli/runtime-cli.js';

/**
 * Resolve the absolute path to the runtime CLI entry. Precedence:
 *   1. an explicit `codeforge.runtimePath` setting (user points at a built runtime-cli.js), else
 *   2. <repoRoot>/packages/infrastructure/dist/cli/runtime-cli.js (dev checkout).
 * Returns null when neither is available (installed .vsix with no setting) so the caller can
 * prompt for the path instead of spawning a garbage process.
 */
export function resolveRuntimeEntry(inputs: RuntimeEntryInputs): string | null {
  const configured = inputs.configuredPath?.trim();
  if (configured !== undefined && configured !== '') return configured;
  const root = inputs.repoRoot?.trim();
  if (root !== undefined && root !== '') return joinPath(root, RUNTIME_ENTRY_RELATIVE);
  return null;
}

/**
 * Build the argv for `node` (NOT including the leading "node"): the entry path followed by the
 * runtime-cli flags. We intentionally DO NOT pass `--goal`: the runtime starts idle, serving HTTP,
 * and waits for goals submitted via POST /goal (the Goals panel). Values are passed as discrete
 * argv elements (never shell-interpolated) so paths with spaces are safe.
 */
export function buildRuntimeArgv(spec: RuntimeLaunchSpec): string[] {
  const argv: string[] = [
    spec.entryPath,
    '--workspace', spec.workspace,
    '--model', spec.model,
    '--port', String(spec.port),
  ];
  if (spec.endpoint !== undefined && spec.endpoint !== '') argv.push('--endpoint', spec.endpoint);
  if (spec.autonomy !== undefined) argv.push('--autonomy', spec.autonomy);
  return argv;
}

/** The runtime base URL for a chosen port (loopback). */
export function runtimeUrlForPort(port: number): string {
  return `http://127.0.0.1:${port}`;
}

/**
 * Choose which `node` binary to spawn the runtime with. We MUST NOT use VS Code's own executable
 * (process.execPath points at the Electron runtime), because the runtime loads native modules
 * (better-sqlite3) built against the system Node's ABI — launching under Electron's Node throws
 * ERR_DLOPEN_FAILED (NODE_MODULE_VERSION mismatch). Precedence:
 *   1. an explicit `codeforge.nodePath` setting (absolute path to node), else
 *   2. the bare command "node" so the OS resolves it from PATH (the user's system Node).
 */
export function resolveNodeCommand(configuredNodePath?: string): string {
  const p = configuredNodePath?.trim();
  return p !== undefined && p !== '' ? p : 'node';
}

/** Join two path fragments with a single forward slash (works for display + Node path resolution). */
function joinPath(a: string, b: string): string {
  const left = a.replace(/[\\/]+$/, '');
  const right = b.replace(/^[\\/]+/, '');
  return `${left}/${right}`;
}
