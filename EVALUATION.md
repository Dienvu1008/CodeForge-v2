# CodeForge Evaluation System

> The mechanism that lets CodeForge answer *"did this change actually make the agent better?"*
> with evidence, not vibes. It measures the **Task Correctness** axis (`EVALUATION_MODEL.md`),
> complementing the invariant-tested **Runtime Integrity** axis.
>
> Last updated: 2026-09-14.

## Design principles

1. **The agent is never the authority on its own success** (master prompt §11). A case's verdict
   comes from deterministic checks (run a command, check a file), not from the model saying "done".
2. **No parallel unsafe path** (§12/§24). Benchmark cases run through the SAME governed runtime
   (SessionOrchestrator → ToolGateway → ProcessSupervisor → VerificationEngine) the product uses.
   The runner owns isolation + checks + scoring; it holds no execution authority.
3. **Isolation** (§12). Every case runs in a throwaway temp directory under the OS temp dir; the
   developer's workspace is never touched; cleanup removes it.
4. **Behavior, not patches** (§8). A `BenchmarkTask` says what to achieve and how to verify it —
   never a required diff. Many correct implementations can pass.
5. **Pure core, I/O at the edge** (DC-002). All decision logic (loading, metrics, verdict,
   failure classification, aggregation, regression) is pure in `agent-core`; filesystem, process
   execution, and persistence live in `infrastructure`. `depcruise` confirms `agent-core ↛ infrastructure`.
6. **Extensible, not grand** (§25). A handful of small deterministic modules + an injected
   `AgentRunner` seam. No framework, no cluster, no orchestration layer.

## Architecture

```
agent-core/src/evaluation/        (pure)
    benchmark-loader.ts   validate untrusted task/benchmark objects → typed values
    metrics.ts            CaseEvidence → Metric[] (correctness/efficiency/scope/recovery/governance/routing/planning)
    evaluator.ts          evaluateCase → verdict (SUCCESS/FAILURE/INVALID) + failure class; aggregate → EvaluationResult
    regression.ts         compareToBaseline → RegressionReport (incl. cost regression); renderReport

agent-core/src/domain/evaluation.ts   pure types (Benchmark, BenchmarkTask, Metric, BenchmarkRun, EvaluationResult, Baseline, …)

infrastructure/src/evaluation/    (I/O)
    isolated-workspace.ts  temp-dir isolation + seed + changed-file diff + cleanup
    check-runner.ts        run a task's deterministic checks (fs + ProcessSupervisor) — the success authority
    benchmark-runner.ts    per-case: isolate → AgentRunner → checks → evaluateCase → cleanup; aggregate
    baseline-store.ts      JSON persistence for runs + baselines
    dataset-loader.ts      read a benchmark JSON file + validate

benchmarks/codeforge-native/benchmark.json   the CF-001..010 seed dataset
```

### The `AgentRunner` seam

The runner does not know how to run the agent — it depends on an injected `AgentRunner`:

```ts
interface AgentRunner {
  run(input: { workspaceRoot: string; task: BenchmarkTask }): Promise<AgentRunResult>;
}
```

In production this adapter wires the real `SessionOrchestrator` against the isolated workspace
(see `tests/evaluation/real-runtime-e2e.spec.ts`). In CI it can be a scripted/FakeModel runtime.
Either way the checks — not the agent — decide the verdict, so the measurement is honest.

## Three levels of evaluation (§10)

- **Level 1 — component.** Accuracy of a single deterministic subsystem over labeled fixtures
  (`tests/evaluation/component-eval-level1.spec.ts`: mission classifier + complexity analyzer).
- **Level 2 — native task benchmark.** The CF-001..010 seed suite run end-to-end through the kernel.
- **Level 3 — external benchmarks.** Adapter shape designed; SWE-bench / TerminalBench / etc. are
  deferred, not blocking.

## Metrics (§15, open set)

Grouped as correctness / efficiency / scope / planning / context / recovery / governance / routing.
A metric is `{ name, group, value, unit }`; add a producer in `metrics.ts` without touching the
runner. Current producers include `all_checks_passed`, `runtime_ms`, `tool_calls`, `task_runs`,
`files_changed`, `scope_violation`, `failures_detected`, `recovery_actions`,
`policy_denied_tool_calls`, `mission_model_selected`, `architecture_gate_blocked`.

## Failure classification (§18)

A failed case is attributed to one of: MISSION_UNDERSTANDING / MODEL_SELECTION / CONTEXT /
PLANNING / TOOL / IMPLEMENTATION / VERIFICATION / RECOVERY / ENVIRONMENT / TIMEOUT /
RESOURCE_EXHAUSTION / GOVERNANCE_VIOLATION. Attribution walks the runtime trace (a denied tool
call ⇒ GOVERNANCE_VIOLATION; no committed plan ⇒ PLANNING_FAILURE; verification ran but checks red
⇒ VERIFICATION_FAILURE; etc.). This tells the roadmap *what to fix*, by evidence.

## Baselines & regression (§16, §30)

`BaselineStore` records an `EvaluationResult` under a label. `compareToBaseline` classifies the
delta: a success-rate drop is a REGRESSION; a success-rate rise is an IMPROVEMENT; **equal success
but materially higher cost** (runtime/tokens/tool-calls up >25%) is ALSO a REGRESSION; accuracy up
with cost up is MIXED. This guards against the "more accurate but far more expensive" trap.

## First baseline (recorded)

| Field | Value |
|---|---|
| Label | `codeforge-0.12-fakemodel` |
| Benchmark | `codeforge-native` v0.1.0 (CF-001..010) |
| Agent / model | codeforge 0.12.0 · FakeModel (deterministic) |
| Success | 3 / 10 (CF-002, CF-004, CF-007) |
| Largest failure class | VERIFICATION_FAILURE (7/7) |

**Honest reading:** this is a *harness* baseline. The FakeModel was scripted to solve only 3 tasks
through the governed tool path; the other 7 claimed done without a real fix and the deterministic
checks caught every one. It proves the full loop (isolation → governed execution → external
verification → verdict → metrics → baseline), not the agent's real competence. A real Ollama run
replaces 3/10 with a genuine task-correctness number — the harness is ready for it.

## How to run

- Component + unit + runner + security tests: `vitest run tests/evaluation`.
- Real-kernel E2E + baseline: `vitest run tests/evaluation/real-runtime-e2e.spec.ts`.
- A real-model run (future): provide an `AgentRunner` backed by the CLI runtime with a live Ollama
  model, point it at `benchmarks/codeforge-native/benchmark.json`, and record the baseline under a
  model-specific label to compare against `codeforge-0.12-fakemodel`.

## Future (data for self-improvement — §31)

The evaluation outputs (per-case failure classes + metrics + trace refs) are shaped to eventually
feed the existing learning plane: benchmark → failure analysis → self-model → improvement proposal
→ new version → benchmark → accept/reject. Only the data + interfaces exist now; no autonomous
self-modification.
