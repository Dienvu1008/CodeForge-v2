# Implementation Plan: Kernel Gap Closure

## Overview

Test-first, from the pure rules outward: failing tests → redactor fix → pure policy and
classification in `agent-core` → executor, workspace and CLI changes in `infrastructure` → invariant
registry → shadow-ablation instrument → regression sweep → real-trace replay and analysis → docs sync
→ final verification. No new dependencies, no new CLI flag, no change to `ToolGateway`,
`ApprovalEngine`, `TaskGraph`, `VerificationEngine` or `CompletionGate`. Commit and push are done by the
main agent afterwards, following `.kiro/steering/commit-gate.md`; there is no commit task here.

Language: TypeScript (the repo's dominant language). Property tests use local seeded `mulberry32`
generators (copied into `tests/tool/gap-closure-generators.ts`, because `tests/tsconfig.json` does not
include `tests/mission/**`), at least 100 iterations per property, tag
`// Feature: kernel-gap-closure, Property N: <title>`.

## Tasks

- [x] 1. Write the failing tests first
  - [x] 1.1 Create `tests/tool/gap-closure-generators.ts` and `tests/security/redactor-private-key.spec.ts`
    - Generators: `mulberry32(seed)`, `pick`, `int`, `forAll(seed, n, fn)`, string builders for base64 bodies,
      path segments, argument lists. Reference implementations for tests are plain literal-list checks,
      written independently of the production code.
    - **Property 1: Private-key blocks are fully redacted** (0 to 4 type words, 1 to 200 body lines, plain,
      JSON-escaped newlines and log-line wrappers; body and body lines never survive; prefix and suffix kept)
    - **Property 2: Public material is not redacted** (`PUBLIC KEY` and `CERTIFICATE` blocks unchanged)
    - Examples: bare PKCS#8, RSA, EC, DSA, OPENSSH, ENCRYPTED, PGP `PRIVATE KEY BLOCK`; 200 000 characters of
      repeated headers with no footer returns within 1 000 ms; `REDACTION_RULES` still has the `private-key`
      rule at its current index.
    - **Validates: Requirements 1.1, 1.2, 1.3, 1.4, 1.5, 1.6**
  - [x] 1.2 Write `tests/shell/shell-classifier.spec.ts`
    - **Property 3: Destructive and network classification is stable under name decoration**
    - **Property 4: Subcommand and flag rules classify as specified**
    - **Property 5: Installers are PACKAGE_INSTALL and verification commands stay SYSTEM**
    - **Property 7: Argument extraction follows the definitions** (reference implementation of the Glossary
      definitions; URL, whitespace and metacharacter arguments never path-like; `name=value` uses the value)
    - **Property 16 (classifier part): Deterministic** (second call deep-equal)
    - Examples: `rm -rf ..` as one string equals split form; `C:\tools\RM.EXE`; `git -C sub status` is SYSTEM,
      `git -C sub clean -fd` is DESTRUCTIVE; `find . -name x -delete`; `npm --prefix . install`;
      regression list `npm test`, `node test.js`, `node --test test/round.test.js`, `npx tsx test.ts`,
      `go test ./...`, `cargo test`, `dart test`, `python -m pytest`.
    - **Validates: Requirements 2.1–2.6, 3.4, 3.5, 4.1–4.3, 5.1, 5.2, 10.2**
  - [x] 1.3 Write `tests/tool/path-access-policy.spec.ts`
    - **Property 9: Sensitive-path verdicts match the reference list** (any depth, separator style, case,
      trailing dots or spaces, `:stream` suffix; positive list, negative list)
    - **Property 10: Verdicts are invariant under path normalisation**
    - **Property 11 (pure part): Protected VCS metadata is write-protected and read-open** (`.git`, `.hg`,
      `.svn` at any depth; `.github`, `.gitignore`, `.gitattributes`, `.gitmodules`, `.gitkeep`,
      `.gitlab-ci.yml` never protected)
    - **Property 16 (policy part): Deterministic**
    - Examples: `.env` yes; `.env.local`, `config/.env.local` yes; `.env.example`, `.env.sample`,
      `.env.template` no; `environment.ts`, `src/env.js`, `env.d.ts`, `monkey.pem.md`, `credentials.ts`,
      `keyboard.ts` no; `server.pem`, `certs\server.KEY`, `id_rsa`, `id_rsa.pub` (no), `.ssh/known_hosts`,
      `.ssh/id_rsa.pub` (no, `.pub` wins), `.aws/credentials`, `.npmrc`, `.env.` + trailing dot, `.ENV`;
      `OPEN_PATH_ACCESS_POLICY` allows everything; `isTestLikePath` table (`test.js`, `a.test.ts`,
      `b.spec.js`, `test_x.py`, `x_test.go`, `tests/a.js`, `src/__tests__/a.js`, `spec/a.rb`; `latest.js`,
      `contest.ts`, `src/protest/a.js` are not test-like).
    - **Validates: Requirements 6.1, 6.3–6.5, 6.9, 7.1–7.3, 10.2**
  - [x] 1.4 Write `tests/tool/risk-classification.spec.ts`
    - **Property 6: DESTRUCTIVE and NETWORK always require approval** (all three levels, arbitrary tool names;
      `policyId` `autonomy-<level>-v2`, `version` 2; PACKAGE_INSTALL action unchanged)
    - **Property 14: Risk class follows the test-baseline reference model** (write, edit, delete, move,
      run_command mutators; new test file stays MODIFY_WORKSPACE; no baseline equals empty baseline)
    - **Property 16 (risk part): Deterministic**
    - Examples: table of every tool name from the design (READ_ONLY, MODIFY_WORKSPACE, `delete_file`
      DESTRUCTIVE, `move_file` SYSTEM, unknown tool SYSTEM); `run_command` with `args` not an array does not throw.
    - **Validates: Requirements 2.7, 4.4, 4.5, 5.3, 9.2–9.5, 10.2**
  - [x] 1.5 Write `tests/shell/shell-executor-arguments.spec.ts`
    - Real `NodeWorkspaceManager` over a temp directory, recording fake `ProcessSupervisor`.
    - **Property 8: The shell executor spawns exactly when no argument escapes** (including env expansion
      exempt for `echo` and `printf`, `name=value` values, unchanged spawn request)
    - **Property 13 (shell part): Shell and git arguments obey the same access rules** (sensitive for every
      command including `git`; protected only for `MUTATING_PATH_COMMANDS`; `git` exempt)
    - Examples: `rm -rf ..`, `cat ../../etc/hosts`, `ls ~`, `find /`, `cat C:\Windows\win.ini`, `ls $HOME`,
      `echo $HOME` (spawns), `cat .env`, `cp a .git/config`, `git add .gitignore` (spawns), `go test ./...`
      (spawns), absolute path inside the root (assert the actual `checkPath` outcome and document it).
    - **Validates: Requirements 3.1–3.5, 3.7, 8.1–8.3**
  - [x] 1.6 Write `tests/workspace/path-access-enforcement.spec.ts` and `tests/workspace/workspace-test-baseline.spec.ts`
    - Real `NodeWorkspaceManager`, `FilesystemExecutor` and `GitExecutor` (recording supervisor) over temp directories.
    - **Property 11 (manager part): Protected VCS metadata is write-protected and read-open**
    - **Property 12: Path rejections are failed tool results, never exceptions** (all filesystem tools;
      file unchanged)
    - **Property 13 (git part)** (`git_diff` path and `git_add` entries; no spawn)
    - **Property 15: Baseline capture matches the reference listing** (no file content read; `node_modules`,
      `.git`, `dist` skipped; case and separator invariance)
    - Examples: `grep` for a unique marker stored in `.env` never returns the marker or the path; `glob` and
      `list_dir` still list `.env`; symlink inside the workspace to `.env` and to `.git/config` is rejected
      (skip when the OS denies symlink creation); `fileExists('.env')` behaves as before; `.env.example` reads.
    - **Validates: Requirements 6.2, 6.6–6.8, 7.1, 7.2, 7.4, 7.5, 8.4, 9.1**
  - [x] 1.7 Write `tests/execution/gap-closure-task-executor.spec.ts`
    - Real `ToolGateway` with `buildToolPolicy`, scripted FakeModel, real executors over a temp directory.
    - **Property 17: Unapproved risky calls never execute** (DESTRUCTIVE and NETWORK `run_command`; no
      coordinator ends at APPROVAL_PENDING with zero executor calls; a denying coordinator continues the run)
    - Examples: a rejected path or secret read is a FAILED tool result and the next scripted step runs
      (the ToolCall is not DENIED); editing a baseline test with no coordinator ends the run at
      APPROVAL_PENDING; creating a new test file executes; with no `testBaseline` dep the edit executes
      (backward compatibility); a static check that `runtime-cli.ts` constructs `WorkspaceTestBaseline`,
      calls `capture()` beside `captureClean`, and passes the same instance to `TaskExecutor`.
    - **Validates: Requirements 3.6, 9.6, 9.7, 11.1, 11.2, 11.5**
  - [x] 1.8 Write `tests/tool/legitimate-workflows.spec.ts` (the "legitimate workflows still work" matrix)
    - Rows (each an example, real temp workspace, fake supervisor where a process would start): `npm test`,
      `node test.js`, `go test ./...`, `cargo test`, `dart test`, `python -m pytest` execute under `full`
      without approval; `rm -rf dist` asks, and executes after an approving coordinator; `write_file` of a new
      source file and of a new test file executes under `full` and `edits`; `read_file` of `.env.example`,
      `src/env.js`, `.github/workflows/ci.yml`; `edit_file` on a non-test source file under `full` and `edits`;
      `git_status`, `git_diff`, `git_add`, `git_commit`, `git_log` unchanged.
    - **Validates: Requirements 12.1–12.6**
  - [x] 1.9 Write the six invariant specs
    - `tests/invariants/security/se-011.spec.ts`, `tests/invariants/security/se-012.spec.ts`,
      `tests/invariants/tool-gateway/tg-011.spec.ts`, `tests/invariants/tool-gateway/tg-012.spec.ts`,
      `tests/invariants/tool-gateway/tg-013.spec.ts`, `tests/invariants/workspace/ws-011.spec.ts`.
    - Each is short and deterministic: one representative positive case and one negative case through the
      real implementation, named after the invariant id.
    - **Validates: Requirements 15.1**

- [x] 2. Fix the redactor
  - [x] 2.1 Change the `private-key` pattern in `packages/infrastructure/src/redaction/redactor.ts`
    - Use the bounded pattern from design D-F (`(?:[A-Z0-9]{1,16} ){0,4}PRIVATE KEY(?: BLOCK)?` in both
      header and footer, body `[\s\S]{1,32768}?`). Keep rule name, position and replacement.
    - Run `tests/security/redactor-private-key.spec.ts` and the existing redactor specs; if the 200 000
      character timing example exceeds 1 000 ms, lower the body cap to 16 384 and re-run.
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6_
  - [x] 2.2 Update the `private-key` generator in `tests/shadow-ablation/trace-format.spec.ts`
    - Add `''` to the type-word list, remove the comment that excludes the bare PKCS#8 header, run the spec.
    - _Requirements: 13.9_

- [x] 3. Pure policy and classification in `agent-core`
  - [x] 3.1 Create `packages/agent-core/src/tool/path-access-policy.ts` and extend `workspace/workspace-manager.ts`
    - `PathAccess`, `PathAccessVerdict`, `PathAccessPolicy`, `DEFAULT_PATH_ACCESS_POLICY`,
      `OPEN_PATH_ACCESS_POLICY`, `normalizeSegments`, `evaluatePathAccess`, `TEST_LIKE_DIR_SEGMENTS`,
      `isTestLikePath`; no I/O, no `node:` imports.
    - `WorkspaceErrorCode` += `SENSITIVE_PATH`, `PROTECTED_PATH`; `WorkspaceManager` gains the optional
      `checkAccess?(access, relpath)`.
    - Export from `tool/index.ts` and `workspace/index.ts` (and the package index if it re-lists names).
    - Check for exhaustive `switch` statements over `WorkspaceErrorCode` (grep) and update them.
    - _Requirements: 6.1, 6.3–6.5, 6.9, 7.1–7.3, 9.8, 10.1, 10.2_
  - [x] 3.2 Create `packages/agent-core/src/tool/shell-classifier.ts`
    - `ShellInvocation`, `ShellRisk`, `DESTRUCTIVE_COMMANDS`, `NETWORK_COMMANDS`, `MUTATING_PATH_COMMANDS`,
      `ENV_EXPANSION_EXEMPT_COMMANDS`, `normalizeInvocation`, `classifyShellInvocation`,
      `extractShellArguments` per design C2 (priority DESTRUCTIVE, NETWORK, PACKAGE_INSTALL, SYSTEM; git
      global options that take a value are skipped before the subcommand).
    - Export from `tool/index.ts`.
    - _Requirements: 2.1–2.6, 3.4, 3.5, 4.1–4.3, 5.1, 5.2, 10.1, 10.2_
  - [x] 3.3 Create `packages/agent-core/src/tool/risk-classification.ts` and wire `TaskExecutor`
    - `TestBaseline` port, `RiskContext`, `resolveToolRiskClass` per the design C3 table.
    - In `execution/task-executor.ts`: replace the private `resolveRiskClass` body with a call to
      `resolveToolRiskClass(proposal.toolName, proposal.arguments, { testBaseline: this.deps.testBaseline })`;
      add `readonly testBaseline?: TestBaseline` to `TaskExecutorDeps` with a doc comment. Do not change the
      executor prompt, the ReAct loop or the DENIED/APPROVAL_PENDING handling.
    - Export from `tool/index.ts`.
    - _Requirements: 2.1–2.5, 4.1–4.3, 5.1, 5.2, 9.2–9.5, 9.8, 10.1, 11.1_
  - [x] 3.4 Update `tool/tool-policy.ts` and the `tool/shell-policy.ts` comments
    - `buildToolPolicy`: `NETWORK` → `require_approval` for every level, `policyId` `autonomy-${level}-v2`,
      `version: 2`, updated doc comment for `'full'`. `ToolRule.deniedPaths` gets the `@deprecated` note that
      names `Path_Access_Policy`. `determineAction` is not touched.
    - `shell-policy.ts`: update the header comment for `curl`, `wget` and `rm` (classification and argument
      checks now apply) and keep `DEFAULT_SHELL_ALLOWLIST` unchanged.
    - _Requirements: 4.4, 4.5, 5.3, 7.6, 11.4_

- [x] 4. Executors, workspace and CLI in `infrastructure`
  - [x] 4.1 Enforce the Path_Access_Policy in `node-workspace-manager.ts`
    - `pathAccess?: PathAccessPolicy` dep (default `DEFAULT_PATH_ACCESS_POLICY`); `checkAccess(access,
      relpath)` on the lexical path and on the real path relative to the root when the path exists; guards in
      `readFile`, `readFileBytes` (`read`), `writeFile`, `deleteFile`, `moveFile` (`write`, both endpoints, source
      first). Actionable messages per design C6. `fileExists`, `dirExists`, `listDir` stay unguarded.
    - _Requirements: 6.2, 6.6, 6.8, 7.1, 7.2, 7.4_
  - [x] 4.2 Apply argument checks in `tools/shell-executor.ts`
    - After `checkCommand` and before the env filter and spawn: boundary check of every `pathLike` argument
      with `checkPath`, env-expansion rejection (except `echo`, `printf`), access check of every
      `fileCandidate` with `checkAccess?.()` (`write` for `MUTATING_PATH_COMMANDS`, else `read`). Failures return
      the existing exit-1 result shape. Spawn request unchanged when all checks pass.
    - _Requirements: 3.1–3.5, 3.7, 8.1–8.3_
  - [x] 4.3 Apply the sensitive-path check in `tools/git-executor.ts`
    - `gitDiff` (`path`) and `gitAdd` (`paths[]`) call `workspace.checkAccess?.('read', p)` before spawning and
      return exit 1 with the `SENSITIVE_PATH` message on rejection.
    - _Requirements: 7.5, 8.4_
  - [x] 4.4 Create `packages/infrastructure/src/workspace/workspace-test-baseline.ts`
    - `WorkspaceTestBaseline implements TestBaseline`: `capture()` lists directories only (no reads), skips
      `node_modules`, `.git`, `dist`, `build`, `coverage`, `.cache`, `.codeforge`, `.cf2`, stores normalised
      test-like paths via `isTestLikePath` and `normalizeSegments`; `isBaselineTest`, `size`. Export from the
      workspace index.
    - _Requirements: 9.1_
  - [x] 4.5 Wire the baseline in `cli/runtime-cli.ts`
    - Construct `WorkspaceTestBaseline` before `TaskExecutor`, pass it as `testBaseline`, call `await
      testBaseline.capture()` next to `workspaceRollback.captureClean(sid)` in the same non-fatal try/catch
      style (log once on failure). No new flag; the autonomy banner needs no code change (it derives from the
      policy).
    - _Requirements: 9.6, 9.8_
  - [x] 4.6 Make the new suites green
    - Run the specs from tasks 1.1 to 1.9 with `npx vitest run <paths>`; fix the implementation, not the tests,
      unless a test contradicts the design. Record any absolute-path-inside-root behavior found in 1.5.
    - _Requirements: 1.1–1.6, 2.1–2.7, 3.1–3.7, 4.1–4.5, 5.1–5.3, 6.1–6.9, 7.1–7.6, 8.1–8.4, 9.1–9.8, 12.1–12.6_

- [x] 5. Invariant registry
  - [x] 5.1 Add SE-011, SE-012, TG-011, TG-012, TG-013 and WS-011 to `invariants.yaml` and `INVARIANTS.md`
    - Same field layout as the neighbours (`statement` in Vietnamese like the file, `enforcement`,
      `violation_class`, `test`, `phase: 12`, `severity`, `status: ACTIVE`); severities per design table;
      `version` 1.11 → 1.12; place SE and TG entries in their sections, WS-011 after WS-010.
    - _Requirements: 15.1, 15.2_
  - [x] 5.2 Update the invariant count in `tests/_harness/phase0-harness.spec.ts`
    - Both assertions 181 → 187 and the comment (`+ 6 kernel gap closure`). Run the spec. This is a changed
      existing test (justification: six invariants added).
    - _Requirements: 15.2, 16.4_

- [x] 6. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 7. Update the shadow-ablation instrument
  - [x] 7.1 Observe the Path_Access_Policy in `ablation-workspace.ts` and wire `arm.ts`
    - `AblationWorkspaceOptions.pathAccess?` (oracle, default `DEFAULT_PATH_ACCESS_POLICY`); in `decide`, after
      the boundary check, evaluate `evaluatePathAccess` for the operation's access mode and record `EP-PATH`
      `block` with the code as reason; enforce rethrows `WorkspaceError(code)`, shadow records `wouldBlock` and
      proceeds against the sandbox (no `escape-simulated` event). Implement `checkAccess` the same way.
    - `arm.ts`: enforce arm uses the default-policy `NodeWorkspaceManager`; shadow arm uses
      `pathAccess: OPEN_PATH_ACCESS_POLICY` for the inner manager; both arms create and capture a
      `WorkspaceTestBaseline` after seeding, beside `captureClean(sid)`, and pass it to `TaskExecutor`.
    - _Requirements: 13.4, 13.6_
  - [x] 7.2 Add observer and containment tests, extend the SA-001 scan
    - `tests/shadow-ablation/observers.spec.ts`: `EP-PATH` rows with reasons `SENSITIVE_PATH` and
      `PROTECTED_PATH` in enforce (block, rethrow) and shadow (`wouldBlock`, operation performed in the sandbox).
    - `tests/shadow-ablation/containment.spec.ts`: no `escape-simulated` event for access rejections; shadow
      write to `.git/config` lands inside the sandbox only.
    - `tests/invariants/shadow/sa-001.spec.ts`: add a static check that no production source references
      `OPEN_PATH_ACCESS_POLICY` outside `agent-core` (definition) and `packages/testing`.
    - _Requirements: 13.4, 13.6_
  - [x] 7.3 Flip the five corpus labels and rename the gap block
    - `injection-corpus.ts`: run the enforce arms (SYN-01 to SYN-05) and set `expected.stoppedBy` for
      INJ-SHELL-02, INJ-SHELL-03, INJ-SECRET-03, INJ-PROT-01, INJ-PROT-02 from the observed stoppers
      (hypotheses: SHELL-02, SHELL-03, PROT-02 → `EP-TOOL-POLICY`/`EP-APPROVAL`; SECRET-03, PROT-01 →
      `EP-PATH`), never the kernel toward the label; remove `kernelGap: true` from them; rename the header
      block to "Closed kernel gaps" with the enforcement point and rule per entry; keep the `kernelGap`
      variant in the type; do not add corpus entries.
    - Update `tests/shadow-ablation/injection-corpus.spec.ts` (the gap-entry test no longer needs one) and
      the gap-specific expectations in `tests/shadow-ablation/harness-e2e.spec.ts`, including baseline wiring in
      its `TaskExecutor` construction; the label check over SYN-01 to SYN-05 must pass.
    - _Requirements: 13.1, 13.2, 13.3, 13.7_
  - [x] 7.4 Render the zero-gap case in `report.ts` and `comparison.ts`
    - When `gapInjected === 0`, render a "no open gap probe" section instead of an empty table; review the
      gap-related explanation strings; add a case to `tests/shadow-ablation/comparison.spec.ts`. No new
      `EnforcementPointId`.
    - _Requirements: 13.5_
  - [x] 7.5 Regenerate the synthetic reports
    - Run `node scripts/run-shadow-ablation.mjs --synthetic` and keep `.agents/kernel-shadow-ablation.synthetic.md`
      and `.json` as the committed outputs; confirm 0 open gap probes and 0 kernel misses.
    - _Requirements: 13.8_

- [x] 8. Regression sweep
  - [x] 8.1 Run the whole vitest suite and justify every changed existing test
    - `npx vitest run` (Windows) to find failures; fix the code first. Edit an existing test only when it
      asserted the old gap behavior (expected: `phase0-harness.spec.ts`, `injection-corpus.spec.ts`,
      `harness-e2e.spec.ts`, `trace-format.spec.ts`, `sa-001.spec.ts`; possibly
      `tests/approval-runtime/autonomy-policy.spec.ts` for NETWORK under `full` or `-v1` ids).
    - Write the list (file, test name, old assertion, new assertion, justification) as the "Existing tests
      changed" appendix of `.agents/kernel-gap-closure-analysis.md` (created in task 9.2; keep the list in
      `.agents/_tmp-reports/changed-tests.md` until then).
    - _Requirements: 16.4_

- [x] 9. Real-trace replay and analysis
  - [x] 9.1 Back up the previous report and run the replay
    - Copy `.agents/kernel-shadow-ablation.json` to `.agents/_tmp-reports/kernel-shadow-ablation.before.json`.
    - Run in the background (about 33 minutes on Windows; no model, no Ollama):
      `node scripts/run-shadow-ablation.mjs --traces .agents/traces/qwen35-20261104 --benchmark benchmarks/codeforge-progressive/benchmark.json`
      and read the output when it ends. The run overwrites the gitignored full report files.
    - _Requirements: 14.1_
  - [x] 9.2 Write `.agents/kernel-gap-closure-analysis.md`
    - Throwaway node scripts (deleted afterwards) parse the new and the `.before.json` report. Sections: gap
      probes now stopped (reached and stopped counts per probe, by enforcement point and reason); organic
      proposals newly stopped by a new rule (case id, step, tool, arguments preview, rule: sensitive path,
      protected path, test baseline, shell destructive, shell network, shell argument boundary), with a
      friction summary; comparison with `.agents/kernel-shadow-ablation-analysis.md` (first organic
      would-blocks previously 30 of 50, out-of-policy stopped over reached previously 415 of 415, gap probes
      previously 0 of 246, kernel misses previously 0, shadow-arm fidelity); the limits (friction by replay
      only, steps after a new stop are counterfactual, live pass-rate impact needs an Ollama run and is not
      measured); the "Existing tests changed" appendix from task 8.1. If any part of the run is missing, state
      what is missing and report no estimates.
    - _Requirements: 14.1–14.5, 16.4_

- [x] 10. Documentation sync
  - [x] 10.1 Update `SECURITY_MODEL.md` and `INFRASTRUCTURE_SPEC.md` (and the agent or tool spec if one describes ToolPolicy or the shell policy)
    - SECURITY_MODEL: new rules, threat-table rows for the five gaps and the redactor, gate order, residual
      risks (heuristics not an OS sandbox, interpreters, attached short options, 8.3 names, unterminated keys,
      package installers under `full`), the `deniedPaths` note. INFRASTRUCTURE_SPEC: `NodeWorkspaceManager`
      access rules, `ShellExecutor` argument checks, `GitExecutor`, `WorkspaceTestBaseline`. Grep
      `deniedPaths` and `DEFAULT_SHELL_ALLOWLIST` for stale claims.
    - _Requirements: 15.3, 15.4, 15.5_
  - [x] 10.2 Update `README.md`, `PROJECT_STATUS.md`, `ROADMAP.md`, `PHASE_12_SIGNOFF.md`, `EVALUATION_MODEL.md` and `.agents/failure-taxonomy.md`
    - README: "Honest limitations" (remove the five gaps and the PKCS#8 bullet, add the rules and the test-edit
      approval behavior including APPROVAL_PENDING under the Progressive_Runner), CLI/autonomy description
      (`full` now asks for NETWORK). PROJECT_STATUS: limitation 12 → closed items with residual risks, the
      shadow-ablation row, shipped list. ROADMAP item 5 → DONE with the next steps kept truthful.
      PHASE_12_SIGNOFF: addendum row `*(this commit)*`. EVALUATION_MODEL §17: replace "reported, not fixed"
      with the closure note and a pointer to the analysis. failure-taxonomy: footer note. Do not set the
      "Last updated" line yet (task 11.3).
    - _Requirements: 15.3, 15.4, 15.5_

- [x] 11. Final verification
  - [x] 11.1 Run `npm run build`, `eslint .` (0 problems) and `depcruise` (0 violations)
    - Confirm `packages/agent-core` has no import of `infrastructure` or `testing`, and no `package.json`
      dependency changed (`git diff -- '**/package.json'`).
    - _Requirements: 10.3, 10.4, 16.1_
  - [x] 11.2 Run the WSL suite `scripts/_wsl-tmp.sh` in the background (about 200 s), read the output, and compare with the baseline 2260 tests / 239 files
    - Ensure all tests pass, ask the user if questions arise.
    - _Requirements: 16.2_
  - [x] 11.3 Run `npm run gate`, confirm scope, and set the status line
    - `npm run gate` without pushing. Confirm `packages/vscode-extension` and the HTTP route table are
      unchanged (or list each change and rebuild `dist/extension.cjs` and the `.vsix`). Confirm `ToolGateway`,
      `ApprovalEngine`, `TaskGraph`, `VerificationEngine`, `CompletionGate` sources are unchanged. Set the
      `PROJECT_STATUS.md` "Last updated" line (date, "Kernel gap closure", measured test and file counts).
      Delete temp files under `.agents/_tmp-reports/`. Do not commit `*.vsix`, `packages/vscode-extension/package-lock.json`
      or logs.
    - _Requirements: 10.3, 10.4, 11.3, 16.3, 16.5, 16.6_

## Notes

- All tasks are required, including the test tasks: each new rule ships with its tests and an invariant id.
- No property-testing dependency: properties use the repo's seeded `mulberry32` generators.
- This spec intentionally changes kernel enforcement semantics; the P0 "no governance change" constraint
  does not apply, but `ToolGateway`, approval, `TaskGraph`, verification and completion sources stay untouched.
- Product decision flagged for the maintainer: the existing-test approval rule (G5). Under the
  Progressive_Runner it ends the run at APPROVAL_PENDING when the model edits a given test.
- The replay measures organic friction only; the live benchmark pass-rate impact is not measured here.
- Do not commit `*.vsix`, `packages/vscode-extension/package-lock.json`, temp logs or secrets.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "1.3", "1.4", "1.5", "1.6", "1.7", "1.8", "1.9", "2.1"] },
    { "id": 2, "tasks": ["2.2", "3.1", "3.4", "5.1"] },
    { "id": 3, "tasks": ["3.2", "4.1", "4.3", "5.2"] },
    { "id": 4, "tasks": ["3.3", "4.2"] },
    { "id": 5, "tasks": ["4.4"] },
    { "id": 6, "tasks": ["4.5"] },
    { "id": 7, "tasks": ["4.6"] },
    { "id": 8, "tasks": ["7.1"] },
    { "id": 9, "tasks": ["7.2", "7.3", "7.4"] },
    { "id": 10, "tasks": ["7.5", "8.1"] },
    { "id": 11, "tasks": ["9.1"] },
    { "id": 12, "tasks": ["9.2"] },
    { "id": 13, "tasks": ["10.1", "10.2"] },
    { "id": 14, "tasks": ["11.1"] },
    { "id": 15, "tasks": ["11.2"] },
    { "id": 16, "tasks": ["11.3"] }
  ]
}
```
