// FakeProcessSupervisor — deterministic test double for ProcessSupervisor (P1.5-PS1).
//
// Allows tests to configure exact outcomes (exitCode, stdout, stderr, timedOut) per
// command or via a sequence, without spawning real subprocesses. No wall-clock, no
// network, no filesystem. Mirrors the FakeModel pattern.
import type { ProcessSupervisor, SpawnOptions, SpawnResult } from '@codeforge/agent-core';
import { SpawnError } from '@codeforge/agent-core';

/** A canned outcome for one spawn call. */
export interface FakeSpawnOutcome {
  readonly exitCode?: number | null;
  readonly stdout?: string;
  readonly stderr?: string;
  /** If true the result has timedOut=true and exitCode=null. */
  readonly timedOut?: boolean;
  /** If true throw a SpawnError('COMMAND_NOT_FOUND'). */
  readonly commandNotFound?: boolean;
  /** Logical duration in ms (no real delay). Default 1. */
  readonly durationMs?: number;
}

const DEFAULT_OUTCOME: Required<FakeSpawnOutcome> = {
  exitCode: 0,
  stdout: '',
  stderr: '',
  timedOut: false,
  commandNotFound: false,
  durationMs: 1,
};

export class FakeProcessSupervisor implements ProcessSupervisor {
  private readonly rules: Array<{ pattern: RegExp; outcome: FakeSpawnOutcome }> = [];
  private readonly sequence: FakeSpawnOutcome[] = [];
  private _callCount = 0;
  private _calls: Array<{ options: SpawnOptions; result: SpawnResult | null; error: unknown }> = [];

  /** Set a canned outcome for spawns whose command matches `pattern`. */
  setOutcome(pattern: RegExp, outcome: FakeSpawnOutcome): this {
    this.rules.push({ pattern, outcome });
    return this;
  }

  /** Set a sequence of outcomes consumed in order (first-in-first-out). */
  setSequence(outcomes: FakeSpawnOutcome[]): this {
    this.sequence.push(...outcomes);
    return this;
  }

  /** Reset all rules/sequence/history. */
  reset(): void {
    this.rules.length = 0;
    this.sequence.length = 0;
    this._callCount = 0;
    this._calls.length = 0;
  }

  get callCount(): number {
    return this._callCount;
  }

  get calls(): ReadonlyArray<{ options: SpawnOptions; result: SpawnResult | null; error: unknown }> {
    return this._calls;
  }

  get lastOptions(): SpawnOptions | undefined {
    return this._calls[this._calls.length - 1]?.options;
  }

  async spawn(options: SpawnOptions): Promise<SpawnResult> {
    this._callCount++;

    // Sequence takes priority over rules.
    const raw: FakeSpawnOutcome =
      this.sequence.length > 0
        ? (this.sequence.shift() ?? DEFAULT_OUTCOME)
        : (this.rules.find((r) => r.pattern.test(options.command))?.outcome ?? DEFAULT_OUTCOME);

    const o: Required<FakeSpawnOutcome> = { ...DEFAULT_OUTCOME, ...raw };

    if (o.commandNotFound) {
      const err = new SpawnError('COMMAND_NOT_FOUND', `fake: command not found: ${options.command}`);
      this._calls.push({ options, result: null, error: err });
      throw err;
    }

    const result: SpawnResult = {
      exitCode: o.timedOut ? null : (o.exitCode ?? 0),
      stdout: o.stdout,
      stderr: o.stderr,
      timedOut: o.timedOut,
      killed: false,
      durationMs: o.durationMs,
    };
    this._calls.push({ options, result, error: null });
    return result;
  }
}
