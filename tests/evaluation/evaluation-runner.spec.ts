// Evaluation runner (infrastructure I/O) — isolated workspace, deterministic check running
// against real `node`, baseline persistence, dataset loading of the real seed benchmark, and the
// end-to-end BenchmarkRunner with a scripted AgentRunner. Uses real temp dirs; cleans up.
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createIsolatedWorkspace,
  destroyIsolatedWorkspace,
  changedFiles,
  BenchmarkCheckRunner,
  BenchmarkRunner,
  BaselineStore,
  loadBenchmarkFile,
  WorkspaceProcessSupervisor,
  type AgentRunner,
} from '@codeforge/infrastructure';
import type { BenchmarkTask, RunProvenance } from '@codeforge/agent-core';

const BENCHMARK_PATH = join(__dirname, '..', '..', 'benchmarks', 'codeforge-native', 'benchmark.json');

const PROV: RunProvenance = {
  agentName: 'codeforge', agentVersion: '0.12.0', gitCommit: 'test', model: 'fake-model',
  runtimeConfig: {}, environment: process.platform,
};

const cleanupDirs: string[] = [];
afterEach(() => { for (const d of cleanupDirs.splice(0)) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ } } });

describe('isolated workspace', () => {
  it('materializes seed files, detects changes, and never touches the dev repo', () => {
    const h = createIsolatedWorkspace({ 'src/a.js': 'console.log(1)\n', 'README.md': 'hi' });
    cleanupDirs.push(h.root);
    expect(h.root.startsWith(tmpdir())).toBe(true);  // isolated under the OS temp dir
    expect(existsSync(join(h.root, 'src/a.js'))).toBe(true);

    // No change yet.
    expect(changedFiles(h)).toEqual([]);
    // Modify + add → both detected.
    writeFileSync(join(h.root, 'src/a.js'), 'console.log(2)\n');
    writeFileSync(join(h.root, 'new.js'), 'x');
    expect([...changedFiles(h)].sort()).toEqual(['new.js', 'src/a.js']);

    destroyIsolatedWorkspace(h);
    expect(existsSync(h.root)).toBe(false);
  });
});

describe('check runner (deterministic, external authority)', () => {
  it('passes file_exists/file_contains and a node command; fails a bad command', async () => {
    const h = createIsolatedWorkspace({
      'ok.js': 'process.exit(0)\n',
      'bad.js': 'process.exit(1)\n',
      'note.txt': 'hello world',
    });
    cleanupDirs.push(h.root);
    const runner = new BenchmarkCheckRunner({
      supervisor: new WorkspaceProcessSupervisor({ workspaceRoot: h.root }),
      workspaceRoot: h.root, defaultTimeoutMs: 30_000,
    });
    const outcomes = await runner.runAll([
      { kind: 'file_exists', target: 'ok.js', description: 'ok.js exists' },
      { kind: 'file_absent', target: 'missing.js', description: 'missing absent' },
      { kind: 'file_contains', target: 'note.txt', expect: 'world', description: 'note contains world' },
      { kind: 'command', target: 'node ok.js', description: 'ok command' },
      { kind: 'command', target: 'node bad.js', description: 'bad command' },
    ]);
    expect(outcomes.map((o) => o.passed)).toEqual([true, true, true, true, false]);
  });
});

describe('dataset loader', () => {
  it('loads + validates the real CF-001..010 seed benchmark', () => {
    const b = loadBenchmarkFile(BENCHMARK_PATH);
    expect(b.id).toBe('codeforge-native');
    expect(b.tasks.length).toBe(10);
    expect(b.tasks.map((t) => t.id)).toContain('CF-001');
    // Every task has at least one deterministic check (the success authority).
    expect(b.tasks.every((t) => t.verification.length > 0)).toBe(true);
  });
});

describe('baseline store', () => {
  it('records and reloads a baseline, and saves a run', () => {
    const dir = join(tmpdir(), `cf-baseline-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    cleanupDirs.push(dir);
    let n = 0;
    const store = new BaselineStore({ dir, now: () => 't', newId: () => `id-${++n}` });
    const result = {
      runId: 'r1', benchmarkId: 'b', benchmarkVersion: '1', provenance: PROV,
      total: 2, success: 1, failure: 1, invalid: 0, successRate: 0.5,
      metricAverages: { tool_calls: 3 }, failureBreakdown: { IMPLEMENTATION_FAILURE: 1 },
      governanceViolations: 0, createdAt: 't',
    };
    const baseline = store.recordBaseline('demo', result);
    expect(baseline.label).toBe('demo');
    const reloaded = store.loadBaseline('demo');
    expect(reloaded?.result.successRate).toBe(0.5);
    expect(store.listBaselines()).toContain('demo');
  });
});

describe('BenchmarkRunner end-to-end with a scripted agent (real checks)', () => {
  // A scripted AgentRunner that writes the fix a task needs into the isolated workspace. This
  // stands in for the real runtime for a deterministic infra test; the REAL-runtime E2E is a
  // separate test. The checks (node) are REAL and decide the verdict.
  function scriptedAgent(apply: (root: string, task: BenchmarkTask) => void): AgentRunner {
    return {
      async run({ workspaceRoot, task }) {
        apply(workspaceRoot, task);
        return { events: [], traceRef: 'trace-1' };
      },
    };
  }

  it('reports SUCCESS when the agent produces a passing solution, FAILURE when it does not', async () => {
    let n = 0;
    const benchmark = {
      id: 'mini', version: '1', description: 'd',
      tasks: [
        {
          id: 'PASS-1', version: 1, category: 'FEATURE' as const, title: 't',
          description: 'create answer.js printing 42',
          seedFiles: {}, verification: [{ kind: 'command' as const, target: 'node answer.js', description: 'runs' }],
          difficulty: 'EASY' as const, risk: 'LOW' as const, timeoutMs: 30_000,
        },
        {
          id: 'FAIL-1', version: 1, category: 'FEATURE' as const, title: 't',
          description: 'create answer.js (agent will not)',
          seedFiles: {}, verification: [{ kind: 'command' as const, target: 'node answer.js', description: 'runs' }],
          difficulty: 'EASY' as const, risk: 'LOW' as const, timeoutMs: 30_000,
        },
      ],
    };
    const agent = scriptedAgent((root, task) => {
      if (task.id === 'PASS-1') writeFileSync(join(root, 'answer.js'), 'console.log(42)\n');
      // FAIL-1: write nothing → node answer.js fails → FAILURE.
    });
    const runner = new BenchmarkRunner({
      agent,
      makeCheckSupervisor: (root) => new WorkspaceProcessSupervisor({ workspaceRoot: root }),
      provenance: PROV, now: () => 't', newRunId: () => `run-${++n}`,
    });

    const { result } = await runner.run(benchmark);
    expect(result.total).toBe(2);
    expect(result.success).toBe(1);
    expect(result.failure).toBe(1);
    expect(result.successRate).toBe(0.5);
  });
});
