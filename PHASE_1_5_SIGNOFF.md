# Phase 1.5 Sign-off — Verification, ToolGateway & Security Boundary

Date: 2026-09-14
Commit: _______________ (P1.5-I3/signoff commit on `main`)
Branch: main

Format per PHASE_1_5_ROADMAP §7 (Exit criteria). Phase 1.5 delivers the
**safety layer** on top of the Phase 1 runtime kernel: a task cannot PASSED
without real verification evidence (TI-005), tool calls cannot execute without
passing through ToolGateway (TG-001), and model output is structurally untrusted
(SE-010). No LLM, no VS Code UI, no real ToolGateway filesystem execution
(ProcessSupervisor is the boundary; real tool impls are Phase 2+).

---

## Exit criteria (PHASE_1_5_ROADMAP §7)

- [x] 1. All §4 components implemented (P1.5-PS1 .. P1.5-I3) — see component table below.
- [x] 2. **29 CRITICAL Phase-1.5 invariants** upheld — behavioral coverage mapped below.
- [x] 3. TI-005 enforced: task CANNOT transition VERIFYING→PASSED without a VerificationReport PASS + fresh.
- [x] 4. E2E P1.5-I1 (VerificationEngine lifecycle) pass.
- [x] 5. E2E P1.5-I2 (ToolGateway lifecycle) pass.
- [x] 6. E2E P1.5-I3 (adversarial security) pass.
- [x] 7. ProcessSupervisor timeout and tree-kill on Windows + WSL2 proven (P1.5-PS1 tests).
- [x] 8. No TypeScript error / ESLint error / dependency-cruiser violation.
- [ ] 9. CI green on 2 OS — pending signoff-commit CI run (check off once green).
- [x] 10. `PHASE_1_5_SIGNOFF.md` created (this document).

> Item 9 is the only box left open: it is confirmed per-step as work progressed;
> the signoff-commit CI run is checked off once green.

---

## Components delivered (PHASE_1_5_ROADMAP §4)

| ID | Component | Primary invariants |
|---|---|---|
| P1.5-PS1 | ProcessSupervisor contract (agent-core) + NodeProcessSupervisor (infrastructure) + FakeProcessSupervisor (testing) | SE-007, SE-008, TG-010 |
| P1.5-DB2 | Schema migration v2 — `approvals`, `failures`, `recovery_actions` tables | CP-001, CP-007 |
| P1.5-SE1 | StructuredOutputValidator, PromptBoundary, EnvGuard | SE-001, SE-002, SE-003, SE-010, SE-004 |
| P1.5-TG1 | ToolGateway + ToolPolicy + ToolCallStateMachine + SqliteToolCallRepository | TG-001..005, TG-007, TG-009, TG-010 |
| P1.5-TG2 | ApprovalEngine + HumanOverride domain type + SqliteApprovalRepository | HI-001..004, TG-003, TG-004 |
| P1.5-VR1 | VerificationPolicy, AffectedSetComputer, FreshnessChecker, ScopeComputer, VerificationEngine | VR-001..008, VR-011, VR-010, TI-005 |
| P1.5-VR2 | CompletionGate (TI-005 northstar) + FakeRevisionProvider (testing) | TI-005, VR-002, VR-004 |
| P1.5-I1 | VerificationEngine E2E (FakeProcessSupervisor) | TI-005 end-to-end |
| P1.5-I2 | ToolGateway E2E (auto-approve, approval path, DENIED, timeout) | TG-001..005, TG-010, HI-001/002 |
| P1.5-I3 | Adversarial Security E2E (MaliciousVerifier, MaliciousToolProposal, PromptInjection, SE-010) | TI-005, TG-007, SE-001/002, SE-010 |

---

## Test results

- Total automated tests: **584 / 584 pass** across **46 test files** (Vitest).
- No TypeScript errors (`tsc --build --force`), no build errors (`tsc --build`).
- No ESLint errors (`eslint .`).
- dependency-cruiser: **0 violations** (407 modules, 861 dependencies cruised).

### Suite breakdown (Phase 1.5 additions)

| Area | Files | Notes |
|---|---|---|
| ProcessSupervisor (PS1) | 1 | FakeProcessSupervisor, NodeProcessSupervisor real-subprocess, migration v2 |
| Security boundary (SE1) | 1 | StructuredOutputValidator, PromptBoundary, EnvGuard — 54 tests |
| ToolGateway (TG1) | 1 | FSM 12 + policy 8 + gateway request/approve/deny/execute + persistence |
| ApprovalEngine (TG2) | 1 | createApproval, verifyApproval, recordOverride — HI-001..004 |
| VerificationEngine (VR1/VR2) | 1 | scope, affected set, freshness, pipeline, CompletionGate — 36 tests |
| Integration E2E (I1/I2/I3) | 3 | verification lifecycle, tool gateway lifecycle, adversarial |

---

## Invariant coverage — 29 CRITICAL Phase-1.5

Coverage is behavioral (component + E2E tests). All 29 CRITICAL invariants are exercised.

| Group | # | IDs | Where proven |
|---|---|---|---|
| Task completion (TI) | 1 | TI-005 | `completion-gate.ts` + `tests/verification/` + `tests/integration/verification-e2e.spec.ts` |
| ToolGateway (TG) | 8 | TG-001..005, TG-007, TG-009, TG-010 | `tool-gateway.ts` + `tool-policy.ts` + `tests/tool/tool-gateway.spec.ts` + `tests/integration/tool-gateway-e2e.spec.ts` |
| Verification (VR) | 9 | VR-001..008, VR-011 | `verification-engine.ts` + `completion-gate.ts` + `tests/verification/` + `tests/integration/verification-e2e.spec.ts` |
| Security (SE) | 6 | SE-001, SE-002, SE-003, SE-005, SE-009, SE-010 | `security/` module + `tests/security/` + `tests/integration/adversarial-security-e2e.spec.ts` |
| HumanInteraction (HI) | 4 | HI-001..004 | `approval-engine.ts` + `tests/tool/approval-engine.spec.ts` + `tests/integration/tool-gateway-e2e.spec.ts` |
| Provenance (PR) | 1 | PR-004 | `infrastructure/src/redaction/redactor.ts` (SE-005/PR-004 redaction already in place) |
| **Total** | **29** | — | — |

### Scope notes (honest gaps)

- **SE-005 / PR-004 (secret redaction)**: `Redactor` + `REDACTION_RULES` exist in `infrastructure/src/redaction/` from Phase 1. Phase 1.5 enforces redaction *structurally* (all event payloads go through `SqliteEventLog` which already applies `redactJson`). No new dedicated test was added because the infrastructure already satisfies the invariant. Dedicated unit tests for redaction edge cases remain in `infrastructure/redaction/` (Phase 1 baseline).
- **SE-003 ("LLM cannot bypass deterministic policy")**: structurally enforced — all policy decisions (`determineAction`, `transitionTask`, `canComplete`) are pure functions of runtime state, never LLM output. The adversarial E2E (P1.5-I3) demonstrates this end-to-end: MaliciousVerifier output does not change CompletionGate result.
- **VR-003/VR-008 (scratch-zone enforcement)**: the `VerificationEngine` compares R_before and R_after using `isFresh` and marks INVALID on hash drift (tested in `verification-engine.spec.ts`). Full scratch-zone declaration tracking (which mutations are in-scratch vs out-scratch) depends on ArtifactStore + ChangeRecord tracking at the ToolGateway level — those paths become richer in Phase 2 when real tool execution lands.
- **HIGH (8) invariants not in CRITICAL count**: TG-006, TG-008, VR-009, VR-010, SE-004, SE-006, OB-002, OB-003 — all HIGH. SE-004 (`EnvGuard`) and VR-010 (deterministic scope) are fully tested. TG-006 (idempotency key) and TG-008 (provenance) are modelled in the `ToolCall` domain type (field present) but enforcement hooks land in Phase 2 with real tool execution. SE-006 (network policy) and OB-002/003 are Phase 2.

---

## Cross-platform

- **Windows 11** (local): PASS — 584/584 tests, typecheck sạch, lint sạch, depcruise 0.
- **WSL2 Ubuntu 24.04** (local, Node 20.18.1): PASS — build + typecheck sạch, 584/584 identical.
- NodeProcessSupervisor timeout path proven on both platforms (Windows: `taskkill /F /T`, Linux: `kill(-pgid)`).
- **CI (GitHub Actions ubuntu-latest + windows-latest)**: green per-step; signoff-commit run pending (exit criterion 9).
- **macOS**: DEFERRED — per PLATFORM_SUPPORT.md.

---

## What Phase 1.5 does NOT deliver

Phase 1.5 delivers the **safety layer**; the runtime is still running with test doubles:

- No Ollama adapter / real LLM (Phase 2).
- No real filesystem tool execution (Phase 2) — `ToolExecutor` interface exists, `FakeProcessSupervisor` used.
- No `ArtifactStore` on disk (Phase 3) — artifact IDs are present in domain types but not stored.
- No RecoveryEngine (Phase 5) — `failures` and `recovery_actions` tables exist (schema v2) but no orchestration logic.
- No VS Code approval UI (Phase 3) — `ApprovalEngine` service is complete; UI binding is Phase 3.
- No NetworkPolicy enforcement (HIGH, Phase 2) — SE-006 deferred.
- No affected-set closure from LSP / Tree-sitter (Phase 6) — Phase 1.5 uses diff-based heuristic (AFFECTED_DIRECT).

---

## Anti-criteria — confirmed NOT violated

- No real Ollama/LLM in tests; no real tool execution (subprocess only via FakeProcessSupervisor).
- No test depends on wall-clock, random, or network; all `now`/`nextId` are injected.
- All tool-call executions go through `ToolGateway` — no direct spawn in domain code (TG-001).
- No state transition depends on raw model output (SM-006/SC-005/GI-009/MG-006/SE-003).
- No CRITICAL invariant skipped; applicable ones tested; not-yet-applicable ones documented above.
- Schema migrations are additive-only: v1 untouched, v2 adds tables (CP-007).

---

## Signed by

- Developer: _______________
- Reviewer: _______________
- Architect: _______________

Phase 1.5: COMPLETE — pending signoff-commit CI (exit criterion 9) + human peer + architecture review.
