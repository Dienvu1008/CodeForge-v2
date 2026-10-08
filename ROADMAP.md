# CodeForge v2 — Product Roadmap

> **Read this first at the start of every work session.** It is the authoritative, project-wide
> view that survives across conversations. Phase docs (`PHASE_*`) hold detail; this file holds
> the *product* trajectory. Status detail lives in `PROJECT_STATUS.md`.
>
> Last updated: 2026-09-14 · commit `557a788`.

---

## Product continuity rule (MANDATORY)

Phase completion ≠ task completion ≠ project completion ≠ product readiness. A phase must never
erase awareness of work from earlier phases.

**At the start of every major phase:**

```
READ PROJECT_STATUS.md + ROADMAP.md
   → AUDIT the current implementation (do not trust phase labels)
   → CHECK remaining product objectives
   → SELECT the phase scope from evidence
```

**At the end of every major phase:**

```
RUN tests  →  RUN dogfood / E2E  →  UPDATE PROJECT_STATUS.md  →  UPDATE ROADMAP.md
   → CLASSIFY remaining work  →  RECORD benchmark results (once the eval system exists)
```

The project is moving from **phase-driven** development toward **evidence-driven** development:

```
Goal → Roadmap → Implementation → Evaluation → Evidence → Improvement → New baseline
```

---

## North-star product shape

```
User Goal → Mission Understanding → Complexity/Risk/Uncertainty → Environment/Capability
→ Model Selection → Planning Strategy → Architecture/Requirements → Context Selection
→ Task Graph → Tool-Governed Execution → Verification → Recovery → Observability → Learning/Evaluation
```

Law (never weakened): **LLM proposes, the deterministic runtime decides and enforces.**

---

## Completed

- **Phase 0–1.5** — Domain model, state machines, graph, repositories, SQLite SSOT, ProcessSupervisor,
  security (prompt boundary + structured-output validator), ToolGateway + policy, verification engine.
- **Phase 2–3** — Context builder, Planner + validator + critic, workspace manager.
- **Phase 4–5** — Session orchestrator (autonomous loop), scheduler, budget, recovery (RETRY/FIX/ESCALATE/ABORT).
- **Phase 6–9** — Cross-platform, memory, multi-agent coordination contract, observability + control plane.
- **Phase 10** — Real verification, autonomy levels + in-loop approval, context collector, goal queue, dashboard/VS Code/Telegram clients, progress events.
- **Phase 11** — Learning plane (self-model, lessons, advice gate, recovery/rerank advisors) — advisory, flag-off parity.
- **Phase 12** — Mission Intelligence (intake/complexity/risk, capability verification, model routing, planning router, architect + architecture gate) — advisory, flag-off parity. All 8 `MI-*` invariants active.

**Kernel integrity is mature and invariant-tested (144 base + 7 ME + 7 AU + 6 OB + 8 LE + 8 MI = 180 invariants).**

---

## Current (in progress)

**Evaluation / Benchmark infrastructure** — the mechanism that lets CodeForge measure whether its
own evolution actually works. Builds the missing *Task Correctness* axis:

- Benchmark domain model (pure types in agent-core).
- Benchmark task format + loader + small native seed dataset (CF-001..010).
- Isolated runner driving the **real** runtime (ToolGateway/ProcessSupervisor/policy) — no unsafe path.
- Deterministic evaluator (external to the agent) + extensible metrics + failure classification.
- Trace integration (consume existing EventLog / `MISSION_*` events).
- Baseline recording + regression detection + machine- and human-readable reports.

Rationale: the kernel is stable and Phase 11/12 added decision logic whose value is **unproven
without measurement**. Evaluation is the correct next investment before more intelligence.

---

## Next (highest-value, evidence-gated)

Priority order is provisional and will be re-ranked by the first benchmark's failure analysis
(that is the point of building eval first). Candidate milestones:

1. **Wire Mission Intelligence into execution** (close the biggest integration debt):
   - feed `ContextStrategy` → ContextBuilder (bound retrieval by mission scope);
   - apply routed model at execution (live model selection, not just an emitted id);
   - let the Planner consume planning-mode + expert-profile + architecture.
   Gate this with before/after benchmark numbers (does steering actually improve task correctness?).
2. **Preserve uncertainty for UNKNOWN missions** instead of defaulting to FEATURE/KNOWN.
3. **Finish the recovery vocabulary** — implement REPLAN and ROLLBACK (retire the Phase-5.5 stubs).
4. **Product surface** — task-graph visualization + richer execution trace in the dashboard;
   commit and polish the VS Code `.vsix`; verify Telegram approve/control end-to-end.

---

## Later

- Model registry via `/api/tags` discovery + model health/performance history.
- Capability dependency graph (`build_android` → android-sdk + flutter) instead of flat booleans.
- Disk-backed ArtifactStore.
- External benchmark adapters (SWE-bench / SWE-bench Pro / TerminalBench / SWT-bench / Commit0).
- Controlled self-improvement loop: benchmark failure analysis → self-model → improvement proposal
  → new version → benchmark → accept/reject (data + interfaces first; no autonomous self-modification).

---

## Deferred (explicit, not forgotten)

- `/api/tags` live model discovery (registry is injected).
- Live `ModelGateway` swap per routing decision.
- Formal ontology / knowledge graph / vector DB for mission understanding.
- Web / external research access; new UI frameworks.

## Blocked

- (none currently)

---

## Evaluation baseline

| Field | Value |
|---|---|
| First baseline recorded | _pending — set by the initial benchmark run_ |
| Benchmark | CodeForge native seed (CF-001..010) |
| Agent version / commit | to be stamped at run time |
| Model | FakeModel (CI-deterministic) + real Ollama if available |
| Success rate | _pending_ |
| Largest failure class | _pending — drives the "Next" re-ranking_ |

Once the first run completes, this table and the "Next" section are updated from evidence, and the
result is also recorded in the eval system's own baseline store.
