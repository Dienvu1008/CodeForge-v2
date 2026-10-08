// NodeCapabilityProber — P12.3 (infrastructure). Runs a capability probe via the
// ProcessSupervisor and maps the SpawnResult/SpawnError to a ProbeOutcome. This is the I/O
// side of capability verification (MI-003): the pure core (verdictFromOutcome) decides the
// status; this adapter just executes `<tool> --version` safely.
//
// Platform notes:
//   - ProcessSupervisor spawns shell:false and REPLACES env entirely, so we inject a minimal
//     SafeEnv containing PATH (+ Windows essentials) so the executable can be resolved.
//   - On Windows, npm/flutter/dart are .cmd wrappers; node's spawn without shell cannot run a
//     bare `npm`, so we resolve to the `.cmd` form for known wrapper tools.
import type { ProcessSupervisor, SafeEnv } from '@codeforge/agent-core';
import { SpawnError } from '@codeforge/agent-core';
import type { CapabilityProbe, CapabilityProber, ProbeOutcome } from '@codeforge/agent-core';

const IS_WINDOWS = process.platform === 'win32';
/** Tools that ship as .cmd/.bat wrappers on Windows and cannot be spawned bare (shell:false). */
const WINDOWS_WRAPPERS = new Set(['npm', 'npx', 'flutter', 'dart', 'pnpm', 'yarn']);

export interface NodeCapabilityProberDeps {
  readonly supervisor: ProcessSupervisor;
  /** cwd for probes — must be a real directory the supervisor accepts (e.g. workspace root). */
  readonly cwd: string;
  /** Per-probe timeout (ms). Default 10s — version probes are fast; a hang → UNAVAILABLE. */
  readonly timeoutMs?: number;
}

export class NodeCapabilityProber implements CapabilityProber {
  constructor(private readonly deps: NodeCapabilityProberDeps) {}

  async probe(probe: CapabilityProbe): Promise<ProbeOutcome> {
    const command = this.resolveCommand(probe.command);
    try {
      const result = await this.deps.supervisor.spawn({
        command,
        args: [...probe.args],
        cwd: this.deps.cwd,
        env: this.safeEnv(),
        timeoutMs: this.deps.timeoutMs ?? 10_000,
      });
      return {
        probe,
        exitCode: result.exitCode,
        output: `${result.stdout}\n${result.stderr}`.trim(),
        notFound: false,
        timedOut: result.timedOut,
      };
    } catch (err) {
      // SpawnError COMMAND_NOT_FOUND → the tool is genuinely absent (UNAVAILABLE, not an error).
      if (err instanceof SpawnError && err.code === 'COMMAND_NOT_FOUND') {
        return { probe, exitCode: null, output: '', notFound: true, timedOut: false };
      }
      // Any other spawn failure is also treated as "not usable" rather than crashing discovery.
      return { probe, exitCode: null, output: err instanceof Error ? err.message : String(err), notFound: true, timedOut: false };
    }
  }

  /** Resolve a .cmd wrapper on Windows for tools that need it. */
  private resolveCommand(command: string): string {
    if (IS_WINDOWS && WINDOWS_WRAPPERS.has(command)) return `${command}.cmd`;
    return command;
  }

  /** Minimal env: PATH so the executable resolves, plus Windows essentials. No secrets. */
  private safeEnv(): SafeEnv {
    const env: Record<string, string> = {};
    const path = process.env['PATH'] ?? process.env['Path'] ?? '';
    if (path.length > 0) env['PATH'] = path;
    if (IS_WINDOWS) {
      if (process.env['PATHEXT'] !== undefined) env['PATHEXT'] = process.env['PATHEXT'];
      if (process.env['SystemRoot'] !== undefined) env['SystemRoot'] = process.env['SystemRoot'];
      if (process.env['SystemDrive'] !== undefined) env['SystemDrive'] = process.env['SystemDrive'];
    }
    return env;
  }
}
