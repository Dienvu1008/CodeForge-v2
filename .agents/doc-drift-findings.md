# Documentation Drift Findings — CodeForge v2

Read-only audit. No files were modified. Evidence cites files/symbols/line numbers as of commit `f295481` (HEAD, "P12.27"). Phases P12.13–P12.27 are all committed; the docs were last substantively edited around 2026‑09‑14/15 and have not caught up to P12.24–P12.27.

Finding format: **DOC → section → what it says → what the code is → SEVERITY** (HIGH = wrong/misleading, MEDIUM = incomplete, LOW = cosmetic).

---

## Summary answer (read this first)

1. **INVARIANTS.md version header is 1.10 but its own changelog (§9 "Lịch sử") stops at 1.4 / Phase 9.** Everything from Phase 10 → 12 (verification‑policy builder, Learning plane LE‑*, Mission plane MI‑*, the RECOVERY_POLICY_VERSION bump to 2, ROLLBACK) is implemented and even described in the body tables, but there is **no changelog row** for versions 1.5–1.10. The version number and the history table disagree with each other. **HIGH.**

2. **Recovery invariants RC‑004 / RC‑005 are understated vs. the code.** `recovery-policy.ts` now ships `RECOVERY_POLICY_VERSION = 2` and a SYNTAX policy ordering `FIX → ROLLBACK → ESCALATE` with `rollbackAllowed: true` (P12.14). ROLLBACK is a *real* executed action in `recovery-engine.ts` (`shouldRollback`), no longer the "Phase 5.5 placeholder" the engine's own error enum still references. The RC‑004 invariant statement is still correct in spirit but neither INVARIANTS.md nor invariants.yaml records the policy‑version bump or that ROLLBACK is now live. **MEDIUM.**

3. **invariants.yaml and INVARIANTS.md agree on IDs/statements/versions** (both `version: 1.10`, same RC‑001..008 statements). The drift is that *both* lag the code's RECOVERY_POLICY_VERSION=2 and both share the stale changelog problem (the yaml has no changelog, INVARIANTS.md's is stale). **LOW/MEDIUM.**

4. **ARCHITECTURE_DIAGRAMS.md (Version 1.1, changelog ends 2026‑09‑14) is STALE.** It predates three whole planes/features that now exist in code: the **Mission Intelligence** layer (`packages/agent-core/src/mission/`), the **Learning/Intelligence** plane (`packages/agent-core/src/learning/`), **language inference** (`planning/language-inference.ts`, P12.24), and **multi‑language verification** (`verification/verification-policy-builder.ts`, P12.25). None of the 12+ diagrams show them. **HIGH** (the diagrams claim to be the honest component map, and MI/LE are entire planes with their own invariant groups MI‑*/LE‑*).

5. **VERIFICATION_PROTOCOL.md still describes npm/tsc‑only verification.** P12.25 added real Dart/Flutter/Rust/Go/Python/C++ checks (`buildVerificationPolicy`), but the protocol doc only hints `language?: string // 'typescript' | 'dart' | ...` and documents no multi‑language check matrix. **HIGH** (directly relevant to the user's reported TypeScript‑bias problem).

6. **README.md is MINOR→MODERATE drift:** it describes the VS Code extension as a "thin HTTP client … no graph view" and the product surface as "minimal," which is now contradicted by P12.18–P12.23 (native tree views, editor diff, approval notification, Goals panel, model picker, task‑graph DAG). It also has no mention of multi‑language support. **MEDIUM.**

7. **PROJECT_STATUS.md is mostly CURRENT through P12.23** (it documents ROLLBACK, dashboard DAG/diff/governance/approval, native VS Code UI, Gemini, LSP registry) **but** (a) does **not** reflect P12.24 language inference, P12.25 multi‑language verification, or P12.26/P12.27 multi‑language benchmarks, (b) has an **internal contradiction** — line 123 says task‑graph visualization is "DONE (P12.18)" while line 196 still says "Product surface is minimal … no graph view", and (c) its header still reads "1569 tests / 2026‑09‑15". **MEDIUM.**

---

## 1. INVARIANTS.md + invariants.yaml

### 1.1 Version/changelog drift — HIGH
- **DOC → header + §9 Versioning Policy / Lịch sử**
- **What it says:** `Version: 1.10` (INVARIANTS.md header line 7; invariants.yaml line 13 `version: 1.10`). The changelog table in §9 lists rows only up to **1.4 (2026‑09‑14, Phase 9 observability OB‑005..010)**. There are no rows for 1.5, 1.6, 1.7, 1.8, 1.9, 1.10.
- **What the code is:** The body of INVARIANTS.md already contains **§3.23 Learning (LE‑001..008)** and **§3.24 Mission Intelligence (MI‑001..008)** — i.e. Phase 11 and Phase 12 invariant groups — and the corresponding code exists (`packages/agent-core/src/learning/`, `packages/agent-core/src/mission/`). So the registry grew well past 1.4, but the "Lịch sử" table never recorded 1.5→1.10.
- **Severity: HIGH** — the version field and the document's own change history are mutually inconsistent; a reader cannot tell what changed in 1.5–1.10 or why the number is 1.10.

### 1.2 RC‑004 ROLLBACK + RECOVERY_POLICY_VERSION bump not recorded — MEDIUM
- **DOC → §3.16 Recovery table, RC‑004; §8 Phase Gate Mapping**
- **What it says:** RC‑004 = "ROLLBACK chỉ được thực hiện khi policy cho phép" (enforcement `RecoveryEngine`, Phase 5, CRITICAL). invariants.yaml RC‑004 identical. No mention of policy versioning or that ROLLBACK became a live action in P12.14.
- **What the code is:** `packages/agent-core/src/recovery/recovery-policy.ts` defines `export const RECOVERY_POLICY_VERSION = 2;` with a comment "v2: SYNTAX now FIX→ROLLBACK→ESCALATE with rollbackAllowed=true (was FIX→REPLAN→ESCALATE)". `DEFAULT_RECOVERY_POLICY.SYNTAX = { actions: ['FIX','ROLLBACK','ESCALATE'], maxAttempts: 3, rollbackAllowed: true }`. `recovery-engine.ts` implements a real `ROLLBACK` case returning `shouldRollback: true` (caller reverts via a `WorkspaceRollback` port). PROJECT_STATUS.md lines 48–49, 169–186 corroborate this is live (P12.14).
- **Note:** RC‑004's *statement* is still accurate (ROLLBACK only when `rollbackAllowed`), but the invariant metadata gives no hint that the default policy now actually exercises ROLLBACK, nor that there is a versioned policy (v2). The enforcement attribution is slightly off: the **guard** that blocks disallowed ROLLBACK lives in `recovery-policy.ts` `decide()` (RC‑004 comment there), while the invariant names only `RecoveryEngine`.
- **Severity: MEDIUM** (incomplete, not wrong).

### 1.3 RC‑005 REPLAN "deferred" language elsewhere — LOW
- RC‑005 statement ("Replanning phải tạo GraphMutation, không overwrite graph") matches `recovery-engine.ts` REPLAN behavior (SUPERSEDE via GraphCommit). This invariant is **CURRENT**. Flagged only because `recovery-engine.ts`'s `RecoveryEngineError` enum still carries dead `'ROLLBACK_NOT_IMPLEMENTED'` / `'REPLAN_NOT_IMPLEMENTED'` codes with "Phase 5.5 — placeholder" comments, which are misleading given both are now implemented. That is a **code** comment staleness, not a doc invariant mismatch. **LOW.**

### 1.4 yaml ↔ md agreement — OK (LOW)
- Spot‑checked SS/GL/TI/GI/RC groups: IDs, statements, phases, severities match between INVARIANTS.md tables and invariants.yaml. Both say `version: 1.10`. The one systemic issue is that invariants.yaml has **no changelog** and INVARIANTS.md's is stale — so neither is a reliable record of 1.5→1.10. **LOW** on divergence; the real issue is 1.1 above.

---

## 2. ARCHITECTURE_DIAGRAMS.md

Header: `Version: 1.1`, changelog §14.5 last row `1.1 | 2026‑09‑14`. It advertises "**12 diagrams**" (§0) plus a bonus (#13) and claims (§15 North Star) that a good diagram "must be honest." Measured against `packages/agent-core/src` + `packages/infrastructure/src`:

### 2.1 Mission Intelligence plane entirely absent — HIGH
- **What it says:** The 5‑Plane Overview (Diagram 1) names Control / Intelligence / Execution / Verification / Evidence planes. Nothing represents a pre‑execution Mission Intelligence stage.
- **What the code is:** `packages/agent-core/src/mission/` is a full module: `mission-intelligence.ts`, `mission-intake.ts`, `complexity-analyzer.ts`, `risk-analyzer.ts`, `capability-discovery.ts` / `capability.ts`, `model-router.ts`, `planning-router.ts`, `architecture-gate.ts`, `mission-architect.ts`, `expert-profile.ts`, `prompt-composer.ts`, `mission-context-strategy.ts`, `assumption-advisor.ts`, `uncertainty-analyzer.ts`. It has its own invariant group **MI‑001..008** in INVARIANTS.md §3.24, and a matching infra package `packages/infrastructure/src/mission/`. PROJECT_STATUS.md §"Mission Intelligence (Phase 12)" documents it as wired (`--mission on`).
- **Severity: HIGH** — a whole plane with CRITICAL invariants and an ArchitectureGate that can BLOCK → AWAITING_HUMAN is invisible in the "authoritative" component map.

### 2.2 Learning / Intelligence plane absent — HIGH
- **What it says:** No diagram shows a learning/advisory layer. Diagram 3 (Intelligence Plane) stops at Planner/Critic/Replanner/FailureAnalyzer.
- **What the code is:** `packages/agent-core/src/learning/`: `advice-gate.ts`, `self-model-builder.ts`, `lesson-writer.ts`, `recovery-advisor.ts`, `no-progress-advisor.ts`, `context-reranker.ts`. Invariant group **LE‑001..008** (INVARIANTS.md §3.23) and infra `packages/infrastructure/src/learning/`. `recovery-policy.ts` `decide()` explicitly consumes `SafeRecoveryOrderAdvice` from this layer (P11.4).
- **Severity: HIGH** (undocumented plane that feeds recovery ordering).

### 2.3 Language inference not shown — HIGH (user‑relevant)
- **What it says:** Planning Flow (Diagram 9) goes User→Planner→Validator→Critic→GraphCommit with no language/target‑language step.
- **What the code is:** `packages/agent-core/src/planning/language-inference.ts` (P12.24) is a pure module producing a `LanguageHint` (`LanguageId` incl. dart/rust/go/cpp/mql5/python…) from workspace manifests/extensions and goal keywords, surfaced into the planning prompt to remove the TypeScript default bias. This is exactly the mechanism addressing the user's "harness always emits .ts" complaint.
- **Severity: HIGH** — the fix for the reported bias is undocumented in the architecture map.

### 2.4 Multi‑language verification not shown — HIGH
- **What it says:** Verification Plane (Diagram 5) shows generic "Run checks" with no language dimension; implies a single toolchain.
- **What the code is:** `verification/verification-policy-builder.ts` (P12.25) builds checks per detected manifest: Dart/Flutter (`dart/flutter analyze`+`test`), Rust (`cargo build`+`cargo test`), Go (`go build`+`go test ./...`), Python (`python -m compileall` + `pytest`), C++ (`cmake configure`+`build`). `ProjectSignals` has `hasPubspec/isFlutter/hasCargoToml/hasGoMod/hasPython/hasPytest/hasCMake`.
- **Severity: HIGH.**

### 2.5 Observability server / dashboard under‑ or mis‑represented — MEDIUM
- **What it says:** Diagram 1 Evidence Plane lists `RuntimeProjection`/`EventLog`; there is no dashboard/HTTP‑server/SSE component, no task‑graph DAG, diff transcript, governance timeline, or approval banner.
- **What the code is:** `packages/infrastructure/src/observability-server/` exists (serves the dashboard + `/control` + SSE; DAG P12.18, changes/diffs P12.19, governance P12.20, approval banner P12.21 per PROJECT_STATUS.md lines 119–123). OB‑005..010 invariants cover it.
- **Severity: MEDIUM** (the plane concept is present, the concrete surface is not).

### 2.6 VS Code extension misrepresented — MEDIUM
- **What it says:** Diagrams reference "USER / VS Code" and an "Approval UI" generically. Nothing reflects the native extension's tree views (Sessions/Task‑Graph/Governance/Changes), native `vscode.diff` review, native approval notification, Goals panel, model picker, or Start‑Runtime‑Here.
- **What the code is:** `packages/vscode-extension/` (P12.22–P12.23). PROJECT_STATUS.md line 121 documents it as native UI.
- **Severity: MEDIUM.**

### 2.7 Items that are still accurate (no action)
- Diagram 11 Recovery Flow lists `RETRY/FIX/SPLIT/REPLACE/ROLLBACK/REPLAN/ESCALATE/ABORT` — these all exist as `RecoveryKind` in `packages/agent-core/src/domain/failure.ts`. ROLLBACK/REPLAN/DEP_UNREACHABLE/NoProgress depiction matches code. **CURRENT.**
- Diagrams 2/6/7/8/13 (authority, evidence persistence, dependency direction, trust boundary, invariant map) still match the kernel. **CURRENT** (aside from the missing MI/LE planes).

---

## 3. Other top‑level spec docs — one‑line verdicts

| Doc | Verdict | Most important discrepancy |
|---|---|---|
| **VERIFICATION_PROTOCOL.md** (v1.0) | **STALE** | Describes npm/tsc‑centric verification only; `language?` is a bare comment `'typescript' \| 'dart' \| ...` (§9.1 ~line 617) with **no** Dart/Rust/Go/Python/C++ check matrix that `verification-policy-builder.ts` (P12.25) actually implements. |
| **STATE_MACHINE_SPEC.md** (v1.0) | **MINOR‑DRIFT** | Core SM‑001..006 transitions still match; does not mention the recovery‑driven ROLLBACK re‑arm path (P12.14) or Mission ArchitectureGate → AWAITING_HUMAN entry, though those are arguably recovery/mission concerns. |
| **DOMAIN_CONTRACTS.md** (v1.0) | **MINOR‑DRIFT** | Domain entities (Task/Graph/TaskRun/VerificationReport/RecoveryAction) still match code; `RecoveryKind` now includes ROLLBACK/REPLAN as live actions — verify the contract lists the full 8‑member union and notes `RecoveryOutcome` `PENDING`. |
| **GRAPH_PROTOCOL.md** (v1.0) | **CURRENT** | SUPERSEDE/validation/atomic‑commit semantics match `recovery-engine.ts` REPLAN (SUPERSEDE_TASK) and GraphCommit. No material drift found in the header scan. |
| **SECURITY_MODEL.md** (v1.0) | **CURRENT** | Trust boundaries (SE‑*/model‑untrusted) unchanged; MI‑008 ("ExpertProfile/LLM content is untrusted prompt‑context") is consistent with the model. No contradiction found. |
| **PROJECT_STATUS.md** (hdr 2026‑09‑15) | **MINOR‑DRIFT** | Current through P12.23 (ROLLBACK, dashboard, native VS Code, Gemini, LSP) but **omits P12.24 language inference, P12.25 multi‑language verification, P12.26/27 multi‑language benchmarks**; internal contradiction: line 123 "task‑graph visualization DONE (P12.18)" vs line 196 "Product surface is minimal … no graph view"; stale "1569 tests" count. |
| **README.md** | **MINOR‑DRIFT** | Calls the VS Code extension a "thin HTTP client … no graph view" and product surface "minimal" (lines ~61, 222‑224, 287, 307) — contradicted by native extension + dashboard DAG. No mention of multi‑language support or the TS‑bias fix. |
| **ROADMAP.md** (hdr 2026‑09‑14) | **MINOR‑DRIFT** | Header predates P12.9+; product trajectory still broadly valid but does not list multi‑language/language‑inference as shipped. |

---

## 4. Conclusions & recommendations (implement nothing — for the fix step)

Priority‑ordered:

1. **INVARIANTS.md changelog (HIGH).** Add the missing 1.5→1.10 rows to §9 "Lịch sử": at minimum P10 (VerificationPolicyBuilder / TI‑005 made real), P11 LE‑001..008, P12 MI‑001..008, and the P12.14 note "RECOVERY_POLICY_VERSION bumped to 2; SYNTAX = FIX→ROLLBACK→ESCALATE, rollbackAllowed=true". Keep the header at the version the final row states.

2. **ARCHITECTURE_DIAGRAMS.md (HIGH).** Add (or extend) diagrams for the **Mission Intelligence** stage (intake→classify→capability‑verify→model‑route→architecture‑gate, all advisory; gate can BLOCK→AWAITING_HUMAN), the **Learning** advisory layer feeding RecoveryPolicy ordering, a **language‑inference** node in the Planning Flow, and a **per‑language** branch in the Verification Plane. Add the observability‑server/dashboard + native VS Code extension surface. Bump to v1.2 with a changelog row.

3. **VERIFICATION_PROTOCOL.md (HIGH).** Replace the npm/tsc‑only framing with the real detection→check matrix from `verification-policy-builder.ts` (manifest signals → ordered build/analyze/test per language), and document the "0 checks ⇒ never PASSED" guard.

4. **PROJECT_STATUS.md (MEDIUM).** Add rows for P12.24/25/26/27 (language inference, multi‑language verification, multi‑language + MQL5 benchmark cases), resolve the line‑123‑vs‑196 "no graph view" contradiction, and refresh the test count/date header.

5. **README.md (MEDIUM).** Update the VS Code extension description to "native extension (tree views + diff + approval + Goals + model picker + Start‑Runtime‑Here)", drop "no graph view / minimal surface", and add a line on multi‑language goal support + language inference (the user's reported concern).

6. **ROADMAP.md (LOW/MEDIUM).** Move multi‑language + language inference from "next" to "shipped"; refresh the header date.

7. **Code hygiene (LOW, out of scope of a doc fix but noted):** the dead `ROLLBACK_NOT_IMPLEMENTED` / `REPLAN_NOT_IMPLEMENTED` "Phase 5.5 placeholder" codes/comments in `recovery-engine.ts` are now false and could be removed when that file is next touched.

### Verification caveat
This report is from read‑only inspection of source and docs. I read the full text of INVARIANTS.md, invariants.yaml (truncated at ~CP‑012 but all RC statements were read), ARCHITECTURE_DIAGRAMS.md, recovery‑policy.ts, recovery‑engine.ts, verification‑policy‑builder.ts, language‑inference.ts, and the headers + targeted greps of the remaining spec docs. I did **not** build/run tests (read‑only brief). Line numbers for README/PROJECT_STATUS come from grep and may shift by a line or two.
