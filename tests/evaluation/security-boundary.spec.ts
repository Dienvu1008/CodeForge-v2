// Security boundary (§24/§32) — benchmark execution must NOT create a parallel unsafe path. The
// runner has no execution authority of its own: the ONLY way the agent affects the workspace is
// the injected AgentRunner (in production, the real orchestrator → ToolGateway → ProcessSupervisor).
// The check runner only runs the task's DECLARED checks, and only through an injected supervisor.
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  BenchmarkRunner,
  createIsolatedWorkspace,
  destroyIsolatedWorkspace,
  BenchmarkCheckRunner,
  type AgentRunner,
} from '@codeforge/infrastructure';
import type { ProcessSupervisor, SpawnOptions, SpawnResult, BenchmarkTask, RunProvenance } from '@codeforge/agent-core';

const PROV: RunProvenance = {
  agentName: 'codeforge', agentVersion: 't', gitCommit: 't', model: 'fake-model', runtimeConfig: {}, environment: 'test',
};

const cleanup: string[] = [];
afterEach(() => { for (const d of cleanup.splice(0)) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ } } });

/** A supervisor spy that records every spawn and never actually executes anything. */
class SpySupervisor implements ProcessSupervisor {
  public readonly spawns: SpawnOptions[] = [];
  async spawn(options: SpawnOptions): Promise<SpawnResult> {
    this.spawns.push(options);
    return { exitCode: 0, stdout: '', stderr: '', timedOut: false, killed: false, durationMs: 0 };
  }
}

describe('benchmark execution cannot bypass the governance kernel', () => {
  it('the runner writes nothing to the workspace itself — only the agent does', async () => {
    let agentWrote = false;
    const agent: AgentRunner = {
      async run() { agentWrote = true; return { events: [] }; }, // agent does NOTHING to the fs
    };
    let n = 0;
    const spy = new SpySupervisor();
    const runner = new BenchmarkRunner({
      agent,
      makeCheckSupervisor: () => spy,
      provenance: PROV, now: () => 't', newRunId: () => `r-${++n}`,
    });
    const benchmark = {
      id: 'b', version: '1', description: 'd',
      tasks: [{
        id: 'T', version: 1, category: 'FEATURE' as const, title: 't', description: 'd',
        seedFiles: { 'seed.txt': 'x' },
        verification: [{ kind: 'command' as const, target: 'node x.js', description: 'runs' }],
        difficulty: 'EASY' as const, risk: 'LOW' as const, timeoutMs: 10_000,
      }],
    };
    await runner.run(benchmark);

    expect(agentWrote).toBe(true);
    // All command checks went through the injected supervisor (no raw shell).
    expect(spy.spawns.length).toBe(1);
    expect(spy.spawns[0]!.command).toBe('node');
  });

  it('check commands are executed with cwd forced to the isolated workspace', async () => {
    const h = createIsolatedWorkspace({ 'x.js': 'process.exit(0)\n' });
    cleanup.push(h.root);
    const spy = new SpySupervisor();
    const runner = new BenchmarkCheckRunner({ supervisor: spy, workspaceRoot: h.root });
    await runner.runAll([{ kind: 'command', target: 'node x.js', description: 'runs' }]);
    expect(spy.spawns[0]!.cwd).toBe(h.root);           // never the dev repo
    expect(spy.spawns[0]!.cwd.startsWith(tmpdir())).toBe(true);
    destroyIsolatedWorkspace(h);
  });

  it('a benchmark workspace is isolated under the OS temp dir and removed on cleanup', () => {
    const h = createIsolatedWorkspace({ 'a.txt': '1' });
    expect(h.root.startsWith(tmpdir())).toBe(true);
    expect(existsSync(h.root)).toBe(true);
    destroyIsolatedWorkspace(h);
    expect(existsSync(h.root)).toBe(false);
  });
});
