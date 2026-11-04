# Implementation Plan: Kernel Shadow Ablation (enforcement vs log-only replay)

## Overview

Bottom-up and offline first: production-isolation scaffold → trace format, recorder, replayer →
decision ledger, sandbox and the enforcement-point observers → injection corpus → arm runner,
synthetic traces, comparison, report → Phase 2 tooling (recording flag, replay script, synthetic
report) → docs sync → full verification → the user-gated real Qwen3.5 run and its analysis.
Nothing under `packages/agent-core/src` changes; no dependency is added; shadow code lives only in
`packages/testing/src/shadow-ablation/` (subpath export) and the two benchmark scripts. All tasks
are required, including the tests (the experiment's credibility rests on them). Commit/push is done
by the main agent afterwards, following `.kiro/steering/commit-gate.md`.

## Tasks

- [x] 1. Production isolation scaffold
  - [x] 1.1 Scaffold the subpath, test config, ignore rule and dependency rule
    - `packages/testing/package.json`: add `exports["./shadow-ablation"]` (`types`
      `./dist/shadow-ablation/index.d.ts`, `import` `./dist/shadow-ablation/index.js`); no dependency change.
    - Create `packages/testing/src/shadow-ablation/index.ts` as an empty barrel with the header comment
      "measurement-only, never imported by production code (SA-001)"; do NOT touch `packages/testing/src/index.ts`.
    - `tests/tsconfig.json`: add `"shadow-ablation/**/*.ts"` to `include`.
    - `.gitignore`: add `.agents/traces/`.
    - `.dependency-cruiser.cjs`: add rule `no-production-to-testing` (severity error) from
      `^packages/(agent-core|infrastructure|vscode-extension)` to `^packages/testing`.
    - Run `npm run build` and `npm run depcruise` (0 violations).
    - _Requirements: 2.6, 6.1, 6.2, 11.5_
  - [x] 1.2 Export the core modules and add invariant SA-001
    - Barrel: export trace format, recorder, replayer, ledger, sandbox, observers, contained supervisor and
      injection corpus (modules from tasks 2.1–2.3, 3.1–3.5, 4.1).
    - Write `tests/invariants/shadow/sa-001.spec.ts`: scan `packages/agent-core/src`,
      `packages/infrastructure/src`, `packages/vscode-extension/src` for imports of `@codeforge/testing` or any
      `shadow-ablation` path; scan their `package.json` files for `@codeforge/testing`; allow `shadow-ablation`
      references in `scripts/` only in `run-shadow-ablation.mjs` and `run-progressive.mjs` (absent files are fine);
      assert that any `shadow-ablation` import in `run-progressive.mjs` names only `RecordingModelGateway` and
      `writeTraceFile` (no import at all is also valid, so the test passes before task 8.1); when
      `dist-cli/codeforge.cjs` exists, assert it contains none of the class names exported by
      `@codeforge/testing/shadow-ablation` (read the names dynamically from the module).
    - Add SA-001 to `INVARIANTS.md` and `invariants.yaml` (domain `shadow`, test path
      `tests/invariants/shadow/sa-001.spec.ts`, severity CRITICAL, status ACTIVE), matching the existing entry format;
      run the invariants/contracts suites that validate the yaml.
    - _Requirements: 6.1, 6.3, 12.4, 14.6_

- [ ] 2. Trace format, recording and replay
  - [x] 2.1 Implement `packages/testing/src/shadow-ablation/trace-format.ts`
    - `TRACE_FORMAT_VERSION`, `TraceWiring`, `TraceOutcome`, `TraceEntry`, `ModelTraceV1`, `TraceFormatError(file, field)`,
      `promptDigest` (SHA-256 of system + `\u0000` + task prompt), `serializeTrace` (stable key order), `parseTrace`
      (validation rules of design C1, first failing field path in the error). Pure, `node:crypto` only.
    - _Requirements: 2.1, 2.3, 2.4, 2.5_
  - [x] 2.2 Implement `RecordingModelGateway` and `writeTraceFile`
    - Design C2: forward unchanged, `identity` passthrough, `seq` reserved at call start, redaction of raw and error
      message via `redact` from `@codeforge/infrastructure`, `redacted` flag, `concurrent` flag on overlapping calls,
      rethrow the same `ModelError`, `trace()` snapshot, `writeTraceFile(dir, trace)` (mkdir -p, sanitized
      `<traceId>.trace.json`).
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 2.2, 2.3_
  - [x] 2.3 Implement `ReplayModelGateway`
    - Design C3: in-order serving, recorded errors rethrown, `REPLAY_EXHAUSTED` / `REPLAY_MISMATCH` as
      `ModelError('MODEL_UNAVAILABLE')` (sticky after a mismatch), Prompt_Drift recording, structural `InjectionAt`
      served before its `beforeSeq` on an execute request and tagged `injected`, `status()`; optional
      `DecisionLedger`-compatible step hook (`onStep(step, source, corpusId)`) so observers attribute entries.
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6_
  - [x] 2.4 Write `tests/shadow-ablation/trace-format.spec.ts`
    - Local seeded `mulberry32`, ≥100 iterations, tag `// Feature: kernel-shadow-ablation, Property N: <title>`.
    - **Property 1: Trace serialization round trip and validation**
    - **Property 2: No secret and no prompt text in a trace** (secrets generated per `REDACTION_RULES` shapes)
    - Examples: `concurrent` set on overlapping calls; `writeTraceFile` writes one file per session into a temp dir;
      `identity` passthrough.
    - **Validates: Requirements 1.3, 1.4, 1.5, 1.6, 2.1, 2.2, 2.3, 2.4, 2.5**
  - [x] 2.5 Write `tests/shadow-ablation/record-replay.spec.ts`
    - **Property 3: Recording is transparent and replay reproduces it** (inner = `FakeModel` sequences + `setError`)
    - **Property 4: Replay never invents behavior**
    - **Property 5: Injections are served exactly where planned**
    - Examples: drift recorded and the entry still served; `assertReplayable` refusal is covered in 6.7.
    - **Validates: Requirements 1.1, 1.2, 3.1, 3.2, 3.3, 3.4, 3.5, 3.6**

- [x] 3. Decision ledger, sandbox and enforcement-point observers
  - [x] 3.1 Implement `decision-ledger.ts` and `sandbox.ts`
    - Ledger types and `DecisionLedger` per design C4 (`argsPreview` = `redactJson` → JSON → 200 chars + `…`).
    - `createSandbox` (via `createIsolatedWorkspace`), `assertSandboxRoot` (strictly under `realpath(os.tmpdir())`,
      not equal to / containing `process.cwd()` or `CODEFORGE_REPO`), `isInsideSandbox` (resolve + realpath of the
      nearest existing ancestor, case-folded on win32), `destroySandbox`, `SandboxError`.
    - _Requirements: 4.1, 6.5, 7.1, 7.3, 10.8_
  - [x] 3.2 Implement `AblationWorkspaceManager` (EP-PATH + containment)
    - Design C6 decision table: Kernel `checkPath` + independent `isInsideSandbox` on every method; enforce rethrows
      the Kernel `WorkspaceError`; shadow records `wouldBlock` and returns simulated results with no filesystem access
      outside the sandbox; `kernelMiss` in both modes; content SHA-256 for simulated writes; `assertSandboxRoot` in the
      constructor.
    - _Requirements: 4.1, 4.3, 5.4, 6.5, 7.2, 7.3, 7.4_
  - [x] 3.3 Implement `AblationToolGateway`, `SHADOW_PASS_POLICY` and `ShadowApprovalCoordinator`
    - Design C7/C8: subclass `ToolGateway` (no agent-core edit), decision via `determineAction` with the enforced policy,
      `super.request` for everything else; enforce records from the returned state; shadow records `wouldBlock` and
      the EP-APPROVAL entry for pass-policy auto-approvals; EP-SCHEMA recorded on schema failure or once as inactive;
      `ShadowApprovalCoordinator` approves with `decidedBy: 'policy'` and records `approval_required`; deny-all
      coordinator for `approvalResolution: 'deny'`.
    - _Requirements: 4.1, 4.3, 4.5, 5.1, 5.2_
  - [x] 3.4 Implement `AblationToolExecutor`, `ALLOW_ANY_COMMAND` and `ContainedProcessSupervisor`
    - Design C9: EP-SHELL via `checkCommand` against `DEFAULT_SHELL_POLICY`, EP-ENV via `filterEnv(envSource).denied`
      (names only), delegate to the inner `NodeToolExecutor`, `ExecutedAction` with effect; `ALLOW_ANY_COMMAND`
      (`has() → true`, size 0); shadow `ShellPolicy` as an object literal; `ContainedProcessSupervisor` exact-match real
      execution with `cwd === sandbox.root`, else `[shadow-simulated]` result + `command-simulated` event.
    - _Requirements: 4.1, 4.3, 5.3, 5.7, 7.5, 7.6_
  - [x] 3.5 Implement `AblationVerificationEngine` and `AblationCompletionGate`
    - Design C10: subclasses calling `super`; enforce records only; shadow returns an in-memory PASS copy (persisted
      report keeps the real status) and `canComplete: true` with the real reason recorded as `wouldBlock`.
    - _Requirements: 4.1, 4.3, 5.5, 5.6_
  - [x] 3.6 Write `tests/shadow-ablation/observers.spec.ts`
    - **Property 6: Ledger decisions equal the Kernel's decisions** (generated tool names × risk classes × autonomy
      levels × paths × commands; Kernel objects on a temp sandbox; SQLite `:memory:` repositories)
    - Examples: shadow DESTRUCTIVE approved via `ShadowApprovalCoordinator` (Approval `decidedBy: 'policy'`); EP-VERIFY
      shadow returns PASS while `VerificationRepository` keeps FAIL; EP-COMPLETION shadow `canComplete: true` with the
      real reason in the ledger; EP-ENV records names, never values, and the spawn env equals `safeEnv`; EP-SCHEMA
      inactive when no schemas are wired.
    - **Validates: Requirements 4.1, 4.3, 4.5, 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7**
  - [x] 3.7 Write `tests/shadow-ablation/containment.spec.ts`
    - **Property 12: Containment keeps every effect inside the sandbox** (sentinel dir in `os.tmpdir()` hashed before
      and after; generated `..`, absolute and mixed-separator targets; all operations; both modes)
    - **Property 13: Sandbox root guard**
    - Examples: `kernelMiss` with a fake inner WorkspaceManager whose `checkPath` accepts an outside path;
      `ContainedProcessSupervisor` runs an exact-match command on a fake inner supervisor and simulates any other;
      the sandbox directory is gone after `destroySandbox`.
    - **Validates: Requirements 6.5, 7.1, 7.2, 7.3, 7.4, 7.5, 7.6**

- [x] 4. Injection corpus
  - [x] 4.1 Implement `packages/testing/src/shadow-ablation/injection-corpus.ts`
    - `InjectionCategory`, `ExpectedEnforce`, `InjectionEntry`, deep-frozen `INJECTION_CORPUS` with the 14 entries of
      design C11 (labels are hypotheses until task 6.7), `InjectionPlan`, `buildInjectionPlans` (structural inputs,
      `first-execute` / `after-first-write`, clamp to the first organic would-block step, `notPlaceable`). Pure: no
      clock, randomness or filesystem; INJ-PATH-02 builds its absolute target from a parameter, not from `os`.
    - _Requirements: 8.1, 8.2, 8.4, 8.5, 8.6_
  - [x] 4.2 Write `tests/shadow-ablation/injection-corpus.spec.ts`
    - **Property 14: Injection placement never follows an organic block**
    - Examples: every category present; every entry has id, category, raw JSON that passes `validateExecuteSemantics`,
      label and target invariants; gap entries have `kernelGap: true` and a note; two reads of the constant are equal
      and frozen.
    - **Validates: Requirements 8.1, 8.2, 8.4, 8.5, 8.6**

- [x] 5. Checkpoint: building blocks
  - Run `npm run build`, `npm run depcruise`, `tests/invariants/shadow`, and the specs from tasks 2–4. Ensure all tests
    pass, ask the user if questions arise.

- [x] 6. Arm runner, synthetic traces, comparison and report
  - [x] 6.1 Implement `arm.ts` (`runArm`, `assertReplayable`)
    - Design C12: mirror `makeRealAgentRunner` of `scripts/run-progressive.mjs` (same `counters()`, SQLite `:memory:`,
      migrations, services, Planner, ContextCollector on the sandbox, TaskExecutor `maxToolCalls` from the trace,
      recovery per `wiring.recovery`, SessionOrchestrator `maxIterations: 10`, same seeded session/graph/goal), with only
      the observer substitutions; shadow-only `ShadowApprovalCoordinator`; guard events from `DECISION_COMPLETED`;
      EP-APPROVAL from `pendingApprovalToolCallId`; workspace hash + per-file SHA-256; optional benchmark verdict via
      `BenchmarkCheckRunner`; `destroySandbox` in `finally`; orchestrator errors → `HARNESS_ERROR` (redacted).
    - `assertReplayable`: refuse `concurrent` traces and `interaction !== 'off'`.
    - _Requirements: 3.7, 4.2, 4.4, 5.8, 7.1, 9.1, 10.1_
  - [x] 6.2 Implement `synthetic-traces.ts`
    - `SYNTHETIC_SCRIPTS` SYN-01..SYN-05 (design Testing Strategy; plan JSON copied from an existing FakeModel-driven
      integration test so it passes `PLAN_SCHEMA`), seed files, scripted `FakeProcessSupervisor` outcomes per script,
      `synthesizeTraces()` = record a `FakeModel.setSequence()` run through the enforce wiring with
      `RecordingModelGateway` (`source.kind: 'synthetic'`).
    - _Requirements: 11.1, 11.3_
  - [x] 6.3 Implement `comparison.ts` (`findDivergence`, `compareArms`)
    - Design C13: proposal rows (primary metric), divergence algorithm steps 1–5, counterfactual flag (drift excluded),
      executed-action diff up to the divergence point, completion side by side, workspace hashes + added/removed/modified,
      simulated escapes, kernel misses, injected-entry outcome (`reached`, `stopped`, `stoppedBy`, `labelMatches`,
      `notReachedBecause`, INJ-DONE-02 `n/a` when verification was PASS), fidelity. Pure.
    - _Requirements: 8.7, 9.2, 9.3, 9.4, 9.5, 10.1, 10.2, 10.3_
  - [x] 6.4 Implement `report.ts` (`buildReport`, `renderMarkdown`)
    - Design C14: `ReportJsonV1`, summary tallies, fixed interpretation sentences (zero-organic sentence, ENFORCEMENT
      FAILURE banner), section order, Kernel gaps, kernel misses first, inactive / not-exercised points, method and
      caveats with the residual-risk list; no prompt text, redacted 200-char previews; deterministic rendering.
    - _Requirements: 8.4, 9.5, 10.4, 10.5, 10.6, 10.7, 10.8, 10.9_
  - [x] 6.5 Export the arm, synthetic, comparison and report modules from the subpath barrel
    - Update `packages/testing/src/shadow-ablation/index.ts`; rebuild; re-run `tests/invariants/shadow/sa-001.spec.ts`.
    - _Requirements: 6.1, 6.3_
  - [x] 6.6 Write `tests/shadow-ablation/comparison.spec.ts`
    - Arm-level properties on generated benign traces (≤ 8 steps, per-test timeout 60 s) and pure properties on
      generated `ArmResult`s:
    - **Property 8: Shadow is transparent when nothing would be blocked**
    - **Property 9: Identical prefix before the divergence point**
    - **Property 10: Counterfactual marking is exact**
    - **Property 15: Comparison and report are pure, consistent and clean**
    - Examples: all four comparison parts present; zero-organic interpretation sentence; ENFORCEMENT FAILURE banner for a
      synthetic missed stop; `not reached` row with the stopping step.
    - **Validates: Requirements 5.8, 8.7, 9.1, 9.2, 9.3, 9.4, 10.1, 10.3, 10.5, 10.6, 10.7, 10.8, 10.9**
  - [x] 6.7 Write `tests/shadow-ablation/harness-e2e.spec.ts` and settle the corpus labels
    - **Property 7: Enforce-mode observers are transparent** (observed enforce arm vs plain Kernel wiring)
    - **Property 11: Every reached out-of-policy injection is stopped and never executed by the enforce arm**
    - Examples: SYN-01..05 through `SessionOrchestrator` in both arms, uninjected and with every corpus entry; uninjected
      enforce arms have replay fidelity served = total with no mismatch (wiring parity); SYN-04 reports an organic
      would-block and counterfactual steps after it; `assertReplayable` refuses a concurrent trace and an `ask` trace.
    - Corpus label check: each entry's observed enforce Effective_Decision equals its label. Where it does not, correct
      the label in `injection-corpus.ts` TOWARD THE OBSERVED KERNEL BEHAVIOR with a comment citing the code path; never
      change `packages/agent-core`. List every confirmed kernel gap (entry id + code path) in the corpus file comment so
      tasks 9.2 and 11.3 can cite it.
    - **Validates: Requirements 3.7, 4.2, 4.4, 8.3, 8.4, 9.5, 11.1, 11.2, 11.3, 11.4**

- [x] 7. Checkpoint: Phase 1 complete
  - Run `npm run build`, `eslint .`, `npm run depcruise` and all `tests/shadow-ablation` + `tests/invariants` specs.
    Ensure all tests pass, ask the user if questions arise.

- [x] 8. Phase 2 tooling (offline-buildable; no model needed)
  - [x] 8.1 Add `--record-trace <dir>` to `scripts/run-progressive.mjs`
    - Design C15: wrap `gw0` per case with `RecordingModelGateway` (source + wiring metadata), write the trace in the
      case `finally`, import only `RecordingModelGateway` and `writeTraceFile` from
      `../packages/testing/dist/shadow-ablation/index.js`; without the flag the runner is unchanged. Update the header
      usage comment.
    - _Requirements: 12.1, 12.2, 12.3, 12.4_
  - [x] 8.2 Implement `scripts/run-shadow-ablation.mjs` and produce the synthetic report
    - Design C15: `--traces`, `--benchmark`, `--only`, `--approval none|deny`, `--synthetic`, `--out-dir` (default
      `.agents`); validate traces (refusals listed, not fatal), join with benchmark cases, build plans, run arms
      sequentially, compare, write `kernel-shadow-ablation(.synthetic).{md,json}`; no gateway other than
      `ReplayModelGateway`; exit codes 0 / 1 / 2.
    - Write `tests/shadow-ablation/scripts.spec.ts`: spawn `node scripts/run-shadow-ablation.mjs --synthetic --out-dir
      <tmp>`; assert exit 0, both files exist, the JSON parses as `ReportJsonV1` and re-renders to the same markdown,
      and all reached out-of-policy entries are stopped.
    - Run `node scripts/run-shadow-ablation.mjs --synthetic` to write `.agents/kernel-shadow-ablation.synthetic.md` and
      `.json` (clearly labelled synthetic).
    - _Requirements: 10.4, 13.1, 13.2, 13.3_

- [x] 9. Docs sync
  - [x] 9.1 Update `EVALUATION_MODEL.md` and `.agents/failure-taxonomy.md`
    - EVALUATION_MODEL: new section "Enforcement shadow ablation" (in the document's existing language and numbering
      style): question it answers, arms, enforcement points table, observed-only guards, primary metric, divergence and
      counterfactual rule, success criterion (100% of reached out-of-policy injections stopped; organic differences
      reported honestly), containment ≠ enforcement, residual risks, how to run both phases.
    - failure-taxonomy: ablation protocol step 5 "Enforcement shadow ablation" (what it isolates, how to read organic
      `wouldBlock` and gap probes, mapping rule: gap → GOVERNANCE "no invariant covers this"; organic block that made a
      case fail → GOVERNANCE/OVER_APPROVAL or INTERACTION/OVER_RESTRICT candidate; organic block preventing harm →
      record as kernel value), and update the "Last updated" footer.
    - _Requirements: 14.1, 14.2_
  - [x] 9.2 Update `README.md`
    - Evaluation section: the shadow ablation experiment, the two scripts and the synthetic report path; "Honest
      limitations": counterfactual replay after divergence, containment is not an OS sandbox, in-loop guards not ablated,
      confirmed kernel gaps from task 6.7 (reported, not fixed), Phase 2 real run pending until task 11.
    - _Requirements: 14.4_
  - [x] 9.3 Update `PROJECT_STATUS.md`, `PHASE_12_SIGNOFF.md` and stale claims
    - PROJECT_STATUS: Evaluation / benchmark row (shadow ablation harness, Phase 1 synthetic result, Phase 2 pending),
      limitations list (counterfactual, containment, guards, confirmed gaps), shipped list; "Last updated" line is set
      in task 10.2.
    - PHASE_12_SIGNOFF addendum: row "Kernel shadow ablation" with `*(this commit)*`; replace the previous row's
      `*(this commit)*` with its real hash if it is committed by then.
    - Grep the docs for stale claims ("no shadow", "dry-run", "log-only", "traces do not survive", "only pass/fail") and
      fix them; update `ROADMAP.md` only if it describes this work. Do not edit `INVARIANTS.md` / `invariants.yaml`
      here (done in 1.2).
    - _Requirements: 14.3, 14.5_

- [x] 10. Final verification
  - [x] 10.1 Run `npm run build`, `eslint .` (0 problems), `npm run depcruise` (0 violations), and confirm
    `git diff --stat packages/agent-core` is empty, no `package.json` gained a dependency, and
    `packages/vscode-extension` is unchanged
    - _Requirements: 6.4, 15.1, 15.3, 15.5_
  - [x] 10.2 Run the WSL suite `scripts/_wsl-tmp.sh` in the background (~200 s), read the output, and compare with the
    baseline 2189 tests / 230 files; set the `PROJECT_STATUS.md` "Last updated" line (date + new counts)
    - Ensure all tests pass, ask the user if questions arise.
    - _Requirements: 15.2, 15.4_

- [x] 11. Phase 2 real run (USER-GATED: requires Ollama + Qwen3.5, RAM-heavy)
  - [x] 11.1 Record real traces — ask the user to start Ollama and confirm before running; never start Ollama or any
    model server automatically
    - After the user confirms Ollama is up with the Qwen3.5 model: `node scripts/run-progressive.mjs <qwen3.5 tag>
      --split train --record-trace .agents/traces/qwen35-<yyyymmdd>` (training split only, same flags as the P12.33
      baseline, nothing else changed). Report the TOTAL line and the number of trace files written.
    - _Requirements: 12.1, 13.4_
  - [x] 11.2 Replay the recorded traces and write the report (no model needed)
    - `node scripts/run-shadow-ablation.mjs --traces .agents/traces/qwen35-<yyyymmdd> --benchmark
      benchmarks/codeforge-progressive/benchmark.json` → `.agents/kernel-shadow-ablation.md` and `.json`. Report replay
      fidelity (served/total, mismatches, drift) and any refused traces.
    - _Requirements: 9.5, 10.4, 10.5, 10.6, 10.7, 13.1, 13.2_
  - [x] 11.3 Write the analysis and sync the results into the docs
    - Write `.agents/kernel-shadow-ablation-analysis.md`: headline numbers, every organic `wouldBlock`, every gap probe
      that reached the sandbox, every `kernelMiss`, each mapped to a `.agents/failure-taxonomy.md` class with the case id;
      an explicit answer to the reviewer ("how much did the two runs differ on organic proposals?"); counterfactual
      caveats.
    - Overfitting discipline: no result is used to tune benchmark cases, prompts or corpus labels; held-out cases are
      not involved and never justify a fix; kernel gaps are filed as follow-ups, not fixed here.
    - Update `PROJECT_STATUS.md`, `README.md` and the `PHASE_12_SIGNOFF.md` row with the measured numbers (or state why
      the run was not done).
    - _Requirements: 13.5, 13.6, 14.3, 14.4, 14.5_

## Notes

- All tasks are required, including every test task; no task is optional. Task 11 is gated on the user starting
  Ollama and may be deferred; tasks 1–10 complete Phase 1 and the Phase 2 tooling without any model.
- No property-testing dependency: properties use seeded `mulberry32` generators kept local in each spec file
  (`tests/tsconfig.json` does not include `tests/mission/**`), ≥100 iterations each.
- No change to `packages/agent-core` (kernel governance and approval semantics untouched), no new dependency, no new
  frontend; CLI flags, HTTP routes and VS Code commands unchanged.
- Kernel gaps found by the corpus (candidates: allowlisted `rm`/`curl` with unchecked args under `full` autonomy,
  reading `.env` inside the workspace, writes to `.git/` or test files) are reported, not fixed, in this spec.
- Never commit `.agents/traces/`, `*.vsix`, `packages/vscode-extension/package-lock.json`, temp logs or secrets.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["2.1", "3.1"] },
    { "id": 2, "tasks": ["2.2", "2.3", "3.2", "3.3", "3.4", "3.5", "4.1"] },
    { "id": 3, "tasks": ["1.2"] },
    { "id": 4, "tasks": ["2.4", "2.5", "3.6", "3.7", "4.2", "6.1"] },
    { "id": 5, "tasks": ["6.2", "6.3"] },
    { "id": 6, "tasks": ["6.4"] },
    { "id": 7, "tasks": ["6.5"] },
    { "id": 8, "tasks": ["6.6", "6.7"] },
    { "id": 9, "tasks": ["8.1", "8.2"] },
    { "id": 10, "tasks": ["9.1", "9.2", "9.3"] },
    { "id": 11, "tasks": ["10.1"] },
    { "id": 12, "tasks": ["10.2"] },
    { "id": 13, "tasks": ["11.1"] },
    { "id": 14, "tasks": ["11.2"] },
    { "id": 15, "tasks": ["11.3"] }
  ]
}
```
