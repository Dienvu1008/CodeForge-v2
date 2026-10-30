/*
 * Copyright 2026 DienVu (Dienvu1008)
 * SPDX-License-Identifier: Apache-2.0
 */

// SweBenchAgentRunner (infrastructure) — the AgentRunner the BenchmarkRunner invokes for a
// SWE-bench case. It threads the SWE-bench harness phases around the real CodeForge runtime, all
// INSIDE the single AgentRunner.run() call so the BenchmarkRunner's existing order holds:
//
//   BenchmarkRunner.runCase:
//     1. createIsolatedWorkspace(task.seedFiles)   // empty for SWE-bench
//     2. agent.run(...)  ← THIS CLASS:
//          a. prepareBaseline  — clone repo + checkout base_commit into the workspace
//          b. runOrchestrator  — drive the real runtime with the issue text as the goal
//          c. applyTestPatch   — apply the harness test_patch on top of the agent's edits
//     3. checkRunner.runAll(task.verification)      // runs the FAIL_TO_PASS/PASS_TO_PASS tests
//     4. evaluateCase(...)
//
// Setup phases that fail (clone/checkout/apply) return `invalidReason` → the case is INVALID (a
// harness problem), NOT a FAILURE (which is reserved for "the agent's fix did not pass the tests").
// Applying the test_patch is deliberately done AFTER the agent run so the agent never sees the
// judging tests before it is evaluated (evaluation integrity).
import type { BenchmarkTask, DomainEvent } from '@codeforge/agent-core';
import type { SweBenchSetup, SweBenchTaskWithSetup } from '@codeforge/agent-core';
import type { AgentRunner, AgentRunResult } from './benchmark-runner.js';
import type { SweBenchWorkspaceSetup } from './swe-bench-workspace-setup.js';

/** What the runner needs the caller to do: drive the REAL runtime for one prepared workspace. */
export interface SweBenchOrchestratorRun {
  readonly events: readonly DomainEvent[];
  readonly traceRef?: string;
  readonly timedOut?: boolean;
  readonly counters?: AgentRunResult['counters'];
}

export interface SweBenchAgentRunnerDeps {
  /** The task+setup bundles for this run (used to look up a task's SweBenchSetup by task id). */
  readonly bundles: readonly SweBenchTaskWithSetup[];
  /** Clones/checks-out the repo and applies the test patch (git-based, injected supervisor). */
  readonly workspaceSetup: SweBenchWorkspaceSetup;
  /**
   * Drive the real CodeForge runtime against the prepared workspace, with the task's
   * problem_statement as the goal. The caller wires the orchestrator exactly as the product does;
   * this keeps the SWE-bench runner free of the whole runtime dependency graph.
   */
  readonly runOrchestrator: (input: { workspaceRoot: string; task: BenchmarkTask; setup: SweBenchSetup }) => Promise<SweBenchOrchestratorRun>;
}

export class SweBenchAgentRunner implements AgentRunner {
  private readonly setupById: Map<string, SweBenchSetup>;

  constructor(private readonly deps: SweBenchAgentRunnerDeps) {
    this.setupById = new Map(deps.bundles.map((b) => [b.task.id, b.setup]));
  }

  async run(input: { workspaceRoot: string; task: BenchmarkTask }): Promise<AgentRunResult> {
    const setup = this.setupById.get(input.task.id);
    if (setup === undefined) {
      return { events: [], invalidReason: `no SWE-bench setup for task ${input.task.id}` };
    }
    const root = input.workspaceRoot;

    // (a) Materialise the repo at base_commit BEFORE the agent runs.
    const baseline = await this.deps.workspaceSetup.prepareBaseline(root, setup);
    if (!baseline.ok) {
      return { events: [], invalidReason: `baseline setup failed (${baseline.failedStep}): ${baseline.detail ?? ''}` };
    }

    // (b) Drive the real runtime with the issue text as the goal.
    let run: SweBenchOrchestratorRun;
    try {
      run = await this.deps.runOrchestrator({ workspaceRoot: root, task: input.task, setup });
    } catch (e) {
      return { events: [], invalidReason: `orchestrator crashed: ${String(e)}` };
    }

    // (c) Apply the harness test_patch on the agent's edits, AFTER the run — never before.
    const applied = await this.deps.workspaceSetup.applyTestPatch(root, setup);
    if (!applied.ok) {
      return {
        events: run.events,
        invalidReason: `applying test_patch failed (${applied.failedStep}): ${applied.detail ?? ''}`,
        ...(run.traceRef !== undefined ? { traceRef: run.traceRef } : {}),
      };
    }

    return {
      events: run.events,
      ...(run.traceRef !== undefined ? { traceRef: run.traceRef } : {}),
      ...(run.timedOut !== undefined ? { timedOut: run.timedOut } : {}),
      ...(run.counters !== undefined ? { counters: run.counters } : {}),
    };
  }
}
