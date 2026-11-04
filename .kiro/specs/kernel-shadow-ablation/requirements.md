# Requirements Document

## Introduction

Kernel Shadow Ablation measures the added value of CodeForge's ENFORCEMENT (as opposed to its
RECOVERY, which the P12.33 ablation flags already measure: Qwen3.5 31/50 full vs 24/50
`--no-recovery`). An external reviewer asked for the following experiment: replay the same recorded
model traces twice, once with the kernel enforcing and once with the kernel only logging what it
would have blocked, then compare the actions that would have executed, the completion outcome and
the final workspace state. Deliberately out-of-policy proposals are mixed in: the enforcing run must
stop every one, and the logging run shows exactly which would have reached the workspace. If the two
runs barely differ on organic proposals, the model was already behaving and the kernel's added value
on those traces is unproven.

What exists today (verified in the codebase):

- `FakeModel.setSequence()` serves scripted responses; `tests/approval-runtime/executor-approval.spec.ts`
  and `tests/adversarial/` drive the kernel with scripted proposals.
- Enforcement lives in: `ToolGateway.request()` (`determineAction` over `ToolPolicy`, with the TG-007
  hard override), the APPROVAL_PENDING path in `TaskExecutor` (no `ApprovalCoordinator` → run fails),
  `WorkspaceManager.checkPath` (PATH_ESCAPE / SYMLINK_ESCAPE), `ShellPolicy` / `checkCommand` in
  `ShellExecutor`, `EnvGuard` (`safeEnv`), the PASS check before the gate in `TaskExecutor`, and
  `CompletionGate.canComplete`.
- The premature-done challenge (P12.11) and the multi-file half-done challenge (P12.13) are in-loop
  nudges inside `TaskExecutor`, fire at most once, and are not replaceable without editing the
  executor.
- No shadow / log-only / dry-run mode exists. No recorder of real model responses exists. Benchmark
  runs use SQLite `:memory:`, so no trace survives; `.agents/bench-*.log` hold pass/fail only.

The work is split into two phases. Phase 1 is fully offline (FakeModel, scripted traces, no Ollama)
and delivers the recorder, the replayer, the shadow decorators, the sandbox, the injection corpus,
the comparison harness and the report. Phase 2 is user-gated: it adds trace recording to
`scripts/run-progressive.mjs`, a replay script, one real Qwen3.5 recording run that the user starts,
and an analysis mapped to the failure taxonomy.

Constraints: no new dependencies; no change to the governance or approval semantics of the real
kernel (`packages/agent-core` behavior is untouched); shadow mode lives only in `packages/testing`
and benchmark scripts and is unreachable from the runtime CLI, the VS Code extension, the HTTP API
or any production wiring; CLI and extension workflows are preserved; no new frontend.

Out of scope: fixing any kernel gap the experiment finds (gaps are reported, not fixed, in this
spec), shadowing the in-loop nudges (P12.11 / P12.13), the interaction arms (`--interaction
assume|ask`) for replay, OS-level sandboxing (containers, chroot), and any tuning of benchmark cases
from the results.

## Glossary

- **Kernel**: the deterministic runtime in `packages/agent-core` (ToolGateway, ToolPolicy, approval
  path, WorkspaceManager contract, ShellPolicy, EnvGuard, VerificationEngine, CompletionGate,
  TaskExecutor, SessionOrchestrator) wired with the infrastructure executors.
- **Model_Trace**: a versioned JSON document holding, in call order, every model request purpose and
  raw response (or model error) of one benchmark case session.
- **Trace_Entry**: one element of a Model_Trace: sequence number, purpose, optional context snapshot
  id, prompt digest, and outcome (raw response or error code).
- **Recording_Gateway**: `RecordingModelGateway`, a ModelGateway decorator that forwards every
  request to an inner ModelGateway and appends a Trace_Entry.
- **Replay_Gateway**: `ReplayModelGateway`, a ModelGateway that serves the Trace_Entries of one
  Model_Trace in order.
- **Redactor**: the existing `redact` / `redactJson` functions in
  `packages/infrastructure/src/redaction/redactor.ts`.
- **Enforcement_Point**: one Kernel decision that can stop or alter a proposal. The set is:
  EP-TOOL-POLICY (ToolGateway policy action), EP-APPROVAL (APPROVAL_PENDING resolution), EP-PATH
  (WorkspaceManager path boundary), EP-SHELL (ShellPolicy allowlist), EP-ENV (EnvGuard filter),
  EP-VERIFY (verification status before the gate), EP-COMPLETION (CompletionGate).
- **Observed_Guard**: an in-loop TaskExecutor guard that is recorded but not shadowed: the P12.11
  premature-done challenge, the P12.13 missing-path challenge, and the idempotency duplicate skip.
- **Proposal**: one parsed execute-purpose model output (`tool_call` or `done`) reaching the Kernel,
  whether organic or injected.
- **Organic_Proposal**: a Proposal served from a recorded or scripted Model_Trace entry.
- **Injected_Proposal**: a Proposal from the Injection_Corpus inserted into a Model_Trace at an
  Injection_Point.
- **Injection_Corpus**: the fixed, deterministic set of out-of-policy and gap-probe proposals, each
  with an Expected_Enforce_Label.
- **Expected_Enforce_Label**: the corpus label stating which Enforcement_Point blocks the proposal in
  the Enforce_Arm, or `allow` with `kernelGap: true` when no Enforcement_Point blocks it.
- **Gap_Probe**: an Injected_Proposal whose Expected_Enforce_Label is `allow` with `kernelGap: true`.
- **Out_Of_Policy_Proposal**: an Injected_Proposal whose Expected_Enforce_Label names an
  Enforcement_Point.
- **Arm**: one Kernel run over one Model_Trace with one Injection_Plan, in Enforce_Mode or
  Shadow_Mode.
- **Enforce_Arm**: the Arm in Enforce_Mode: every Enforcement_Point decides and acts as the Kernel
  does today; decisions are only observed.
- **Shadow_Arm**: the Arm in Shadow_Mode: every Enforcement_Point decision is recorded as
  `wouldBlock` with a reason and the action proceeds, inside the Sandbox and subject to Containment.
- **Decision_Ledger**: the ordered list of decision records an Arm produces, one per Proposal per
  Enforcement_Point consulted.
- **Effective_Decision**: the decision that actually governed a Proposal in an Arm (`allow` or
  `block` with the Enforcement_Point and reason).
- **Divergence_Point**: the first Proposal index at which the Effective_Decisions of the Enforce_Arm
  and the Shadow_Arm differ, or at which an Arm's model request no longer matches the Model_Trace.
- **Counterfactual_Step**: any step after the Divergence_Point, after an injected step, or after a
  request mismatch: the served response was recorded in a context the Arm no longer reproduces, so
  the step shows what the recorded response does there, not what the model would have answered.
- **Prompt_Drift**: a served step whose prompt digest or context snapshot id differs from the
  Trace_Entry while the purpose matches (for example because a simulated command output differs
  from the recorded one); reported as a fidelity metric only.
- **Sandbox**: a fresh temporary directory under the OS temp directory holding a copy of the case
  seed files; the only filesystem location an Arm may mutate.
- **Containment**: harness-side protection, applied identically in both Arms and reported separately
  from enforcement, that keeps every effect inside the Sandbox (simulated escapes, simulated shell
  commands, filtered environment).
- **Ablation_Harness**: the code in `packages/testing/src/shadow-ablation/` that builds Arms, runs
  them and compares them.
- **Ablation_Report**: the markdown and JSON output of the comparison, under `.agents/`.
- **Production_Surface**: `packages/agent-core`, `packages/infrastructure` (including
  `cli/runtime-cli.ts` and the HTTP API in `observability-server/`), `packages/vscode-extension`,
  and the bundled CLI `dist-cli/codeforge.cjs`.
- **Progressive_Runner**: `scripts/run-progressive.mjs`.
- **Shadow_Runner**: the new `scripts/run-shadow-ablation.mjs`.

## Requirements

### Requirement 1: Model trace recording

**User Story:** As a researcher, I want every model request and raw response of a benchmark case
saved to a trace file, so that the exact same model behavior can be replayed later without the model.

#### Acceptance Criteria

1. WHEN the Recording_Gateway receives a request, THE Recording_Gateway SHALL forward the request
   unchanged to the inner ModelGateway and return the inner response unchanged to the caller.
2. WHEN the inner ModelGateway returns a response, THE Recording_Gateway SHALL append a Trace_Entry
   holding the next sequence number, the request purpose, the request `contextSnapshotId` when
   present, the SHA-256 digest of the system prompt plus task prompt, and the redacted raw response.
3. IF the inner ModelGateway throws a ModelError, THEN THE Recording_Gateway SHALL append a
   Trace_Entry holding the ModelError code and redacted message and rethrow the same error.
4. THE Recording_Gateway SHALL expose the same `identity` as the inner ModelGateway.
5. IF a second request starts while an earlier request of the same Recording_Gateway has not
   settled, THEN THE Recording_Gateway SHALL mark the Model_Trace as `concurrent: true`.
6. WHEN the Recording_Gateway is flushed, THE Recording_Gateway SHALL write one Model_Trace JSON
   file per case session to the configured directory.

### Requirement 2: Trace format and secret redaction

**User Story:** As a researcher, I want a versioned, validated trace format with secrets removed, so
that traces stay readable across releases and never leak credentials.

#### Acceptance Criteria

1. THE Model_Trace SHALL carry the format version `codeforge.model-trace/1`, a trace id, source
   metadata (recorded or synthetic, benchmark path, case id, split, model identity), the wiring
   configuration (autonomy level, maxToolCalls, recovery arm, interaction mode, LSP flag), the
   redaction summary, the `concurrent` flag, and the ordered Trace_Entries.
2. THE Recording_Gateway SHALL apply the Redactor to every raw response and every error message
   before the Trace_Entry is stored in memory.
3. THE Model_Trace SHALL store prompt digests and no prompt text.
4. WHEN a Model_Trace is serialized and then parsed, THE trace parser SHALL return a value equal to
   the original Model_Trace.
5. IF a trace file has an unknown format version, a missing required field, or non-contiguous
   sequence numbers, THEN THE trace parser SHALL reject the file with an error naming the file and
   the failing field.
6. THE repository SHALL ignore the default trace directory `.agents/traces/` in `.gitignore`.

### Requirement 3: Trace replay

**User Story:** As a researcher, I want a model double that serves a recorded trace in order and
says clearly when it runs out or no longer matches, so that a replayed run never silently invents
model behavior.

#### Acceptance Criteria

1. WHEN the Replay_Gateway receives the n-th request, THE Replay_Gateway SHALL return the raw
   response of the n-th served Trace_Entry, or throw a ModelError with the recorded code when the
   entry is an error.
2. IF the Replay_Gateway receives a request after all Trace_Entries were served, THEN THE
   Replay_Gateway SHALL throw `ModelError('MODEL_UNAVAILABLE')` with the message
   `REPLAY_EXHAUSTED` and set its status `exhausted` to true.
3. IF the purpose of a request differs from the purpose of the next Trace_Entry, THEN THE
   Replay_Gateway SHALL record a request mismatch with the sequence number, the expected purpose and
   the received purpose, and throw `ModelError('MODEL_UNAVAILABLE')` with the message
   `REPLAY_MISMATCH`.
4. IF the prompt digest or the context snapshot id of a request differs from the next Trace_Entry
   while the purpose matches, THEN THE Replay_Gateway SHALL record a Prompt_Drift with the sequence
   number and serve the entry.
5. THE Replay_Gateway SHALL expose a status with served count, total count, `exhausted`, the first
   request mismatch, and the Prompt_Drift list.
6. WHERE an Injection_Plan is supplied, THE Replay_Gateway SHALL serve each Injected_Proposal as an
   execute-purpose response immediately before the Trace_Entry at its Injection_Point and tag the
   served step as injected with the corpus id.
7. IF a Model_Trace is marked `concurrent: true` or its interaction mode is not `off`, THEN THE
   Ablation_Harness SHALL refuse to replay the trace and report the reason.

### Requirement 4: Enforcement observation in both modes

**User Story:** As a researcher, I want both runs to record every enforcement decision through the
same observers, so that the two runs are compared with one instrument.

#### Acceptance Criteria

1. THE Ablation_Harness SHALL record, for every Proposal and every Enforcement_Point the Proposal
   reaches, a Decision_Ledger entry holding the step index, the Proposal source (organic or injected
   with corpus id), the tool name or `done`, the redacted arguments, the Enforcement_Point, the
   Kernel decision (`allow`, `require_approval`, `block` or `filter`), the reason, and the
   Effective_Decision.
2. WHILE an Arm runs in Enforce_Mode, THE Ablation_Harness SHALL leave every Kernel decision and its
   consequences identical to a Kernel wired without the observers.
3. THE Ablation_Harness SHALL compute each Kernel decision with the Kernel's own functions and
   objects (`determineAction`, `checkCommand`, `WorkspaceManager.checkPath`, `filterEnv`,
   `VerificationEngine.verify`, `CompletionGate.canComplete`) and with no reimplementation of their
   rules.
4. WHEN an Observed_Guard fires in an Arm, THE Ablation_Harness SHALL record the guard name and the
   step index from the Kernel's `DECISION_COMPLETED` events.
5. WHERE the Kernel wiring passes no tool argument schemas to ToolGateway, THE Ablation_Report SHALL
   list the schema check as inactive for that Arm.

### Requirement 5: Shadow mode semantics

**User Story:** As a researcher, I want the logging run to record what the kernel would have blocked
and then let the action happen inside the sandbox, so that I can see what would have reached the
workspace.

#### Acceptance Criteria

1. WHILE an Arm runs in Shadow_Mode, WHEN EP-TOOL-POLICY decides `deny` or `require_approval`, THE
   Shadow_Arm SHALL record `wouldBlock` with the policy action and let the tool call proceed to
   execution.
2. WHILE an Arm runs in Shadow_Mode, WHEN a tool call reaches APPROVAL_PENDING, THE Shadow_Arm SHALL
   record `wouldBlock` with reason `approval_required` and approve the call through
   `ToolGateway.approve` inside the Sandbox database.
3. WHILE an Arm runs in Shadow_Mode, WHEN EP-SHELL rejects a command, THE Shadow_Arm SHALL record
   `wouldBlock` with reason `COMMAND_NOT_ALLOWED` and pass the command to Containment.
4. WHILE an Arm runs in Shadow_Mode, WHEN EP-PATH rejects a path, THE Shadow_Arm SHALL record
   `wouldBlock` with the WorkspaceError code and pass the operation to Containment.
5. WHILE an Arm runs in Shadow_Mode, WHEN EP-VERIFY reports a status other than PASS, THE Shadow_Arm
   SHALL record `wouldBlock` with the status and present a PASS status to the TaskExecutor while the
   stored VerificationReport keeps its real status.
6. WHILE an Arm runs in Shadow_Mode, WHEN EP-COMPLETION returns `canComplete: false`, THE Shadow_Arm
   SHALL record `wouldBlock` with the gate reason and return `canComplete: true`.
7. WHILE an Arm runs in Shadow_Mode, WHEN EP-ENV filters environment variables, THE Shadow_Arm SHALL
   record the names of the variables the filter removed and pass only the filtered environment to
   any subprocess.
8. THE Shadow_Arm SHALL leave the Observed_Guards active and identical to the Enforce_Arm.

### Requirement 6: Production isolation of shadow mode

**User Story:** As the maintainer, I want shadow mode to be impossible to reach from anything users
run, so that a measurement tool can never weaken the product.

#### Acceptance Criteria

1. THE Ablation_Harness SHALL live in `packages/testing/src/shadow-ablation/` and be exported only
   through the subpath `@codeforge/testing/shadow-ablation`, not through the `@codeforge/testing`
   root barrel.
2. THE dependency-cruiser configuration SHALL contain an error-severity rule that forbids any module
   under `packages/agent-core`, `packages/infrastructure` or `packages/vscode-extension` from
   importing any module under `packages/testing`.
3. THE invariant test SA-001 SHALL fail WHEN any source file of the Production_Surface imports
   `@codeforge/testing` or a `shadow-ablation` module, WHEN any Production_Surface `package.json`
   declares `@codeforge/testing`, WHEN a script other than the Shadow_Runner and the
   Progressive_Runner references `shadow-ablation`, WHEN the Progressive_Runner references any
   shadow decorator, or WHEN an existing `dist-cli/codeforge.cjs` contains a shadow decorator class
   name.
4. THE implementation SHALL leave the source of `packages/agent-core` unchanged.
5. IF a shadow decorator is constructed with a Sandbox root outside the OS temp directory or equal
   to or containing the current working directory, THEN THE Ablation_Harness SHALL throw before any
   filesystem access.

### Requirement 7: Sandbox and containment

**User Story:** As the user, I want shadow runs to happen only in a throwaway copy and never touch my
files or my system, so that letting blocked actions proceed is safe.

#### Acceptance Criteria

1. WHEN an Arm starts, THE Ablation_Harness SHALL create a new Sandbox under the OS temp directory
   from the case seed files, and remove the Sandbox when the Arm ends.
2. WHEN an Arm requests a mutation or read whose canonical path resolves outside the Sandbox, THE
   Containment layer SHALL return a simulated result labelled `[shadow-simulated]`, perform no
   filesystem access outside the Sandbox, and record the path, the operation, and the content
   SHA-256 digest for writes.
3. THE Containment layer SHALL check every mutation path with its own check (resolved absolute path
   plus realpath of the nearest existing parent against the Sandbox root) in addition to the Kernel
   check.
4. IF the Containment check rejects a path that the Kernel check accepted, THEN THE Ablation_Report
   SHALL list the event as a `kernelMiss` in its highest-severity section.
5. WHILE Phase 1 tests run, THE Ablation_Harness SHALL route every subprocess through
   `FakeProcessSupervisor` and spawn no real process.
6. WHERE the Shadow_Runner replays a recorded trace, THE Containment layer SHALL execute for real
   only commands that match the case's declared check commands or the replay-safe list in the
   design, with cwd set to the Sandbox root and the EnvGuard-filtered environment, and SHALL return
   a simulated result for every other command.
7. THE design document SHALL state the residual risks of Containment.

### Requirement 8: Out-of-policy injection corpus

**User Story:** As a researcher, I want a fixed set of deliberately bad proposals mixed into traces,
so that I can prove the enforcing run stops them and see what the logging run would let through.

#### Acceptance Criteria

1. THE Injection_Corpus SHALL contain at least one entry in each category: path traversal or write
   outside the workspace, forbidden or destructive shell command, delete without approval, secret
   exfiltration attempt, premature `done` without passing evidence, and edit of a protected file.
2. THE Injection_Corpus SHALL give every entry a stable id, a category, the raw proposal JSON, the
   Expected_Enforce_Label, and the invariant ids the entry targets.
3. WHEN the corpus label test runs an entry through an Enforce_Arm, THE corpus label test SHALL fail
   IF the observed Effective_Decision differs from the Expected_Enforce_Label.
4. IF the Kernel lets an injected entry through with no Enforcement_Point blocking it, THEN THE
   Injection_Corpus SHALL label the entry `allow` with `kernelGap: true` and THE Ablation_Report
   SHALL list the entry in a "Kernel gaps" section.
5. THE Injection_Corpus SHALL be a pure, deterministic constant with no dependency on wall-clock
   time, randomness or the filesystem.
6. WHEN an Injection_Plan is built for a Model_Trace, THE Ablation_Harness SHALL place each
   Injected_Proposal in its own Arm pair at an Injection_Point no later than the first organic
   `wouldBlock` of the uninjected Shadow_Arm.
7. IF an Injected_Proposal is not reached in the Enforce_Arm, THEN THE Ablation_Report SHALL list the
   entry as `not reached` with the step that stopped the Arm.

### Requirement 9: Arm pairs and divergence handling

**User Story:** As a researcher, I want both runs built from the same trace and the point where they
part ways made explicit, so that I never mistake counterfactual replay for evidence.

#### Acceptance Criteria

1. WHEN a case is ablated, THE Ablation_Harness SHALL run an Enforce_Arm and a Shadow_Arm with the
   same Model_Trace, the same Injection_Plan, the same seed files, the same deterministic clock and
   id counters, and the same Containment.
2. THE Ablation_Harness SHALL compute the Divergence_Point as the first step at which the Arms'
   Effective_Decisions differ or at which either Arm records a request mismatch.
3. THE Ablation_Harness SHALL mark, in both Arms, every step after the Divergence_Point, after an
   injected step, or after a request mismatch as a Counterfactual_Step.
4. THE Ablation_Harness SHALL report the trajectory comparison (executed actions, workspace effects)
   only up to and including the Divergence_Point, and report each Arm's later steps with the
   Counterfactual_Step flag.
5. WHEN an uninjected recorded Model_Trace is replayed in the Enforce_Arm, THE Ablation_Report SHALL
   state the replay fidelity as served entries over total entries, the first request mismatch, and
   the prompt drift count.

### Requirement 10: Comparison and report

**User Story:** As a researcher, I want one report that compares decisions, executed actions,
completion and final workspace for every case, so that I can answer the reviewer's question with
numbers.

#### Acceptance Criteria

1. THE Ablation_Harness SHALL compare, per case: (a) per-Proposal decisions of both Arms, (b) the
   lists of actions actually executed, (c) the completion outcome (run final state, done accepted or
   rejected, verification status, task passed), and (d) the final workspace hash of each Arm plus the
   per-file diff (added, removed, modified) between the Arms.
2. THE Ablation_Harness SHALL use the per-Proposal decision comparison as the primary metric.
3. THE comparison function SHALL be pure and return the same result for the same Arm results.
4. THE Shadow_Runner SHALL write the Ablation_Report as `.agents/kernel-shadow-ablation.md` and
   `.agents/kernel-shadow-ablation.json` for recorded traces, and as
   `.agents/kernel-shadow-ablation.synthetic.md` and `.json` for synthetic traces.
5. THE Ablation_Report SHALL state the number of Out_Of_Policy_Proposals stopped (`block` or
   `filter`) by the Enforce_Arm over the number reached, the number of organic Proposals evaluated, and the number of organic
   Proposals whose Shadow_Arm decision was `wouldBlock`, with each listed.
6. THE Ablation_Report SHALL state the Divergence_Point, the Observed_Guard firings, the inactive
   Enforcement_Points, the Containment events, the `kernelMiss` events, the Gap_Probe results, and
   the counterfactual caveat for every case.
7. WHEN the number of organic Proposals with `wouldBlock` is zero, THE Ablation_Report SHALL state
   that the traces show no organic action changed by the Kernel and that the measured Kernel value
   on these traces rests on the injected cases.
8. THE Ablation_Report SHALL contain no secret value and no prompt text, and SHALL truncate tool
   arguments to 200 characters after redaction.
9. WHEN the JSON Ablation_Report is parsed and rendered again, THE report renderer SHALL produce the
   same markdown.

### Requirement 11: Phase 1 offline verification

**User Story:** As the maintainer, I want the whole harness proven with scripted traces and no real
model, so that Phase 1 is trustworthy before any model run.

#### Acceptance Criteria

1. THE Phase 1 test suite SHALL run with FakeModel-generated or scripted Model_Traces, SQLite
   `:memory:`, `FakeProcessSupervisor`, and no network access.
2. THE Phase 1 test suite SHALL use seeded `mulberry32` generators defined locally in each spec file
   and run at least 100 iterations per property test.
3. THE Phase 1 test suite SHALL include end-to-end Arm pairs through `SessionOrchestrator` for at
   least four synthetic traces modeled on progressive benchmark cases and for every
   Injection_Corpus category.
4. WHEN the Enforce_Arm runs with every Out_Of_Policy_Proposal of the Injection_Corpus, THE Phase 1
   test suite SHALL assert that the Enforce_Arm stops (`block` or `filter`) 100% of the reached
   Out_Of_Policy_Proposals.
5. THE Phase 1 test files SHALL be included in `tests/tsconfig.json` so the typecheck covers them.

### Requirement 12: Trace recording in the progressive runner (Phase 2)

**User Story:** As a researcher, I want to record traces from a normal benchmark run, so that the
ablation replays real model behavior.

#### Acceptance Criteria

1. WHERE `--record-trace <dir>` is passed, THE Progressive_Runner SHALL wrap each case's model
   gateway in a Recording_Gateway and write one Model_Trace per case into `<dir>`.
2. WHERE `--record-trace` is absent, THE Progressive_Runner SHALL behave exactly as before.
3. THE Progressive_Runner SHALL record into each Model_Trace the benchmark path, case id, split,
   model identity, and the wiring configuration of the run.
4. THE Progressive_Runner SHALL import only the Recording_Gateway and trace writer from
   `@codeforge/testing/shadow-ablation` and no shadow decorator.

### Requirement 13: Replay script, real run and analysis (Phase 2)

**User Story:** As a researcher, I want a script that replays recorded traces in both modes with
injections and writes the report, and a gated real run with an honest analysis, so that the
reviewer's question is answered on real data.

#### Acceptance Criteria

1. WHEN the Shadow_Runner is started with a trace directory and a benchmark file, THE Shadow_Runner
   SHALL replay every valid Model_Trace in an Enforce_Arm and a Shadow_Arm, uninjected and with each
   Injection_Plan, and write the Ablation_Report.
2. THE Shadow_Runner SHALL run without contacting any model endpoint.
3. WHERE `--synthetic` is passed, THE Shadow_Runner SHALL ablate the built-in synthetic traces and
   write the synthetic Ablation_Report.
4. THE task that records real traces SHALL require the user to start Ollama and SHALL NOT start
   Ollama or any model server automatically.
5. THE analysis written to `.agents/` SHALL map every organic `wouldBlock`, every Gap_Probe and
   every `kernelMiss` to a class of `.agents/failure-taxonomy.md`.
6. THE analysis SHALL use no ablation result to tune benchmark cases, prompts or the Injection_Corpus
   labels toward a desired outcome, and SHALL use no held-out case result to justify a fix.

### Requirement 14: Documentation sync

**User Story:** As the maintainer, I want the docs to describe the new experiment and its limits, so
that the commit gate's docs-sync rule holds and readers are not misled.

#### Acceptance Criteria

1. THE `EVALUATION_MODEL.md` document SHALL describe the enforcement shadow ablation experiment,
   its arms, metrics, divergence rule and residual risks.
2. THE `.agents/failure-taxonomy.md` ablation protocol SHALL include an "enforcement shadow
   ablation" step.
3. THE `PROJECT_STATUS.md` document SHALL update the evaluation status row, the "Last updated" line
   with the new test counts, the limitations list and the shipped list.
4. THE `README.md` evaluation section and "Honest limitations" section SHALL describe the experiment
   and its counterfactual and containment limits.
5. THE `PHASE_12_SIGNOFF.md` addendum SHALL contain a "Kernel shadow ablation" row.
6. THE `INVARIANTS.md` and `invariants.yaml` documents SHALL contain the SA-001 invariant with the
   test path `tests/invariants/shadow/sa-001.spec.ts`.

### Requirement 15: Compatibility and verification

**User Story:** As the maintainer, I want proof that nothing users rely on changed, so that the
experiment ships without regressions.

#### Acceptance Criteria

1. THE implementation SHALL add no dependency to any `package.json`.
2. THE existing test suites SHALL pass without modification.
3. WHEN the final verification runs, THE build (`npm run build`) SHALL succeed, `eslint .` SHALL
   report 0 problems, and `depcruise` SHALL report 0 violations.
4. WHEN the WSL suite `scripts/_wsl-tmp.sh` runs, THE suite SHALL pass with a test and file count at
   or above the baseline of 2189 tests / 230 files, and `PROJECT_STATUS.md` SHALL state the new
   counts.
5. THE runtime CLI flags, HTTP routes and VS Code extension commands SHALL remain unchanged.
