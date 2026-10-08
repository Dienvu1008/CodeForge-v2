// BenchmarkRunner — orchestrates one benchmark run (infrastructure). For each task it:
//   1. creates an isolated throwaway workspace and seeds it (never the dev repo — §12),
//   2. invokes the injected AgentRunner (the REAL CodeForge runtime, or FakeModel in CI),
//   3. runs the task's deterministic checks (the external success authority — §11),
//   4. evaluates the case (pure agent-core evaluator) with the trace + changed files,
//   5. cleans up the workspace.
// It then aggregates case results into an EvaluationResult. The runner itself owns NO execution
// authority: the agent runs through the SAME orchestrator/ToolGateway/ProcessSupervisor the
// product uses (the AgentRunner is a thin adapter over them), so there is no parallel unsafe path.
import type {
  Benchmark,
  BenchmarkTask,
  BenchmarkCaseResult,
  BenchmarkRun,
  EvaluationResult,
  RunProvenance,
} from '@codeforge/agent-core';
import type { DomainEvent } from '@codeforge/agent-core';
import { evaluateCase, aggregate, type CheckOutcome } from '@codeforge/agent-core';
import {
  createIsolatedWorkspace,
  destroyIsolatedWorkspace,
  changedFiles,
  type IsolatedWorkspaceHandle,
} from './isolated-workspace.js';
import { BenchmarkCheckRunner } from './check-runner.js';
import type { ProcessSupervisor } from '@codeforge/agent-core';

/**
 * What the runner needs from "the agent": given an isolated workspace + the task goal, run the
 * CodeForge runtime to completion (or timeout) and report the trace + any counters. The adapter
 * that implements this wires the REAL orchestrator against the isolated workspace. It must throw
 * or set `invalidReason` only for setup/crash problems — a task the agent simply failed to solve
 * is NOT an error here (that is decided by the checks).
 */
export interface AgentRunResult {
  /** The runtime trace for this case's session (EventLog.query results). */
  readonly events: readonly DomainEvent[];
  /** Set when the run could not complete (crash/setup) → case INVALID (not FAILURE). */
  readonly invalidReason?: string;
  readonly timedOut?: boolean;
  /** Optional direct counters when not derivable from events. */
  readonly counters?: { readonly toolCalls?: number; readonly modelTokens?: number; readonly retries?: number; readonly iterations?: number };
  /** The session id (used as the trace reference). */
  readonly traceRef?: string;
}

export interface AgentRunner {
  run(input: { workspaceRoot: string; task: BenchmarkTask }): Promise<AgentRunResult>;
}

export interface BenchmarkRunnerDeps {
  readonly agent: AgentRunner;
  /** Supervisor for running benchmark checks (e.g. WorkspaceProcessSupervisor bound per case). */
  readonly makeCheckSupervisor: (workspaceRoot: string) => ProcessSupervisor;
  readonly provenance: RunProvenance;
  readonly now: () => string;
  readonly newRunId: () => string;
}

export class BenchmarkRunner {
  constructor(private readonly deps: BenchmarkRunnerDeps) {}

  /** Run every task in the benchmark, returning both the raw run and the aggregated result. */
  async run(benchmark: Benchmark): Promise<{ run: BenchmarkRun; result: EvaluationResult }> {
    const runId = this.deps.newRunId();
    const startedAt = this.deps.now();
    const results: BenchmarkCaseResult[] = [];

    for (const task of benchmark.tasks) {
      results.push(await this.runCase(task));
    }

    const endedAt = this.deps.now();
    const run: BenchmarkRun = {
      runId, benchmarkId: benchmark.id, benchmarkVersion: benchmark.version,
      provenance: this.deps.provenance, startedAt, endedAt, results,
    };
    const result = aggregate(runId, benchmark.id, benchmark.version, this.deps.provenance, results, endedAt);
    return { run, result };
  }

  private async runCase(task: BenchmarkTask): Promise<BenchmarkCaseResult> {
    const startedAt = this.deps.now();
    const t0 = Date.now();
    let handle: IsolatedWorkspaceHandle | undefined;
    try {
      handle = createIsolatedWorkspace(task.seedFiles);

      // 2. Run the agent against the isolated workspace (real runtime via the adapter).
      let agentResult: AgentRunResult;
      try {
        agentResult = await this.deps.agent.run({ workspaceRoot: handle.root, task });
      } catch (e) {
        agentResult = { events: [], invalidReason: `agent run crashed: ${String(e)}` };
      }

      // 3. Deterministic checks decide success (external authority).
      const checkRunner = new BenchmarkCheckRunner({
        supervisor: this.deps.makeCheckSupervisor(handle.root),
        workspaceRoot: handle.root,
        defaultTimeoutMs: task.timeoutMs,
      });
      let checks: readonly CheckOutcome[] = [];
      // When the run was INVALID (setup/crash) we still record it; checks would be meaningless.
      if (agentResult.invalidReason === undefined) {
        checks = await checkRunner.runAll(task.verification);
      }

      const endedAt = this.deps.now();
      const durationMs = Date.now() - t0;
      return evaluateCase({
        task, checks,
        events: agentResult.events,
        filesChanged: changedFiles(handle),
        startedAt, endedAt, durationMs,
        ...(agentResult.invalidReason !== undefined ? { invalidReason: agentResult.invalidReason } : {}),
        ...(agentResult.timedOut !== undefined ? { timedOut: agentResult.timedOut } : {}),
        ...(agentResult.counters !== undefined ? { counters: agentResult.counters } : {}),
        ...(agentResult.traceRef !== undefined ? { traceRef: agentResult.traceRef } : {}),
      });
    } finally {
      if (handle !== undefined) destroyIsolatedWorkspace(handle);
    }
  }
}
