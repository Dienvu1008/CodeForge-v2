// BenchmarkCheckRunner — runs a BenchmarkTask's deterministic checks against the isolated
// workspace and returns CheckOutcome[]. This is the EXTERNAL, deterministic authority on
// success (master prompt §11): the agent never judges itself; these checks do.
//
// Command/build/no_regression checks run through a ProcessSupervisor (reusing the same safe
// spawn path verification uses — shell:false, minimal env, cwd=workspace). file_* checks read
// the filesystem directly. No parallel unsafe execution path is introduced.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BenchmarkCheck } from '@codeforge/agent-core';
import type { CheckOutcome } from '@codeforge/agent-core';
import type { ProcessSupervisor } from '@codeforge/agent-core';

export interface CheckRunnerDeps {
  /** Supervisor used to run command/build checks (e.g. WorkspaceProcessSupervisor). */
  readonly supervisor: ProcessSupervisor;
  readonly workspaceRoot: string;
  /** Default per-check timeout when the check does not specify one. */
  readonly defaultTimeoutMs?: number;
}

export class BenchmarkCheckRunner {
  constructor(private readonly deps: CheckRunnerDeps) {}

  async runAll(checks: readonly BenchmarkCheck[]): Promise<readonly CheckOutcome[]> {
    const outcomes: CheckOutcome[] = [];
    for (const check of checks) outcomes.push(await this.runOne(check));
    return outcomes;
  }

  private async runOne(check: BenchmarkCheck): Promise<CheckOutcome> {
    switch (check.kind) {
      case 'file_exists':   return this.fileExists(check, true);
      case 'file_absent':   return this.fileExists(check, false);
      case 'file_contains': return this.fileContains(check);
      case 'command':
      case 'build':
      case 'no_regression': return this.runCommand(check);
      default:              return { description: check.description, passed: false, detail: `unknown check kind` };
    }
  }

  private fileExists(check: BenchmarkCheck, shouldExist: boolean): CheckOutcome {
    const abs = join(this.deps.workspaceRoot, check.target);
    const exists = existsSync(abs);
    return {
      description: check.description,
      passed: exists === shouldExist,
      detail: `${check.target} ${exists ? 'exists' : 'absent'} (expected ${shouldExist ? 'exists' : 'absent'})`,
    };
  }

  private fileContains(check: BenchmarkCheck): CheckOutcome {
    const abs = join(this.deps.workspaceRoot, check.target);
    if (!existsSync(abs)) return { description: check.description, passed: false, detail: `${check.target} not found` };
    let content: string;
    try { content = readFileSync(abs, 'utf8'); }
    catch (e) { return { description: check.description, passed: false, detail: `read failed: ${String(e)}` }; }
    const needle = check.expect ?? '';
    const passed = check.isRegex === true ? new RegExp(needle).test(content) : content.includes(needle);
    return { description: check.description, passed, detail: passed ? 'matched' : `did not match: ${needle}` };
  }

  private async runCommand(check: BenchmarkCheck): Promise<CheckOutcome> {
    // target is the command; args optional. Split a bare "a b c" target if no args given.
    const parts = check.args !== undefined ? [check.target, ...check.args] : check.target.split(/\s+/);
    const command = parts[0]!;
    const args = parts.slice(1);
    try {
      const result = await this.deps.supervisor.spawn({
        command, args, cwd: this.deps.workspaceRoot, env: {},
        timeoutMs: check.timeoutMs ?? this.deps.defaultTimeoutMs ?? 60_000,
      });
      const passed = result.exitCode === 0 && !result.timedOut;
      const detail = result.timedOut
        ? 'timed out'
        : `exit ${result.exitCode}${result.stderr ? ': ' + result.stderr.slice(0, 200) : ''}`;
      return { description: check.description, passed, detail };
    } catch (e) {
      return { description: check.description, passed: false, detail: `spawn failed: ${String(e)}` };
    }
  }
}
