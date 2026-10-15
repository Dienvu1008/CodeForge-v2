// SweBenchAgentRunner — threads prepareBaseline -> runOrchestrator -> applyTestPatch, and maps
// setup failures to INVALID (not FAILURE). Uses a FakeProcessSupervisor-backed workspace setup and
// a scripted runOrchestrator so no real git/network is needed.
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  SweBenchWorkspaceSetup,
  SweBenchAgentRunner,
  type SweBenchOrchestratorRun,
} from '@codeforge/infrastructure';
import type { BenchmarkTask, DomainEvent, SweBenchTaskWithSetup } from '@codeforge/agent-core';
import { FakeProcessSupervisor } from '@codeforge/testing';

const cleanup: string[] = [];
afterEach(() => { for (const d of cleanup.splice(0)) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ } } });

function tmp(): string { const d = mkdtempSync(join(tmpdir(), 'cf-swe-run-')); cleanup.push(d); return d; }

const TASK: BenchmarkTask = {
  id: 'a__b-1', version: 1, category: 'BUGFIX', title: 't', description: 'fix the bug',
  seedFiles: {}, verification: [{ kind: 'command', target: 'pytest -q t::f', description: 'tests pass' }],
  difficulty: 'HARD', risk: 'MEDIUM', timeoutMs: 1000,
};
const BUNDLE: SweBenchTaskWithSetup = {
  task: TASK,
  setup: {
    instanceId: 'a__b-1', repo: 'a/b', baseCommit: 'c0',
    testPatch: 'diff --git a/t b/t\n@@ -1 +1 @@\n-x\n+y\n', failToPass: ['t::f'], passToPass: [],
  },
};

const EVENTS: readonly DomainEvent[] = [];
function okOrchestrator(): SweBenchOrchestratorRun { return { events: EVENTS, traceRef: 'S-1' }; }

describe('SweBenchAgentRunner', () => {
  it('runs clone -> checkout -> orchestrator -> apply-patch in order, returning the trace', async () => {
    const sup = new FakeProcessSupervisor();
    // clone, checkout, (orchestrator does no git), apply.
    sup.setSequence([
      { exitCode: 0, stdout: '', stderr: '' }, // clone
      { exitCode: 0, stdout: '', stderr: '' }, // checkout
      { exitCode: 0, stdout: '', stderr: '' }, // git apply
    ]);
    const workspaceSetup = new SweBenchWorkspaceSetup({ supervisor: sup });

    const calls: string[] = [];
    const runner = new SweBenchAgentRunner({
      bundles: [BUNDLE],
      workspaceSetup,
      runOrchestrator: async ({ task, setup }) => {
        calls.push(`orch:${task.id}:${setup.repo}`);
        // At this point clone+checkout already ran (2 git calls) but apply has NOT.
        expect(sup.callCount).toBe(2);
        return okOrchestrator();
      },
    });

    const result = await runner.run({ workspaceRoot: tmp(), task: TASK });
    expect(result.invalidReason).toBeUndefined();
    expect(result.traceRef).toBe('S-1');
    expect(calls).toEqual(['orch:a__b-1:a/b']);
    expect(sup.callCount).toBe(3); // clone + checkout + apply (apply ran AFTER the orchestrator)
  });

  it('a clone failure yields INVALID and never runs the orchestrator', async () => {
    const sup = new FakeProcessSupervisor();
    sup.setSequence([{ exitCode: 128, stdout: '', stderr: 'repo not found' }]);
    let orchestratorRan = false;
    const runner = new SweBenchAgentRunner({
      bundles: [BUNDLE],
      workspaceSetup: new SweBenchWorkspaceSetup({ supervisor: sup }),
      runOrchestrator: async () => { orchestratorRan = true; return okOrchestrator(); },
    });
    const result = await runner.run({ workspaceRoot: tmp(), task: TASK });
    expect(result.invalidReason).toContain('baseline setup failed (clone)');
    expect(orchestratorRan).toBe(false);
  });

  it('a failed test_patch apply yields INVALID but keeps the trace from the run', async () => {
    const sup = new FakeProcessSupervisor();
    sup.setSequence([
      { exitCode: 0, stdout: '', stderr: '' },               // clone
      { exitCode: 0, stdout: '', stderr: '' },               // checkout
      { exitCode: 1, stdout: '', stderr: 'patch does not apply' }, // apply fails
    ]);
    const runner = new SweBenchAgentRunner({
      bundles: [BUNDLE],
      workspaceSetup: new SweBenchWorkspaceSetup({ supervisor: sup }),
      runOrchestrator: async () => ({ events: EVENTS, traceRef: 'S-9' }),
    });
    const result = await runner.run({ workspaceRoot: tmp(), task: TASK });
    expect(result.invalidReason).toContain('applying test_patch failed');
    expect(result.traceRef).toBe('S-9'); // the run still happened; its trace is preserved
  });

  it('an orchestrator crash yields INVALID (not a thrown error)', async () => {
    const sup = new FakeProcessSupervisor();
    sup.setSequence([{ exitCode: 0, stdout: '', stderr: '' }, { exitCode: 0, stdout: '', stderr: '' }]);
    const runner = new SweBenchAgentRunner({
      bundles: [BUNDLE],
      workspaceSetup: new SweBenchWorkspaceSetup({ supervisor: sup }),
      runOrchestrator: async () => { throw new Error('boom'); },
    });
    const result = await runner.run({ workspaceRoot: tmp(), task: TASK });
    expect(result.invalidReason).toContain('orchestrator crashed');
  });

  it('an unknown task id (no setup) yields INVALID', async () => {
    const sup = new FakeProcessSupervisor();
    const runner = new SweBenchAgentRunner({
      bundles: [BUNDLE],
      workspaceSetup: new SweBenchWorkspaceSetup({ supervisor: sup }),
      runOrchestrator: async () => okOrchestrator(),
    });
    const result = await runner.run({ workspaceRoot: tmp(), task: { ...TASK, id: 'unknown' } });
    expect(result.invalidReason).toContain('no SWE-bench setup');
    expect(sup.callCount).toBe(0);
  });

  it('propagates counters + timedOut from the orchestrator run', async () => {
    const sup = new FakeProcessSupervisor();
    sup.setSequence([{ exitCode: 0, stdout: '', stderr: '' }, { exitCode: 0, stdout: '', stderr: '' }, { exitCode: 0, stdout: '', stderr: '' }]);
    const runner = new SweBenchAgentRunner({
      bundles: [BUNDLE],
      workspaceSetup: new SweBenchWorkspaceSetup({ supervisor: sup }),
      runOrchestrator: async () => ({ events: EVENTS, traceRef: 'S-2', timedOut: true, counters: { toolCalls: 5, iterations: 3 } }),
    });
    const result = await runner.run({ workspaceRoot: tmp(), task: TASK });
    expect(result.timedOut).toBe(true);
    expect(result.counters?.toolCalls).toBe(5);
  });
});
