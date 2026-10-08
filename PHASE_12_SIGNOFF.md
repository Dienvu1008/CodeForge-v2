# Phase 12 Sign-off — Mission Intelligence, Environment Preflight & Adaptive Planning

Date: 2026-09-14
Branch: main
Commits: e41ef7a (roadmap), d12071a (P12.1 domain), 7b2c810 (P12.2 intake/complexity/risk),
         80327c9 (P12.3 capability verification), 9f04d9f (P12.4 model router),
         dc04dac (P12.5 planning router + expert profiles), 12c261c (P12.6 architect + gate),
         5f04818 (P12.7 orchestrator/CLI wiring), `<this>` (P12.8 dogfood + adversarial + E2E + sign-off)

Format per `PHASE_12_ROADMAP.md §5` (Phase gate) + the master prompt. Phase 12 adds a
**pre-execution intelligence layer**: it classifies the mission, verifies the environment,
routes the model, picks a planning mode, and (for complex missions) proposes an architecture
that a deterministic gate must pass — all **before** the kernel plans a single task. The claim
it exists to prove is the same shape as Phase 11's: *the agent can understand a mission before
touching code without conceding a gram of decision authority to the understanding.*

> Before Phase 12: "Build X" → start coding X. After Phase 12: "Build X" → "this is a PROJECT of
> SYSTEM complexity; it needs docker + the Android SDK; the environment is missing the Android
> SDK — stopping for confirmation" → and only then the kernel. Turn the layer off and the runtime
> is byte-identical to Phase 11. Intelligence advises; the kernel decides; capabilities are
> verified, never claimed.

---

## Phase gate (PHASE_12_ROADMAP §5)

- [x] 1. **All 8 `MI-*` invariants have tests and pass (CRITICAL = 100%).** MI-001 (output is
         advisory, never authority), MI-002 (flag-off parity = Phase 11), MI-003 (capability
         VERIFIED only via ProcessSupervisor), MI-004 (stage never mutates Goal / creates
         Task/Graph), MI-005 (deterministic classification), MI-006 (router stays inside a real
         registry), MI-007 (ArchitectureGate BLOCK → AWAITING_HUMAN), MI-008 (ExpertProfile /
         LLM text is untrusted prompt-context). Each has `tests/invariants/mission/mi-00N.spec.ts`;
         all ACTIVE in `invariants.yaml` (v1.10) + `INVARIANTS.md §3.24`.
- [x] 2. **Flag-off parity (MI-002).** Proven two ways. At the orchestrator seam
         (`tests/invariants/mission/mi-002.spec.ts`): with no `missionStage`, the planner is
         called, the session COMPLETEs, and **zero** `MISSION_*` events are emitted; a
         `proceed:true` stage changes nothing. End-to-end over the real SQLite kernel
         (`tests/integration/mission-e2e.spec.ts`): `--mission off` and a wired proceed-stage reach
         the SAME terminal state (COMPLETED).
- [x] 3. **Trivial vs project differentiation (§34).** The dogfood suite
         (`tests/mission/dogfood-missions.spec.ts`) drives 7 missions LOW→SYSTEM and asserts a
         trivial rename routes to the SMALL model with DIRECT planning and NO architecture, while a
         new project routes to the STRONG model with ARCHITECTURE_FIRST planning — different models
         for different work, within a real registry (MI-006).
- [x] 4. **Capability VERIFIED via ProcessSupervisor, never claimed (MI-003).**
         `tests/invariants/mission/mi-003.spec.ts` + the real-probe integration test
         (`tests/mission/capability-prober-integration.spec.ts`) run actual `<tool> --version`
         through the supervisor. The adversarial suite (`tests/adversarial/malicious-mission.spec.ts`,
         A1/A4) proves a model that *claims* docker is installed still BLOCKs when no probe
         verified it.
- [x] 5. **Missing capability detected BEFORE execution; the gate stops at AWAITING_HUMAN (MI-007).**
         `mission-e2e.spec.ts` runs a complex goal whose architecture requires an unverified
         `docker`; the ArchitectureGate BLOCKs, the session ends **AWAITING_HUMAN**, and the task
         graph is still the empty seed (v1, 0 nodes) — nothing was planned or executed.
- [x] 6. **Complex mission → architecture + folder hierarchy + roadmap + verification strategy
         before code (§16).** `MissionArchitect` produces a validated blueprint (requirements,
         module boundaries, folder hierarchy, ordered roadmap, verification strategy); the gate
         requires a verification strategy and capability coverage before PASS
         (`mi-007.spec.ts`, `mission-architect.spec.ts`).
- [x] 7. **Simple task stays fast (MI-002 / §34).** `MissionArchitect.needsArchitecture` is a
         pure predicate; trivial missions skip the LLM architect call entirely. Dogfood M1–M3
         (LOW) produce no architecture and route to the cheapest model.
- [x] 8. **Deterministic at the authority boundary; no kernel bypass; no Phase 0–11 regression.**
         The stage reads the Goal and emits advisory events; the ONLY control-flow effect is a gate
         BLOCK (→ AWAITING_HUMAN). Full suite **1511 / 1511** across **165 files** (WSL
         authoritative), +33 over the P12.5 baseline of 1478 at P12.6 start, +108 over the Phase 11
         sign-off (1403).
- [x] 9. **Cross-platform Windows + WSL; depcruise 0.** Both: build / typecheck / lint / depcruise
         clean, 1511 pass. depcruise **0 violations** (775 modules on Linux). Mission Intelligence
         is pure in `agent-core/src/mission/`; the only I/O adapter (`NodeCapabilityProber`) lives
         in `infrastructure/src/mission/` — `agent-core ↛ infrastructure` holds (DC-002).
- [x] 10. `PHASE_12_SIGNOFF.md` created (this document) with honest dogfood numbers + limitations.

---

## Components delivered (PHASE_12_ROADMAP §2.1)

| ID | Component | Package | Role / enforces |
|----|-----------|---------|-----------------|
| P12.1 | `Mission` + enums + `Architecture`/`ArchitectureGateResult` types | agent-core `domain/mission.ts` | Pure domain shapes for the advisory layer (MI-004 shape). |
| P12.2 | `extractSignals`, `classifyMissionType`, `assessComplexity`, `assessRisk` | agent-core `mission/signals.ts`, `mission-intake.ts`, `complexity-analyzer.ts`, `risk-analyzer.ts` | Deterministic classification over objective signals (MI-005). |
| P12.3 | `Capability`/`CapabilityProbe`, `EnvironmentInventory`, `CapabilityDiscovery`; `NodeCapabilityProber` | agent-core `mission/capability*.ts`; infrastructure `mission/node-capability-prober.ts` | Verify tools via ProcessSupervisor; VERIFIED only with real evidence (MI-003). |
| P12.4 | `ModelRegistry`, `analyzeModelRequirement`, `routeModel` | agent-core `mission/model-router.ts` | Route within a REAL registry; unregistered preferred id ignored; fallback/escalate (MI-006). |
| P12.5 | `decidePlanningMode`; `selectExpertProfile` + `renderExpertProfile` | agent-core `mission/planning-router.ts`, `expert-profile.ts` | Deterministic planning-mode table; expert profile as untrusted prompt-context (MI-001, MI-008). |
| P12.6 | `MissionArchitect` (LLM blueprint); `evaluateArchitecture` (pure gate) | agent-core `mission/mission-architect.ts`, `architecture-gate.ts` | Propose a blueprint via the structured-output pipeline; deterministic PASS/BLOCK (MI-001, MI-007). |
| P12.7 | `decideContextStrategy`; `MissionIntelligence` stage; `MISSION_*` events; orchestrator `missionStage?`; CLI `--mission` | agent-core `mission/mission-context-strategy.ts`, `mission-intelligence.ts`, `domain/event.ts`, `session/session-orchestrator.ts`; infrastructure `cli/runtime-cli.ts` | Optional pre-planning stage; emits advisory events; BLOCK → AWAITING_HUMAN; flag-off parity (MI-001/002/004). |
| P12.8 | dogfood (7 missions), `malicious-mission`, `mission-e2e` | tests `mission/`, `adversarial/`, `integration/` | Behavior-shift evidence + adversarial clamp + real-kernel E2E. |

---

## The one architectural claim this phase exists to prove

The `MissionIntelligence` stage runs once, between a session reaching RUNNING and the Planner
being called. It takes the Goal (read-only), runs pure deterministic analyzers, verifies
capabilities with a real probe, routes the model within a registry of models that actually
exist, and — for complex missions only — asks the model for an architecture blueprint that must
survive a pure deterministic gate. Its single return value is `proceed: boolean`. The **only**
value of `false` is an ArchitectureGate BLOCK, and the only thing the orchestrator does with it
is drive the session to AWAITING_HUMAN before planning. The stage holds no reference to the
ToolGateway, approval engine, task/graph repositories, or state machine — there is no code path
by which it can mutate authoritative state. Unwire it (`--mission off`) and the orchestrator's
behavior is byte-identical to Phase 11; the flag-off parity test makes that measurable, not
asserted.

Capabilities are the sharpest edge: a model's confident claim that "docker is installed" is
treated as a hypothesis until `docker --version` runs through the ProcessSupervisor and returns
evidence. Only a VERIFIED capability is a prerequisite the gate will accept — proven by an
adversarial test where the blueprint insists the tool exists and the gate BLOCKs anyway.

> Smart model. Strict runtime. Verifiable outcome. — and now: understand the mission before you
> touch the code; verify the ground before you build on it.

---

## Dogfood results (§32) — 7 missions of increasing complexity

Captured from `tests/mission/dogfood-missions.spec.ts` (registry: SMALL `qwen2.5-coder:1.5b`,
MEDIUM `qwen2.5-coder:7b`, STRONG `deepseek-r1:14b`):

| Mission | Type | Complexity | Planning mode | Model routed | Architecture |
|---------|------|-----------|---------------|--------------|--------------|
| M1 rename a variable | REFACTOR | LOW | DIRECT | qwen2.5-coder:1.5b | — |
| M2 fix a crash | BUG_FIX | LOW | DIRECT | qwen2.5-coder:1.5b | — |
| M3 add a logout button | FEATURE | LOW | DIRECT | qwen2.5-coder:1.5b | — |
| M4 integrate Telegram notifications | FEATURE | MEDIUM | LOCAL_PLAN | qwen2.5-coder:7b | — |
| M5 migrate MySQL → Postgres | MIGRATION | MEDIUM | MIGRATION_PLAN | deepseek-r1:14b | yes |
| M6 build a new multi-subsystem app | PROJECT | SYSTEM | ARCHITECTURE_FIRST | deepseek-r1:14b | yes |
| M7 multi-repo system design | MULTI_REPOSITORY | SYSTEM | ARCHITECTURE_FIRST | deepseek-r1:14b | yes |

The shape is the point: cost scales with the mission. Trivial work gets the cheap/fast model, no
architecture, and direct planning; heavy work gets the strong model, an architecture pass, and a
staged planning mode. (Model-tier capabilities here are the injected defaults; the differentiation
is produced by `analyzeModelRequirement` + `routeModel`, not hard-coded per mission.)

---

## Honest self-review (§39)

1. **Does Mission Intelligence ever become runtime authority?** No. Its only output is a Mission
   + a `proceed` boolean; the only effect of `proceed:false` is AWAITING_HUMAN. It has no handle
   to tools/approval/state. (MI-001, proven by the orchestrator seam + E2E.)
2. **If you turn it off, is the runtime identical to Phase 11?** Yes, measured — no stage means no
   `MISSION_*` events and the planner path is unchanged (MI-002).
3. **Can the LLM make the agent believe a tool exists that doesn't?** No. Capability status is
   VERIFIED only from a real `--version` probe; a claim never satisfies the gate (MI-003; A1/A4).
4. **Does the stage ever edit the Goal or create Tasks/Graph?** No. It reads the Goal and emits
   events; on BLOCK the graph stays at the empty seed (MI-004, E2E asserts v1/0 nodes).
5. **Is classification deterministic?** Yes — pure keyword taxonomy + multi-dimensional scoring;
   same signals → same type/complexity/risk (MI-005).
6. **Can the router pick a model that isn't installed?** No. It selects only from the registry;
   an unregistered preferred id is ignored; nothing qualifies → fallback to strongest, empty
   registry → escalate (MI-006).
7. **Does the ArchitectureGate stop blind execution of a bad blueprint?** Yes. BLOCK on
   unverified required capability, unresolved open questions under real uncertainty, or missing
   verification coverage (MI-007).
8. **Is an ExpertProfile able to grant itself authority?** No. It renders as prompt-context with
   an explicit "runtime remains authoritative" disclaimer; it is a string, with no mechanism to
   change tools/policy/state (MI-008; A5).
9. **Does a complex mission actually produce an architecture before code?** Yes — blueprint with
   module boundaries, folder hierarchy, roadmap, and verification strategy, gated before planning.
10. **Does a trivial task stay cheap?** Yes — no architect LLM call, cheapest model, DIRECT plan
    (dogfood M1–M3).
11. **Is the layer deterministic at the authority boundary?** Yes — the LLM proposes only the
    blueprint; every control-flow decision (gate verdict, routing, planning mode, classification)
    is a pure function.
12. **Does it bypass the kernel anywhere?** No. It lives strictly before `Planner.plan`; the kernel
    (Planner, GraphCommit, ToolGateway, approval, verification, state machine) is untouched.
13. **Cross-platform?** Yes — Windows + WSL both green: build/typecheck/lint/depcruise + 1511 tests.
14. **Dependency direction preserved?** Yes — mission logic is pure in agent-core; the only I/O
    adapter is `NodeCapabilityProber` in infrastructure (depcruise 0).
15. **Adversarial coverage?** Yes — 5 attacks (capability claim, prompt injection in the blueprint,
    dropped verification, direct gate attack, hostile profile); all clamped or rejected.
16. **What is NOT wired yet (honest gap)?** The `ContextStrategy` scope recommendation is produced
    by the stage but is **not yet fed into the ContextBuilder** used during task execution — today
    it is advisory output only. Wiring it to actually bound retrieval is deferred.
17. **Does model routing swap the gateway at execution?** No. Per the P12.4 decision the router
    decides *which registered model id* is appropriate and emits `MISSION_MODEL_SELECTED`; the
    runtime still executes through the single configured `ModelGateway`. Routing is advisory
    selection, not a live gateway swap.
18. **Is the model registry discovered or injected?** Injected (option a). The CLI seeds the
    registry with the one configured Ollama model; `/api/tags` discovery is deferred (§2.2).
19. **Are the MI-001/002/004 invariant tests end-to-end or seam-level?** Both. The invariant specs
    use lightweight orchestrator fakes for focused control-flow assertions; `mission-e2e.spec.ts`
    repeats the key ones against the real SQLite kernel.
20. **Did Phase 12 add scope creep (§36)?** No new ontology / vector DB / knowledge graph / web
    access / new UI. The layer is a handful of pure functions + one stage + one optional
    orchestrator dep + one CLI flag.

---

## Deferred (explicitly out of scope — §2.2)

- `/api/tags` live model discovery (registry is injected).
- Feeding `ContextStrategy.scope` into the ContextBuilder to actually bound retrieval.
- Live `ModelGateway` swap per routing decision (routing selects an id; execution stays single-gateway).
- Formal ontology / knowledge graph / vector DB / embeddings for mission understanding.
- Web/external research access; any new UI surface.

These are intentional boundaries, not unfinished work: each would add authority or cost without a
proven need, which is exactly what Phase 12's five laws forbid.

---

## Test progression

| Milestone | Files | Tests |
|-----------|-------|-------|
| Phase 11 sign-off | 147 | 1403 |
| P12.1 domain | +1 | +4 |
| P12.2 intake/complexity/risk | +2 | +22 |
| P12.3 capability verification | +2 | +~10 |
| P12.4 model router | +1 | +~13 |
| P12.5 planning router + expert profiles | +2 | +~14 |
| P12.6 architect + gate | +2 | +14 |
| P12.7 orchestrator/CLI wiring | +6 | +20 |
| P12.8 dogfood + adversarial + E2E | +3 | +13 |
| **Phase 12 total** | **165** | **1511** |

(Counts are the WSL authoritative figures; the Windows PowerShell host garbles vitest's summary
line via the worker-title spinner, so Windows runs are confirmed by exit code 0 and cross-checked
against WSL for the exact numbers.)
