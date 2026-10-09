# CodeForge v2 — Project Status Matrix

> **Authoritative, living status of the product — not of any single phase.**
> A phase passing its tests does NOT mean CodeForge is complete. This file records what the
> software *actually does today*, verified against the source tree, not against phase labels.
>
> Last updated: 2026-09-15 · post-eval runtime/UX hardening cycle · 1569 tests / 174 files green (Win + WSL).
> Companion: `ROADMAP.md` (what's next) · per-phase detail in `PHASE_*_ROADMAP.md` / `PHASE_*_SIGNOFF.md`.

## What CodeForge is

An autonomous software-engineering **runtime** (not a chatbot with tools). A user goal flows
through understanding → planning → a task graph → tool-governed execution → verification →
recovery, with full observability. Central law, preserved everywhere:

> **LLM proposes. The deterministic runtime decides and enforces.**

Correctness is measured on two independent axes (`EVALUATION_MODEL.md`):
- **Runtime Integrity** — state/graph/tool/approval/budget/verification invariants (the kernel).
- **Task Correctness** — does the agent actually solve the user's problem (the intelligence).

The kernel's integrity is mature and invariant-tested. Task correctness has **never been measured
end-to-end** — which is exactly why the Evaluation/Benchmark system (in progress) is the right
next investment.

---

## Status legend

`DONE` · `PARTIAL` · `IMPLEMENTED_BUT_NOT_WIRED` · `TEST_ONLY` · `EXPERIMENTAL` · `PLANNED` · `BLOCKED` · `DEFERRED`

---

## Status matrix

### Core runtime (kernel — Phases 0–5)

| Capability | Status | Evidence / note |
|---|---|---|
| Task / TaskRun / TaskExecution models | DONE | `domain/`, invariant-tested (TI-*, EX-*). |
| TaskGraph + mutations + canonical hash | DONE | `graph/`, GI-* invariants; Blake3 hasher. |
| Deterministic state machines (session/task/tool-call) | DONE | `state-machine/`, `session-machine.ts`, `task-machine.ts`; SS-*/SM-*. |
| SQLite single-source-of-truth + migrations | DONE | `infrastructure/sqlite/`, append-only EventLog, CP-008. |
| ToolGateway + policy + approval | DONE | `tool/`, autonomy levels, TG-*; human-in-loop coordinator. |
| Verification engine + CompletionGate | DONE | `verification/`, TI-005; checks via ProcessSupervisor. |
| ArtifactStore (verification artifacts) | PARTIAL | In-memory stub; disk store never built (comment in `verification-engine.ts`). |
| Recovery: RETRY / FIX / ESCALATE / ABORT | DONE | `recovery/`, RC-*; outcomes finalized truthfully (P11.6+). |
| Recovery: REPLAN / ROLLBACK | DEFERRED | `recovery-engine.ts` returns PENDING / throws `*_NOT_IMPLEMENTED` ("Phase 5.5"). 2 of 8 actions are stubs. |
| Scheduler (deterministic, budget-aware) | DONE | `scheduler/`, SC-*; parallel admission with defer reasons. |
| Budget engine | DONE | `budget/`, BU-*. |
| Checkpoint + crash recovery | DONE | `checkpoint/`, `recovery/` (crash), CP-*. |

### Mission Intelligence (Phase 12 — advisory layer)

| Capability | Status | Evidence / note |
|---|---|---|
| Mission intake + type classification | DONE | `mission/mission-intake.ts`, deterministic taxonomy, MI-005. |
| Complexity / risk estimation | DONE | `mission/complexity-analyzer.ts`, `risk-analyzer.ts`, multi-dimensional. |
| Capability discovery + VERIFIED via ProcessSupervisor | DONE | `mission/capability*.ts` + `infrastructure/.../node-capability-prober.ts`, MI-003; real `--version` probes. |
| Capability model (dependency graph) | PARTIAL | Flat `enables[]` boolean list; NOT a real dependency graph (e.g. `build_android` → android-sdk + flutter). |
| Model requirement analysis + routing | PARTIAL | `model-router.ts` picks a registered id + emits `MISSION_MODEL_SELECTED`; **runtime still executes the single configured gateway — no live model swap** (MI-006 selection only). |
| Planning-mode router | IMPLEMENTED_BUT_NOT_WIRED | `planning-router.ts` computes a mode into the Mission; the Planner does not consume it. |
| Expert profiles | IMPLEMENTED_BUT_NOT_WIRED | `expert-profile.ts` selected/rendered into the outcome; not injected into the Planner/executor prompt. |
| Mission Architect (LLM blueprint) | DONE (advisory) | `mission-architect.ts`; validated via structured-output pipeline. |
| Architecture Gate (deterministic) | DONE | `architecture-gate.ts`, MI-007; BLOCK → AWAITING_HUMAN (the one real control-flow effect). |
| Context strategy (scope selection) | IMPLEMENTED_BUT_NOT_WIRED | `mission-context-strategy.ts` computed into the outcome; **never fed to the ContextBuilder/retriever**. |
| MissionIntelligence stage wired into orchestrator | PARTIAL | `--mission on` runs it between RUNNING and planning; emits `MISSION_*` events. **The orchestrator reads only `proceed`** — the Mission/routing/context/architecture are observable but otherwise discarded. |
| Uncertainty assessment (goal ambiguity) | PARTIAL | Tier A done: `assessUncertainty` (deterministic) scores goal ambiguity from objective signals (missing acceptance, short/vague wording, no I/O) → KNOWN/INFERRED/UNKNOWN + concrete `openQuestions`; wired into the Mission + `MISSION_UNCERTAINTY_ASSESSED` event. **Advisory only** — it does not yet stop to ask the user (Tier B/C: LLM question generation + clarification loop + UI, not built). |

> **The honest one-line summary of Phase 12 today:** the intelligence layer *analyzes and
> observes* (events + a gate that can halt for a human), but it does **not yet steer** the
> planner, the context, or the model used at execution time. The analysis is real; the influence
> is (deliberately, for now) limited to the Architecture Gate.

### Model system

| Capability | Status | Evidence / note |
|---|---|---|
| ModelGateway contract + Ollama adapter | DONE | `model/gateway.ts`, `infrastructure/model/`. |
| Model registry (capability metadata) | PARTIAL | `ModelRegistry` is an **injected list** (one model from CLI); no `/api/tags` discovery. |
| Model requirement analysis + routing selection | DONE | `analyzeModelRequirement` + `routeModel`, MI-006. |
| Runtime model switching (execute with routed model) | PLANNED | Runtime executes the single configured gateway; routing is advisory. |
| Model health / performance history | PLANNED | None. |

### Context system

| Capability | Status | Evidence / note |
|---|---|---|
| Repository analysis (symbols, import graph) | DONE | `infrastructure/code-intelligence/` (Tree-sitter / LSP), consumed by `ContextCollector`. |
| ContextBuilder + token budget + trust marking | DONE | `context/`, CX-*. |
| Changed-paths / retrieval | DONE | `context-runtime/`. |
| Mission → Context strategy integration | IMPLEMENTED_BUT_NOT_WIRED | Strategy exists but is not applied (see Mission Intelligence). |

### Planning & execution

| Capability | Status | Evidence / note |
|---|---|---|
| Planner + PlanValidator + PlanCritic | DONE | `planning/`, MG-*/GI-009; advisory critic refinement round. |
| Task decomposition + dependency ordering | DONE | Planner emits GraphMutation; scheduler orders. |
| Architecture-first / roadmap-driven planning | PARTIAL | Mission computes an architecture + mode but the Planner does not consume them. |
| Replanning | DEFERRED | REPLAN recovery action is a Phase-5.5 stub. |
| Autonomous ReAct execution loop | DONE | `execution/task-executor.ts`; tool calls, verify, retry, in-loop approval, progress events. |

### Product surface

| Capability | Status | Evidence / note |
|---|---|---|
| Observability dashboard (HTTP + SSE) | PARTIAL | Real single-page view (`observability-server/dashboard-assets.ts`), read projection + POST /control. Minimal UI. |
| Runtime controls (pause/resume/stop/approve) | DONE | ControlPlane + admitted control path (OB-006); exercised by dashboard/VS Code/Telegram. |
| VS Code extension | PARTIAL | Thin HTTP client (`vscode-extension/`), connect + dashboard webview + control commands. `.vsix` built but uncommitted. |
| Mission submission / goal queue | DONE | `POST /goal` → `GoalIngressService` FIFO; worker routes through Planner → GraphCommit (GI-009). |
| Task-graph visualization | PLANNED | Dashboard shows task list/states, not a graph view. |
| Telegram integration (remote approve/control) | PARTIAL | `infrastructure/telegram/` transport + command-router + client present; not exercised end-to-end here. |

### Learning (Phase 11)

| Capability | Status | Evidence / note |
|---|---|---|
| SelfModelBuilder (read-only projection) | DONE | `learning/`, LE-004/008. |
| LearningStore + LessonWriter | DONE | `infrastructure/learning/`, append-only, bounded. |
| AdviceGate + RecoveryAdvisor + rerankers | DONE | Advisory, clamped; `--learning on`; flag-off parity (LE-002). |

### Evaluation / benchmark

| Capability | Status | Evidence / note |
|---|---|---|
| Benchmark domain model | DONE | `agent-core/domain/evaluation.ts`. |
| Benchmark loader + validator | DONE | `agent-core/evaluation/benchmark-loader.ts`. |
| Isolated benchmark runner | DONE | `infrastructure/evaluation/` — temp-dir isolation, real runtime via injected `AgentRunner`, no parallel unsafe path. |
| Deterministic evaluator + metrics + trace integration | DONE | `agent-core/evaluation/{evaluator,metrics}.ts`; agent is NOT the authority; failure classification from the trace. |
| Native seed dataset (CF-001..010) | DONE | `benchmarks/codeforge-native/benchmark.json`, 10 tasks across 10 categories. |
| Level-1 component eval | DONE | `tests/evaluation/component-eval-level1.spec.ts` (classifier/complexity accuracy over labeled fixtures). |
| Baseline + regression detection + report | DONE | `agent-core/evaluation/regression.ts` + `infrastructure/evaluation/baseline-store.ts`. First baseline recorded (see ROADMAP). |
| Real-runtime E2E run | DONE | `tests/evaluation/real-runtime-e2e.spec.ts` — 3/10 FakeModel baseline through the real kernel. |
| External benchmark adapters (SWE-bench, …) | DEFERRED | Interface shape designed; integration later. |
| Real-Ollama evaluation run | PLANNED | Harness ready; needs a local model + a measured run. |

### Documentation / continuity

| Artifact | Status | Note |
|---|---|---|
| Architecture / spec docs | DONE | `Coding Agent Architecture Target.md`, `*_SPEC.md`, `INVARIANTS.md`, `invariants.yaml`. |
| Per-phase roadmaps + sign-offs | DONE | `PHASE_0..12_*`. |
| Project-wide ROADMAP / PROJECT_STATUS | DONE (new) | This file + `ROADMAP.md` — previously missing (the continuity gap). |
| Evaluation baseline record | PLANNED → in progress | First baseline to be recorded by the eval run. |

---

## Known limitations (today, honest)

1. **Mission Intelligence does not steer execution.** Its only control-flow effect is the
   Architecture Gate halting for a human. Routing/context-strategy/planning-mode/expert-profile
   are computed and observable but not applied. (Highest-value integration debt.)
2. **Task correctness is unmeasured.** No benchmark has ever run end-to-end; we cannot currently
   state a success rate for real goals. (The reason the eval system is being built now.)
3. **REPLAN / ROLLBACK recovery are stubs.** The recovery vocabulary is only ~75% real.
4. **Model routing selects an id but doesn't switch the executing model.**
5. **ArtifactStore is in-memory only.**
6. **Product surface is minimal** (functional dashboard + thin VS Code client; no graph view).
7. **Capability model is flat booleans**, not a dependency graph.
8. **Vague goals produce vague results — detection added (Tier A), clarification not yet.** A goal
   with no acceptance criteria and no way to verify (e.g. "create a python script that multiplies
   two matrices") cannot be scored PASSED (no evidence) and gives the agent no concrete target.
   Tier A now **detects** this: `assessUncertainty` marks such a goal UNKNOWN with concrete
   `openQuestions`. But the runtime does **not yet stop to ask the user** — the agent still plans
   and guesses. The clarification loop (Tier B: LLM generates questions + a gate; Tier C: the
   dashboard asks and the answer becomes acceptance criteria, then re-plan) is the next step and
   is NOT built. Until then, clear goals (like the CF-001..010 benchmark tasks) are what the
   runtime drives best.
9. **Local small models (6–9B) are weak agents.** They plan acceptably but often under-perform
   at execution (looping on reads, emitting malformed tool-call JSON, over-decomposing). The
   runtime now mitigates this (anti-loop nudge, reasoning-model JSON handling, graceful-stop) but
   cannot make a weak model competent. Agent quality is model-bound.

None of these violate a kernel invariant — they are intelligence/product gaps, not integrity
gaps. That distinction is the whole point of the two-axis model.

## Recent hardening (post-eval dogfood cycle)

Driven by running the real runtime against live goals:
- **Reasoning-model JSON** — `extractJson` (strip `<think>`/fences/prose) + `think:false` to Ollama.
  Fixes "model output is not valid JSON" when using qwen3 / deepseek-r1.
- **Anti-loop** — `detectExplorationLoop` + a "bias to action" executor prompt.
- **Orchestrator graceful-stop** — unschedulable dependents → ABORTED + session COMPLETES
  (no more whole-run DEADLOCK abort).
- **Runtime model switching** — `SwitchableModelGateway` + `GET/POST /config` (dashboard picker).
- **Dashboard** — Goals chat history, Pending-Approval, Result (`/workspace/files`), workspace +
  model in header, model list/download, honest VERIFYING labeling, no-store cache.
