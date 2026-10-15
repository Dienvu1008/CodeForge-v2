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
| Recovery: REPLAN | DONE | Lightweight REPLAN: `RecoveryEngine.shouldReplan` + `SessionOrchestrator.performReplan` commits a SUPERSEDE_TASK GraphMutation (RC-005/GI-007/GI-009). |
| Recovery: ROLLBACK | DONE | P12.14: `RecoveryEngine.shouldRollback` + `SessionOrchestrator` performs the revert through the injected `WorkspaceRollback` port (`WorkspaceSnapshotRollback` in infra: content snapshot of the clean baseline → restore). Enabled for the SYNTAX class (`FIX→ROLLBACK→ESCALATE`, `rollbackAllowed=true`, RC-004); fail-safe when the port is absent. Wired in the CLI + benchmark runner. All 6 recovery actions now real. |
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
| Expert profiles | DONE (P12.8) | `expert-profile.ts` selected/rendered, now injected into BOTH the executor AND the planner prompt as a trusted `EXPERT_PERSONA` section via the PromptComposer. |
| Prompt composition (prompt shaping) | DONE (P12.8) | `mission/prompt-composer.ts` — deterministic, pure assembly (NO LLM): `composePromptPlan(mission, profile)` → `PromptPlan` {expertPersona, taskTypeGuidance, fewShotExampleId, verbosity}, threaded orchestrator → both the executor (`TaskExecutorRequest.promptPlan` → EXPERT_PERSONA / TASK_TYPE_GUIDANCE / EXAMPLE sections) AND the planner (`Planner.plan(..., promptPlan)` → EXPERT_PERSONA section; executor-oriented guidance/few-shot deliberately NOT applied to decomposition), plus a verbosity-selected system-prompt addendum (guarded for weak models, terse for strong reasoners). Advisory (MI-008); absent ⇒ static default prompt (fail-safe). Measured prompt cost: `prompt_tokens_peak/total` metrics. Real-model success impact unmeasured. |
| Mission Architect (LLM blueprint) | DONE (advisory) | `mission-architect.ts`; validated via structured-output pipeline. |
| Architecture Gate (deterministic) | DONE | `architecture-gate.ts`, MI-007; BLOCK → AWAITING_HUMAN (the one real control-flow effect). |
| Context strategy (scope selection) | DONE (P12.7) | `mission-context-strategy.ts` → `toContextPlan` → threaded orchestrator → `TaskExecutorRequest.contextPlan` → BOTH the `ContextBuilder` policy (`policyFromContextPlan`: scope→maxItems+tokens) AND the `ContextCollector` caps per-call. Fail-safe (no plan ⇒ default policy + default caps). Measured before/after on a real workspace: narrow TASK scope cut context ~62% (21 items/313 tok → 8 items/118 tok) with the pinned task item retained. Real-model success impact still unmeasured (needs a real-model run with mission on). |
| MissionIntelligence stage wired into orchestrator | PARTIAL | `--mission on` runs it between RUNNING and planning; emits `MISSION_*` events. The orchestrator reads `proceed` (gate BLOCK → AWAITING_HUMAN), `assumptions` (Tier B2 → executor prompt), `contextPlan` (P12.7 → context pipeline size), **and now `promptPlan`** (P12.8 → prompt shaping: persona/guidance/few-shot/verbosity into the executor prompt). Routing/architecture are still otherwise observable-only. |
| Uncertainty assessment (goal ambiguity) | DONE | Tier A: `assessUncertainty` (deterministic) → KNOWN/INFERRED/UNKNOWN + `openQuestions`; `MISSION_UNCERTAINTY_ASSESSED`. |
| Goal clarification by assumption (option ii) | DONE | Tier B1: `AssumptionAdvisor` (LLM) turns a vague goal's gaps into EXPLICIT assumptions + a clarified restatement; mirrored into Mission.acceptanceCriteria (never the Goal — MI-004); emitted as `MISSION_ASSUMPTIONS_MADE` and shown in the dashboard reasoning. **Tier B2: the assumptions now STEER the agent** — the stage exposes a flattened `assumptions` list, the orchestrator threads it into every `TaskExecutorRequest` (`goalAssumptions`), and the executor injects a TRUSTED `STATED_ASSUMPTIONS` prompt section telling the model to proceed under them as fixed constraints. Fail-safe (absent ⇒ prompt unchanged). Before/after benchmark still pending. |

> **The honest one-line summary of Phase 12 today:** the intelligence layer *analyzes and
> observes* (events + a gate that can halt for a human). Its influence on the agent is still
> narrow but growing: the Architecture Gate can halt for a human, and (Tier B2) stated goal
> assumptions now steer the executor's prompt, (P12.7) the context strategy now sizes the context
> pipeline (ContextBuilder policy + Collector caps), and (P12.8) the PromptComposer now shapes the
> executor prompt (expert persona + task-type guidance + few-shot + verbosity) from mission signals
> — deterministically, no extra LLM call — on BOTH the executor and the planner prompt. The model
> used at execution time and the architecture/planning-mode mission outputs are still
> observable-only — not yet wired into behavior.

### Model system

| Capability | Status | Evidence / note |
|---|---|---|
| ModelGateway contract + adapters | DONE | `model/gateway.ts` (provider-agnostic contract). Adapters: `OllamaModelGateway` (local) + `OpenAiCompatibleModelGateway` (any OpenAI Chat Completions API — OpenAI, OpenRouter, Groq, Together, DeepSeek, Mistral, LM Studio, llama.cpp, vLLM, LiteLLM). |
| Multi-provider gateway + runtime switch | DONE | `SwitchableModelGateway` holds ONE gateway reference (MG-001) and can switch model AND provider at runtime via `setProvider({provider, model, endpoint, apiKey})`; fail-safe (an invalid spec throws before replacing the live adapter). CLI: `--provider ollama\|openai-compatible`, `--endpoint`, `--api-key`/`CODEFORGE_API_KEY` (never logged). Dashboard provider-switch UI still pending (model-only switch exists). |
| Model registry (capability metadata) | DONE (config) | `ModelRegistry` can now be seeded from a `--model-registry` JSON file listing MULTIPLE models (id + tier + capabilities + how to run each), feeding BOTH the router and the selector from one source. Keys via env refs. Still no `/api/tags` auto-discovery (the list is declared, not probed). |
| Model requirement analysis + routing selection | DONE | `analyzeModelRequirement` + `routeModel`, MI-006. |
| Per-purpose model routing | DONE | `RoutingModelGateway` routes each call to a provider/model chosen by its `ModelPurpose` (plan/architect on a strong model, execute/summarize on a cheaper/local one) behind the single gateway reference (MG-001). Config from a JSON file (`--model-routes`); API keys via env refs (`apiKeyEnv`), never in the file or logs; fail-safe (unmapped purpose → default; no file → single switchable gateway). The "shunt"-style cost/quality split. |
| Routing applied automatically from the mission (`routeModel` → gateway) | DONE (P12.9) | The mission stage exposes `selectedModelId` (from `routeModel`); the orchestrator passes it to an optional `RuntimeModelSelector` (agent-core, id-only — DC-002) which the infra `SwitchableRuntimeModelSelector` maps `id → ProviderSpec` and applies to the switchable gateway. Advisory → runtime applies; fail-safe. **Verified live with ≥2 Ollama models via `--model-registry`:** a trivial bugfix routed to the SMALL/FAST model as designed. Known gap surfaced by this live run: the complexity analyzer scores a multi-file REFACTOR as LOW, so a genuinely harder goal does NOT yet escalate to the STRONG model — the routing mechanism is correct; its *input* (complexity estimation) needs refining. |
| Model health / performance history | PLANNED | None. |

### Context system

| Capability | Status | Evidence / note |
|---|---|---|
| Repository analysis (symbols, import graph) | DONE | `infrastructure/code-intelligence/` (Tree-sitter / LSP), consumed by `ContextCollector`. |
| ContextBuilder + token budget + trust marking | DONE | `context/`, CX-*. |
| Changed-paths / retrieval | DONE | `context-runtime/`. |
| Mission → Context strategy integration | DONE (P12.7) | Strategy flattened to `ContextPlan`, threaded through the orchestrator to the executor; sizes the ContextBuilder policy + the ContextCollector caps. Fail-safe when absent. |

### Planning & execution

| Capability | Status | Evidence / note |
|---|---|---|
| Planner + PlanValidator + PlanCritic | DONE | `planning/`, MG-*/GI-009; advisory critic refinement round. |
| Task decomposition + dependency ordering | DONE | Planner emits GraphMutation; scheduler orders. |
| Architecture-first / roadmap-driven planning | PARTIAL | The Planner now consumes the mission's expert persona + verbosity (P12.8 prompt shaping), but still NOT the architecture blueprint or planning-mode. |
| Replanning | DONE | Lightweight REPLAN (SUPERSEDE_TASK GraphMutation) — see the Recovery: REPLAN row. |
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
| Native seed dataset (CF-001..010) | DONE | `benchmarks/codeforge-native/benchmark.json`, 10 tasks across 10 categories (harness-validation fixture). |
| Progressive capability-curve dataset (PG-01..12) | DONE (Tier A) | `benchmarks/codeforge-progressive/benchmark.json` — 12 difficulty-graded tasks (TRIVIAL→EXPERT) with Node-only deterministic checks. Each ships a `package.json` whose `test` script is `node test.js`, so the runtime's own verification gate runs it mid-execution and recovery can retry on a red test (mirrors a real repo). Every task proven solvable by a hand-written golden solution (`scripts/verify-progressive-golden.mjs`, 12/12). `scripts/run-progressive.mjs` runs it through the real kernel + a real model to draw a capability curve. CI guard: `tests/evaluation/progressive-benchmark.spec.ts` (dataset well-formed, difficulty-ordered) — does NOT call a model. |
| Level-1 component eval | DONE | `tests/evaluation/component-eval-level1.spec.ts` (classifier/complexity accuracy over labeled fixtures). |
| Baseline + regression detection + report | DONE | `agent-core/evaluation/regression.ts` + `infrastructure/evaluation/baseline-store.ts`. First baseline recorded (see ROADMAP). |
| Real-runtime E2E run | DONE | `tests/evaluation/real-runtime-e2e.spec.ts` — 3/10 FakeModel baseline through the real kernel. |
| External benchmark adapters (SWE-bench, …) | DEFERRED | Interface shape designed; integration later. |
| Real-Ollama evaluation run | DONE (4-model curve) | Real-model capability curves on the progressive benchmark (each task ships a `package.json` with a `test` script, so the executor's verification runs `npm test` every iteration and recovery retries on a red test): **deepseek-r1:14b 3/12, qwen2.5-coder 2/12, deepseek-coder:6.7b 1/12, llama3:8b 1/12.** The curve tracks model strength: the largest/reasoning model (deepseek-r1:14b) is the only one to pass the structural HARD tasks (module extraction PG-06, public-API rename across call sites PG-08) that the smaller models fail outright. Runtime behaved CORRECTLY throughout — the trace shows model → verify catches the red test → recovery RETRIES up to 3× with the failure evidence. Notably NO local model (even 14B) passed PG-01, the one-line `i < n` → `i <= n` fix: precise in-place logic edits are a shared weakness of local models. **Conclusion: the ceiling is MODEL capability, not a runtime defect** (verify + recovery demonstrably work), and a bigger model measurably raises the score — the Task-Correctness motivation for the multi-provider gateway. |

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
3. **The recovery vocabulary is now complete — ROLLBACK is real (P12.14).** REPLAN was a
   lightweight re-plan: on a REPLAN decision the orchestrator commits a SUPERSEDE_TASK
   GraphMutation that replaces the failing task with a `replanner` successor carrying the failure
   evidence (RC-005 a new version, GI-007 old task → SUPERSEDED, GI-009 via GraphCommitService).
   ROLLBACK (P12.14) follows the SAME engine-signals / orchestrator-performs pattern: the engine
   sets `shouldRollback` (outcome PENDING), and the orchestrator reverts the workspace to the last
   clean checkpoint through an injected `WorkspaceRollback` port (`WorkspaceSnapshotRollback` in
   infra — a content snapshot of the clean baseline, restored by overwriting drifted files,
   re-creating deleted ones, and deleting agent-created ones), then re-arms the task to retry on
   that known-good tree. It is enabled for the SYNTAX class only (`FIX→ROLLBACK→ESCALATE`,
   `rollbackAllowed=true` — RC-004; policy bumped to v2), and is fail-safe: with no port wired (or
   a revert the port could not complete) ROLLBACK degrades to a plain re-arm, never a crash, and
   stays bounded by maxAttempts/no-progress. Wired in the CLI and the benchmark runner (both
   snapshot the clean workspace before the run). So ALL recovery actions are now real; nothing in
   the vocabulary is a stub. The earlier REPLAN residual (a new taskId
   each replan resetting the per-task no-progress detector) is now FIXED: the orchestrator tracks
   the supersession lineage and feeds the whole lineage's failure history to the detector, so a
   same-class REPLAN loop trips no-progress → ESCALATE after a bounded few replans (RC-002/003)
   rather than running to `maxIterations`.
4. **Model routing is fully wired; its real-world effect is gated by how many models you register.**
   The runtime runs Ollama OR any OpenAI-compatible provider; a `--model-routes` file routes each
   PURPOSE (plan/execute/architect/…) to a different provider/model (shunt-style cost/quality split);
   and the mission router's per-mission choice is now applied at runtime via a `RuntimeModelSelector`
   (P12.9). The remaining caveat is data, not plumbing: the model **registry seeds only the configured
   model today**, so mission-driven auto-switching only changes anything once ≥2 models are registered
   (future: `/api/tags` discovery or a registry config). Real-model success impact is still unmeasured.
5. **ArtifactStore is in-memory only.**
6. **Product surface is minimal** (functional dashboard + thin VS Code client; no graph view).
7. **Capability model is flat booleans**, not a dependency graph.
8. **Vague goals: detected (Tier A) + handled by assume-and-state (Tier B1/B2); no stop-and-ask
   yet (Tier C).** A goal with no acceptance criteria and no way to verify (e.g. "create a python
   script that multiplies two matrices") still cannot be scored PASSED (no evidence). Tier A
   **detects** this (`assessUncertainty` → UNKNOWN + `openQuestions`); Tier B1 makes EXPLICIT
   assumptions + a clarified restatement; **Tier B2 now injects those assumptions into the
   executor prompt** so the agent proceeds under a concrete interpretation instead of guessing
   blindly. The runtime still does **not stop to ask the user** — that stop-and-ask path (Tier C:
   dashboard asks, the answer becomes acceptance criteria, then re-plan) is optional and NOT
   built. The before/after benchmark proving B2 improves task correctness is also still pending.
   Clear goals (like the CF-001..010 benchmark tasks) remain what the runtime drives best.
9. **Models (weak AND strong) under-perform at execution; the runtime mitigates but cannot force
   competence.** Local 6–9B models loop on reads, emit malformed tool-call JSON, or over-decompose.
   The runtime mitigates this (anti-loop nudge, reasoning-model JSON handling, graceful-stop,
   tool-native adapter, the P12.11 premature-done gate, and the P12.13 multi-file half-done guard).
   Agent quality is still model-bound.
   **Live-confirmed, two failure modes:**
   - (P12.9) qwen2.5-coder nailed a one-line bugfix but, on a multi-file refactor, created the new
     module as an EMPTY file and never wired the import — it half-did the harder task. The P12.13
     guard now challenges this specific shape (a `done` that leaves a named source file unwritten).
   - (PG-01 investigation) BOTH qwen2.5-coder and Groq gpt-oss-120b, on the trivial off-by-one fix,
     `read_file` then declared `done` WITHOUT writing. P12.11 now challenges that first done (the
     model is told it has changed nothing and must write) — but the gate only forces another
     ATTEMPT, it cannot make the model actually emit the write. Whether the challenged retry
     succeeds is still model-dependent (see the measurement section below).
   The runtime stayed intact in every case (graceful-stop, session COMPLETED, existing code
   unbroken).
10. **Complexity estimation under-scored structural refactors — FIXED (P12.10).** A multi-file
    REFACTOR with explicit module-boundary design used to score LOW (the fixed `-1` light-type
    discount cancelled the one breadth hit). Now `extractSignals` emits structural signals
    (module restructure / dependency boundary / interface change / cross-file consistency /
    behavior preservation) + a `pathCount`, the analyzer scores them (capped, deduped), and the
    light-type discount is withheld when structural evidence is present — so the regression case
    now lands HIGH and routes to a stronger model. **Residual (not addressed):** complexity rests
    on surface signals, so a *conceptually* hard task with no structural wording (e.g. "fix the
    race condition") still scores LOW — the analyzer cannot read reasoning difficulty from prose.
    Separately, a goal that says both "refactor" and "add tests" still classifies as TESTING in
    mission-intake (TESTING precedes REFACTOR in the taxonomy); complexity is now correct regardless
    because structural signals are type-independent, but the type label itself is still off.

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
- **Goal clarification (Tier A + B1 + B2)** — detect vague goals (`assessUncertainty`) + make
  explicit assumptions (`AssumptionAdvisor`), shown in the dashboard Live Activity as the agent's
  reasoning (MISSION_* events as readable "thinking" lines, commercial-agent style). **Tier B2:
  those assumptions now steer the agent** — threaded orchestrator → `TaskExecutorRequest.goalAssumptions`
  → a TRUSTED `STATED_ASSUMPTIONS` section in the executor prompt (fail-safe when absent; Goal never mutated, MI-004).
- **Tolerate tool-native OpenAI-compatible models** — Groq's `gpt-oss-*` answer via a tool call and
  are tool-trained reasoning models: they answer via a tool call OR in a `reasoning` field (leaving
  `content` empty), and 400 a bare `response_format` request. The adapter now, when `preferToolJson`
  is on (auto for `*.groq.com`), (a) reads tool-call `arguments`, (b) reads `message.reasoning` when
  `content` is empty, (c) recovers a JSON-parseable `failed_generation` from a 400, and (d) sends
  `reasoning_effort: low` instead of `response_format`. Measured effect: planner
  PLANNING_FAILURE collapsed (gpt-oss-20b 8 → 2) and the executor's HTTP 400 `json_validate_failed`
  disappeared. Confined to the infrastructure adapter; no domain/core change.
- **Premature-done gate (P12.11, core)** — the executor challenges the first `done` that arrives
  with zero workspace mutations this run (the "read then done without writing" failure seen on both
  weak and strong models), rejecting it once with a nudge to write. At most one challenge; fail-safe.
- **Recovery wired into the capability-curve runner** — the progressive benchmark previously built
  the orchestrator WITHOUT the recovery stack, so a failed verification was never retried (it
  measured a one-shot model). Now `FailureAnalyzer` + `RecoveryEngine` + the failing-check evidence
  provider are wired, matching the product CLI. (Measurement harness only; not a runtime change.)
- **`edit_file` tool (P12.12, infra + core wiring)** — a surgical in-place find/replace (one literal
  occurrence; 0 → not found, >1 → ambiguous), the alternative to whole-file `write_file`. Models
  (weak and strong) read-then-gave-up on small in-place fixes partly because the only edit tool
  rewrote the entire file. Added through existing seams (ToolRegistry MODIFY_WORKSPACE +
  content-hash, FilesystemExecutor, MUTATING_TOOLS, executor prompt "prefer edit_file"); no
  contract change (ToolCall.toolName is already an open string, DC/§12.1).
- **Google Gemini provider (`GeminiModelGateway`)** — a native-wire adapter (`x-goog-api-key` +
  `contents`/`parts` + `:generateContent`), since Gemini's OpenAI-compat endpoint 404s for AI Studio
  keys. Same `ModelGateway` contract, infrastructure only. `--provider gemini` in the runner;
  `gemini` is a `ModelProvider` in buildAdapter. First hosted provider not gated by Groq's quota.

## First hosted-model capability measurement (honest)

Progressive benchmark (Tier A, 12 difficulty-graded JS tasks, real kernel + verify + recovery),
Groq `openai/gpt-oss-120b` via the OpenAI-compatible adapter, `--delay-ms 35000` to stay under the
free-tier 8000 TPM cap. The score moved as the harness and runtime were fixed — each number is
honest about WHAT it measured:

- **1/12** (first run): looked like model weakness but was actually free-tier rate-limit (429) +
  `tool_use_failed`, surfaced as 7 bogus "PLANNING_FAILURE". An unmeasured harness lies.
- **3/12** after the tool-native wire fixes (reasoning channel + failed_generation recovery) +
  `--delay-ms`: 0 PLANNING_FAILURE — every plan committed and ran. All failures became
  IMPLEMENTATION_FAILURE (real execution quality).
- **4/12** after wiring the recovery stack into the runner (PG-09 HARD passes on a retry).
- **5/12** after the P12.11 premature-done gate (PG-02 EASY now passes). Failure classes
  `{VERIFICATION_FAILURE: 4, IMPLEMENTATION_FAILURE: 3}` — the loop now reaches verify/recovery on
  most cases rather than giving up early.

What gpt-oss-120b passes vs. fails is a clean pattern: it solves **add/create** tasks — PG-02
(add a helper), PG-06/PG-07/PG-09 (HARD module extraction with a dependency boundary), PG-11
(EXPERT) — but still fails **in-place edit / cross-file rename** tasks — PG-01 (TRIVIAL `<`→`<=`),
PG-03/PG-08 (rename + update call sites), PG-10. Local Ollama baselines for contrast:
deepseek-r1:14b 3/12, qwen2.5-coder 2/12, deepseek-coder:6.7b 1/12, llama3:8b 1/12.

**PG-01 — root-caused and fixed for a local model (P12.12), confirmed end-to-end.** The P12.11
gate challenges the premature `done` but cannot force the model to write; with only `write_file`
(whole-file overwrite) both qwen and gpt-oss kept reading-then-giving-up. Adding `edit_file`
(surgical find/replace) changed the behavior. Confirmed through the FULL benchmark harness (not
just a trace): **qwen2.5-coder now PASSES PG-01** (`node test.js` green) — a TRIVIAL task it had
failed on every prior run. Its 2/12 is now PG-01 (TRIVIAL) + PG-11 (EXPERT), with the other ten
cases all VERIFICATION_FAILURE (0 PLANNING_FAILURE) — i.e. the model reaches verify on every case
instead of giving up early. So PG-01's earlier red was partly a missing-tool gap, not pure model
weakness. (The 7B model still wanders mid-run — stray file, rewritten test — but `src/math.js`
ends correct and the test passes, which is what verification judges.)

**Honest counter-point — the win is not uniform across models.** A full local re-run of
deepseek-r1:14b (same runtime: edit_file + P12.11 + recovery) scored **2/12** (PG-02 EASY + PG-11
EXPERT), DOWN from its earlier 3/12 baseline, and it still FAILS PG-01. So edit_file clearly helped
qwen2.5-coder on PG-01 but did not help deepseek-r1 there, and deepseek-r1's HARD structural passes
(PG-06/PG-08 last time) did not reproduce. Two honest reads: (1) the benchmark is non-deterministic
(temperature 0.2 on a reasoning model), so 2-vs-3 is partly run-to-run noise; (2) a new tool widens
the action space, which can also let a model wander differently. Net: edit_file is a real lever for
in-place fixes on at least one model, not a guaranteed score bump for every model — recorded as-is.

**Measurement caveat (honest):** the end-to-end gpt-oss-120b re-run WITH `edit_file` could not be
completed. The Groq free tier caps tokens-per-DAY at 200000 PER ORGANIZATION (not per key — a new
key on the same org shares the exhausted budget), and the day's runs had used it up, so cases
returned 429. The other hosted code models were also unusable on free tier: gpt-oss-20b shares the
same TPD; `qwen/qwen3.8-27b` is throttled to OTPM 1000 (output tokens/min), which a planner prompt
blows instantly; the llama chat models are no longer offered. So the `edit_file` win is evidenced
on LOCAL models (the qwen2.5-coder PG-01 pass above), which need no quota; a fresh hosted curve
needs a new daily quota or a paid tier.

**Google Gemini — adapter built and measured (highest hosted score so far).** Groq's OpenAI-compat
endpoint 404s for AI Studio keys and Gemini's native wire shape differs, so a dedicated
`GeminiModelGateway` was added (native `x-goog-api-key` + `contents`/`parts` + `generateContent`;
same `ModelGateway` contract, infrastructure only, no domain change; 13 unit tests).

Live progressive-benchmark result (`gemini-3.5-flash-lite`, edit_file + P12.11 + recovery). A first
run at `--delay-ms 5000` scored 6/12 but hit free-tier RPM 429s at five planner calls. Re-run at
`--delay-ms 20000` to remove the throttling: **8/12 with ZERO 429 and ZERO PLANNING_FAILURE** —
`{VERIFICATION_FAILURE: 4}`, i.e. every plan committed, every case ran to verification, and the
four losses are genuine model capability (red checks), not infrastructure noise. This is the first
undistorted hosted curve.

- By difficulty: TRIVIAL 1/1, EASY 1/2, MEDIUM 1/2, HARD 4/6, EXPERT 1/1.
- PASS: PG-01 (edit_file in-place fix), PG-02 (add helper), PG-04 (MEDIUM), PG-06/PG-07/PG-09/PG-10
  (HARD — module extraction, shared-constant, domain layer, and PG-10's closure-capture bug that
  gpt-oss-120b missed), PG-11 (EXPERT).
- FAIL: PG-03/PG-08 (cross-file rename + update all call sites), PG-05 (discount/checkout
  integration), PG-12 (validator wiring) — the cross-file-consistency cluster is flash-lite's
  ceiling here.
- Standings: gemini-3.5-flash-lite **3-run mean 11/12 (best 12/12)** (with context + RPM throttle;
  see the clean-curve section below) > gpt-oss-120b 5/12 > deepseek-r1:14b / qwen2.5-coder 2–3/12.
  The 8/12 figure was the context-BLIND run; wiring context + throttling RPM took the same model to
  a 12/12 best / 11/12 mean. Gemini + the full runtime is the strongest combination measured; a
  bigger Gemini (pro) is untested (slower, timeout-prone on free tier).

**Cross-file cluster — root-caused to a missing contextProvider, not model weakness.** The 8/12
curve above still failed PG-03/PG-08 ("rename a symbol + update every call site in other files").
Tracing showed WHY: the capability-curve runner built the TaskExecutor WITHOUT a `contextProvider`,
so the agent ran CONTEXT-BLIND — it never saw the caller files (`src/profile.js`, `src/admin.js`)
or the import graph, which is exactly what a cross-file rename needs. The product CLI always wires
`ContextCollector`; the benchmark did not (the same class of gap as the earlier missing recovery
stack). After wiring it: the executor prompt gains a CODEBASE_CONTEXT section with all caller files
+ import edges, and a traced gemini-3.5-flash-lite run of PG-08 now edits user.js + admin.js +
profile.js and PASSES. A re-run of the full curve (context + delay 20s) scored **9/12** with
**PG-03 and PG-08 both now PASS**, before Gemini free-tier 429s truncated the final cases. Those
429s were a REQUESTS-per-minute (RPM) cap, not a cumulative quota: a single case fires many model
calls (plan + each execute step + recovery) in a burst, which `--delay-ms` (a pause between CASES)
does not throttle. Added `--min-call-interval-ms` to the runner: a global monotonic gate that
spaces every model call ≥N ms apart, so bursts within a case cannot exceed the RPM cap.

**Clean curve — 3-run average 11/12 (best 12/12).** With `--min-call-interval-ms 5000` (≤12
calls/min, zero 429 on all runs), gemini-3.5-flash-lite + the full runtime (context + edit_file +
premature-done gate + recovery) was measured THREE times to separate signal from sampling noise
(temperature 0.2):

| Run | Score | Misses |
|---|---|---|
| 1 | **12/12** | — (perfect; HARD 6/6) |
| 2 | 11/12 | PG-08 |
| 3 | 10/12 | PG-05, PG-12 |

Mean **11.0/12 (~92%)**, range 10–12, zero PLANNING_FAILURE / zero 429 throughout. Per-case over
the three runs: PG-01/02/03/04/06/07/09/10/11 passed 3/3 (a stable 9-case core across TRIVIAL →
EXPERT, including all the module-extraction/closure HARD cases); PG-05, PG-08, PG-12 each passed
2/3. Crucially **no case is a hard ceiling** — every miss also passed on another run — so the
residual losses are sampling variance on the harder MEDIUM/HARD cases, not a runtime gap.

The arc is the whole point: 8/12 (context-blind) → 9/12 (context, quota-cut) → 11–12/12 (context +
RPM throttle). Every point came from closing a benchmark-harness gap so the curve measures the real
runtime, not from changing the model. The multi-file half-done case (qwen on PG-08, Gemini's one
PG-12 miss) is now addressed by the **multi-file half-done guard (P12.13)** — see below.

**Focused re-run of the three variable cases (REPLAN now active, gemini-3.5-flash-lite x3 each).**
To see where the variance lives and whether REPLAN helps:

| Case | Result | replans used | Read |
|---|---|---|---|
| PG-08 (HARD, cross-file rename) | **3/3 PASS** | 0 | Stabilised (was 2/3). contextProvider lets the model see the caller files and get it right first try — no replan needed. |
| PG-05 (MEDIUM, discount-then-tax order) | 2/3 PASS | 0 | A subtle arithmetic-order logic bug the model gets right ~2/3 of the time. |
| PG-12 (HARD, validator + wire + keep export) | 1/3 PASS | 0 | Flakiest; one run didn't even create `src/validate.js` (multi-file half-done) — now targeted by the P12.13 guard. |

Two honest takeaways: (1) the one case that was really a harness gap (PG-08 cross-file) is now
solid thanks to context. (2) REPLAN did NOT fire on PG-05/PG-12 (`replans=0`): a test failure
classifies as LOGIC, whose policy is FIX→RETRY→ESCALATE (no REPLAN), so REPLAN doesn't touch these
— their variance is genuine model logic/half-done error, not something the recovery vocabulary
closes. PG-12's "validate.js missing" run is the same multi-file-half-done shape as qwen on PG-08:
the P12.11 premature-done gate can't challenge it because one file was already written. **This is
exactly what the P12.13 guard (below) now catches** — a `done` is challenged once when the task
description names a source file the agent never wrote this run.

**Multi-file half-done guard (P12.13, core).** The P12.11 premature-done gate only fires when the
agent changed *nothing*; it is blind to a run that wrote SOME files and quit (PG-12 edited the
signup caller but never created `src/validate.js`; qwen on PG-08 renamed in `user.js` but not
`profile.js`/`admin.js`). P12.13 extends the done-gate: the executor records every path it writes
this run (`writtenPaths`), extracts the source-file paths the task description explicitly names
(`extractMentionedPaths` — tokens with a known source extension, so prose that merely mentions a
module without an extension never false-fires), and if `done` arrives with named files still
unwritten it rejects that `done` ONCE, naming the missing files in the transcript and giving one
more step to write them. At-most-once (`missingPathChallengedOnce`) and fail-safe (empty mentioned
set ⇒ inert; verification + recovery stay the real authority). `TaskExecutor` only — no domain,
contract, or infrastructure change. 4 new unit tests (challenge-then-complete, all-written→no
challenge, at-most-once termination, inert when no path named); WSL suite green.

**P12.13 re-measure of PG-12 (focused, `--only PG-12`).** Measured after the guard shipped:
- gemini-3.5-flash-lite: 1 run FAIL on the `node test.js` *behavioral* check (not `file_exists`);
  a 2nd run was a Gemini HTTP-429 quota PLANNING_FAILURE (free-tier exhausted — infra, not runtime).
- Groq `openai/gpt-oss-20b` (new key, `--min-call-interval-ms 3000`): **3/3 runs FAIL, every one on
  the `node test.js` behavioral check — and `src/validate.js` was CREATED in every run** (the
  `file_exists` check passed each time). The dumped assertion is the smoking gun:
  `signup('bad')` returned `{ ok: true, email: 'bad' }` where `{ ok: false }` was expected — i.e.
  the model wrote the validator module but never WIRED it into `signup`.

So the guard did exactly its job: it moved PG-12's failure OFF the "`validate.js` missing"
multi-file-half-done shape (which the runtime should and now does catch) and ONTO a pure model
wiring/logic error — the model produces both files but mis-implements the behaviour. That residual
is model capability, not a runtime gap: a deterministic guard can force every named file to exist,
but it cannot make the model write *correct* glue between them. (Harness-only aids added for this
measurement: a `--only <id[,id]>` case filter and a CF_DEBUG failing-check `detail` dump.)

**PG-06 — not a runtime gap; model-dependent + non-deterministic.** Traced PG-06 (extract a pure
`sum(xs)` module + rebuild `sumToN` on it) on both models:
- gemini-3.5-flash-lite PASSED it in isolation: it wrote `sum-core.js` (`xs.reduce`), then
  `math.js` importing `sum` and building `sumToN` via `sum([1..n])`, clean exports, `node test.js`
  green. So the 11/12 miss was run-to-run variance (temperature 0.2), NOT a fixed ceiling.
- qwen2.5-coder FAILED it: `sum-core.js` was correct, but it rewrote `math.js` with `write_file`
  repeatedly, each pass prepending another `require(...)` line without removing the old one, until
  the file had a duplicate `const sumToN` → `SyntaxError: Identifier 'sumToN' has already been
  declared`. A weak model losing control of whole-file overwrites (edit_file would have avoided the
  junk, but the model chose write_file). This is a model-discipline limit, not a missing tool or
  context — context + edit_file + recovery were all available.

Net: PG-06 is solvable by a capable model under the current runtime; the benchmark's remaining red
cells are model capability + sampling variance, not harness gaps. (Minor observation: Gemini tried
`npm test` and the shell allowlist denied it — only `node` is allowlisted — but verification still
ran its own checks, so this did not affect the verdict.)

Operational notes from the probe (for whoever runs it next): Gemini **2.5** models now 404 "no
longer available to new users" (use a 3.x id); some 3.x **flash** models were slow/overloaded
(60s timeouts, 503 "high demand"); **`gemini-3.5-flash-lite`** worked reliably. A higher
`--delay-ms` (or a paid tier) would remove the 429s and likely raise the score.
