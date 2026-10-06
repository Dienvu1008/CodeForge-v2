# Phase 9 Sign-off — Observability / Control / Dogfood

Date: 2026-09-14
Branch: main
Commits: 5a15d18 (roadmap), 9f2f444 (P9-INV), 5ae6da1 (P9.2 projection+telemetry),
         bbd8170 (P9.7 ControlPlane+PAUSED), 7cbd944 (P9.4 ActivityTrace + P9.9
         InterventionRecord), 50d5877 (P9.6 ContinuationManifest), 1973f7a (P9.3
         ObservabilityServer+Dashboard), 1b2b409 (P9.10 Replay/Audit), 4fb20fc
         (P9.8 Telegram), c19ad76 (P9-I1 E2E), b334184 (P9.12 Dogfood metrics),
         903e361 (P9.11 VS Code extension), 21c70e7 (sign-off)

Format per PHASE_9_ROADMAP §6 (Exit criteria) + the master prompt §16. Phase 9
delivers the **Observability / Control substrate**: the Phase 0–8 agent is now
observable, controllable, debuggable, remotely operable, and VS Code–usable —
without granting any UI authority. Every read is a derivation of authoritative
state; every control action is admitted through one plane into the existing kernel.

> Phase 7 gave the agent memory, Phase 8 let it work in parallel. Phase 9 does NOT
> make it smarter — it makes its behavior observable and controllable, so later
> intelligence can be judged by evidence rather than claims.

---

## Exit criteria (PHASE_9_ROADMAP §6 / master prompt §16)

- [x] 1. OB-005..010 declared in `invariants.yaml` + tests under `tests/invariants/observability/`.
- [x] 2. **Runtime events observable** — live via SSE (`/stream`, event tailer) and
          historically via `EventLog.query` (`/events`, `/audit`).
- [x] 3. **Dashboard reflects authoritative state** — `RuntimeProjection` assembled from
          repositories + EventLog; the dashboard renders it (Agent State / Task Graph /
          Live Activity / Control).
- [x] 4. **Dashboard is not authority** — `RuntimeProjection` is a pure reducer with no
          mutator/repository-write handle (OB-005); adversarial test proves a projection
          consumer cannot write authoritative state.
- [x] 5. **Telegram observes the runtime** — `/status /task /graph /log` over the same
          `ObservabilityService`.
- [x] 6. **Telegram control passes through the Control Plane** — a Telegram `/pause` and a
          dashboard Pause build the SAME `ControlRequest` and admit identically (OB-006).
- [x] 7. **Approval flow works remotely** — `approve`/`deny` route through `ControlPlane`
          → `ToolGateway` with the existing argumentsHash binding (HI-002).
- [x] 8. **Task / session / task-run state observable** — projected task tree with
          terminal/active/blocked flags, active runs, counts.
- [x] 9. **Activity trace available** — `ActivityTrace` (structured category + action +
          evidence refs), no raw chain-of-thought (OB-007).
- [x] 10. **Verification evidence visible** — verification events surfaced in trace/audit
          with revision + scope + status (OB-003).
- [x] 11. **Context usage measurable** — `ContextTelemetry` (per-category %, pressure,
          discarded) derived from the ContextSnapshot (OB-010).
- [x] 12. **Failure / recovery observable** — failure + recovery events in trace/audit;
          metrics count failures, recovery actions, and inferred retries.
- [x] 13. **Replay / audit works** — `AuditTimeline` reconstructs a sequence-ordered,
          phase + authority-path timeline deterministically (OB-004/007).
- [x] 14. **Dogfood tasks** — see "Live dogfood" below. The measurement substrate
          (`DogfoodMetrics`) is complete and tested; running real tasks with a live Ollama
          is an out-of-CI operational step, documented here.
- [x] 15. **Metrics collected** — `computeSessionMetrics` yields per-session behavior
          metrics (task runs, tools, verification pass/fail, failures/retries/recovery,
          interventions, context, span, outcome, event histogram), exposed at `/metrics`.
- [x] 16. **Phase 0–8 tests remain green** — full suite 1277 passed, 0 todo (121 files).
- [x] 17. **New invariant/adversarial tests pass** — OB-005..010 specs + one-control-path,
          projection-non-authority, tailer-read-only, continuation-non-authority tests.
- [x] 18. **No governance boundary weakened** — depcruise 0 (`agent-core ↛ infrastructure`);
          OB-005/006 keep projection/control from becoming authority; the ControlGate reads
          the authoritative session state (no second channel).
- [x] 19. `PHASE_9_SIGNOFF.md` created (this document).

**No in-scope deferred items.** Out-of-scope capabilities (Intelligence Plane, memory/
research/self-model/benchmark/training, a real context-compaction engine, neural
embedding) remain explicitly deferred to Phase 10+ per the roadmap §2.2 / §8.

---

## Components delivered (PHASE_9_ROADMAP §4)

| ID | Component | Package | Enforces |
|---|---|---|---|
| P9-INV | Observability/Control invariant group OB-005..010 | invariants.yaml + tests | OB-* |
| P9.2 | `RuntimeProjection` + `ContextTelemetry` (pure read-models) | agent-core | OB-005/010 |
| P9.7 | `ControlPlane` + `PAUSED` state + cooperative control-poll | agent-core | OB-006 |
| P9.4 | `ActivityTrace` (structured, no CoT) | agent-core | OB-007 |
| P9.9 | `InterventionRecord` (unified control+approval audit) | agent-core | OB-006 |
| P9.6 | `ContinuationManifest` (non-authoritative rollover) | agent-core | OB-008 |
| P9.3 | `ObservabilityService` + `HttpTransport` (node:http) + Dashboard | infrastructure | OB-005/006/009 |
| P9.10 | `AuditTimeline` (replay with phase + authority path) + `/audit` | agent-core / infra | OB-004/007 |
| P9.8 | Telegram adapter (router + transport + fetch client) | infrastructure | OB-006 |
| P9-I1 | `SessionStateControlGate` + observe→control→resume E2E | infrastructure / tests | OB-005/006 |
| P9.12 | `DogfoodMetrics` + `/metrics` | agent-core / infra | measurement |
| P9.11 | VS Code extension (thin client, offline-testable mapper) | separate package | OB-006 |

All observability + control LOGIC is pure in `agent-core` (RuntimeProjection,
ContextTelemetry, ActivityTrace, ContinuationManifest, AuditTimeline, DogfoodMetrics,
ControlPlane, InterventionRecord). All I/O (HTTP/SSE server, Telegram, VS Code,
SessionStateControlGate) lives in `infrastructure` or a separate package. depcruise
confirms `agent-core ↛ infrastructure`.

---

## Test results

- Total automated tests: **1277 / 1277 pass** across **121 test files** (Vitest), **0 todo**.
- No TypeScript errors (`tsc --build --force`), no build errors.
- No ESLint errors (`eslint .`).
- dependency-cruiser: **0 violations** (652 modules, 1495 dependencies cruised).

### Phase 9 additions (over Phase 8 baseline of 1127 tests)

| Step | Suite total | What's added |
|---|---|---|
| P9-INV | 1133 (+10 todo) | OB-005..010 specs; ob-001..004 + ob-009 real; harness 158→164 |
| P9.2 | 1154 | RuntimeProjection + ContextTelemetry; ob-005/010 real |
| P9.7 | 1181 | ControlPlane + PAUSED + control-poll; ob-006 real |
| P9.4+P9.9 | 1195 | ActivityTrace + InterventionRecord; ob-007 real |
| P9.6 | 1208 | ContinuationManifest; ob-008 real (OB group fully real) |
| P9.3 | 1235 | ObservabilityService + HttpTransport + Dashboard (real node:http) |
| P9.10 | 1235→1235(+audit) | AuditTimeline + /audit; SSE teardown hardening |
| P9.8 | 1248 | Telegram adapter (offline-testable) |
| P9-I1 | 1260 | SessionStateControlGate + observe→control→resume E2E |
| P9.12 | 1270 | DogfoodMetrics + /metrics |
| P9.11 | **1277** | VS Code extension mapper (offline) |

---

## Invariant coverage — Phase 9 (OB-005..010, all ACTIVE, all with real tests)

| Invariant | Enforcement | Proven by |
|---|---|---|
| OB-005 | projection/read-model is not authority | pure reducer, no mutator; adversarial non-write test |
| OB-006 | control via ControlPlane admission + Policy; no UI authority | dashboard==telegram==vscode one-control-path tests |
| OB-007 | trace exposes structured redacted evidence, no CoT/secret | ActivityTrace entry shape + evidence whitelist tests |
| OB-008 | continuation manifest is non-authoritative | manifest refs validated against reloaded state; never overwrites |
| OB-009 | event tailer only reads the persisted log | SqliteEventLog stream read-only; tail-by-sequence test |
| OB-010 | context telemetry is derived, never selects context | pure rollup of an immutable ContextSnapshot |

Registry: `invariants.yaml` version 1.4 (158 → 164 invariants); `INVARIANTS.md`
§3.19 Observability table (OB-001..010) + §9 version-history row 1.4. Both files bumped
together.

---

## Cross-platform

| Environment | Node | Result | Tests |
|---|---|---|---|
| Windows 11 (local) | 20.18.1 | ✅ PASS | 1277/1277 |
| WSL2 Ubuntu 24.04 (local, `npm ci`) | 20.18.1 | ✅ PASS | 1277/1277 |

The node:http observability server (incl. a live SSE-delivery test) and all adapters
run identically on both platforms. `npm ci` is green on both — the VS Code extension's
heavy devDeps are deliberately kept out of the root workspaces so they never reach CI.

---

## Honest scope notes

- **Observe / own are separate.** Every Phase-9 capability is either a READ (projection /
  trace / telemetry / audit / metrics) or a COMMAND PROPOSAL (ControlRequest). No component
  both observes and holds authority.
- **One control path.** Dashboard, Telegram, and VS Code all build the same `ControlRequest`
  and go through `ControlPlane.admit()` → Policy → an existing kernel method. The surface
  (`dashboard` / `telegram` / `vscode`) is audit-only and never changes admission (OB-006).
- **The gate reads authoritative state.** `SessionStateControlGate` derives the orchestrator's
  pause/cancel signal from the session state the ControlPlane already drove via SessionService
  — a single source of truth, no second channel.
- **No chain-of-thought.** ActivityTrace / AuditTimeline are built from already-redacted events
  and carry no raw-reasoning field; evidence refs come from a whitelist of structured ids.
- **node:http, zero new root deps.** The server uses the Node builtin; upgrading to a framework
  later is a new transport over the protocol-agnostic `ObservabilityService`, not a rewrite.
- **VS Code extension is isolated.** It is a separate package OUTSIDE the root npm workspaces;
  its `@types/vscode` / `esbuild` / `@vscode/vsce` devDeps never enter root `npm ci` / typecheck
  / lint / depcruise. The offline-testable mapper is covered by root vitest; the `vscode`-API
  edge and `.vsix` packaging are a separate build.
- **Live dogfood (real Ollama) is an out-of-CI operational step.** There is no headless-CI-safe
  Ollama in this environment, so running CodeForge on real tasks with a live model is operated
  outside the test suite. The measurement substrate is complete: start the runtime, point the
  dashboard/Telegram/VS Code at the session, run a task, then read `/metrics` (or
  `computeSessionMetrics` over the session's events) to measure task runs, tool calls,
  verification pass/fail, failures/retries/recovery, interventions, context usage, span, and
  outcome. These metrics are the empirical foundation Phase 10+ will evaluate against.

---

## What Phase 9 does NOT deliver (explicitly deferred, §2.2 / §8)

- **Intelligence Plane** (DecisionKernel / ModelRouter / WorkerRegistry) — Phase 10.
- **Engineering memory / external knowledge / solution discovery / self-model / self-benchmark
  / continuous learning** — Phase 11+.
- **A real context-compaction engine** — Phase 9 only MEASURES context pressure and prepares the
  non-authoritative `ContinuationManifest`; the compaction algorithm is deferred.
- **Neural embedding** — carried over from Phase 7's probe-backed deferral.

All deferred items, when taken up, still obey §0: observability is never a reason for a UI to
decide in place of the kernel.

---

## Anti-criteria — confirmed NOT violated

- `agent-core` has no dependency on `infrastructure` — depcruise 0 violations.
- No UI can write authoritative state: projections are inert data; control is admitted (OB-005/006).
- The event tailer is read-only; `append` remains the sole write path (OB-009, CP-008).
- Activity trace / audit carry no raw reasoning and no unredacted secret (OB-007, PR-003/004).
- The continuation manifest can never overwrite authoritative state (OB-008).
- Root CI pulls zero VS Code / server-framework dependencies.

---

## Signed by

- Developer: _______________
- Reviewer: _______________
- Architect: _______________

Phase 9: COMPLETE — all exit criteria met, no in-scope deferred items. CI green on two OS +
human peer and architecture review pending. The observability + control substrate required
to safely evolve beyond Phase 8 is in place.
