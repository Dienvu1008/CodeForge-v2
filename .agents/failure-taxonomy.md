# CodeForge v2 — Failure Taxonomy

**Version:** 1.0  
**Purpose:** Canonical classification for every benchmark failure observed during capability-curve
runs. A failure must be classified before any fix is considered. Classification drives the fix
decision — only VERIFICATION, GOVERNANCE, and INTERACTION/SEMANTIC_GAP warrant harness changes;
MODEL_CAPABILITY failures are recorded but not acted on unless they point to a missing invariant.

---

## Why taxonomy first

Without explicit classes, each failure is an anecdote. With classes, failures accumulate into
evidence: ten independent VERIFICATION failures with the same root cause → one harness fix that
protects forever. Ten MODEL_CAPABILITY failures → a signal to change the model or accept the
ceiling, not to patch the harness.

The taxonomy also enforces Goodhart's law discipline: if a proposed fix is only justified by
"it makes this benchmark case pass", that is a red flag. A fix must address a named failure class
in a way that generalises beyond the specific case.

---

## Class definitions

### 1. MODEL_CAPABILITY

**Definition.** The harness ran correctly, the context was sufficient, the verification check was
accurate — but the model's output was wrong.

**Signals.**
- Task ran to completion without abort/crash/governance event.
- Verification check ran and produced a meaningful FAIL (e.g. assertion error with specific
  values, not a toolchain crash).
- Re-running with a stronger model (same harness) produces PASS.
- No invariant is violated in the event log.

**Examples.**
- Off-by-one logic error in the produced code (model wrote `i < n` instead of `i <= n`).
- Model wrote correct syntax for each file but forgot cross-file imports (this may also be
  INTERACTION/SEMANTIC_GAP if the harness had no mechanism to detect it).
- Model reasoned correctly about the fix but stopped before writing it (`done` without mutation).

**Fix decision.** Record the pattern. Do NOT patch the harness prompt or few-shot to "teach" the
model to avoid this specific error — that is overfitting. Exception: if the same pattern appears
in ≥3 independent cases with different models, it may indicate a missing *structural* hint (e.g.
IMPORT_REMINDER for cross-file wiring) — but the hint must be *generalised*, not benchmark-shaped.

---

### 2. PLANNING

**Definition.** The model produced a task graph that was wrong before execution started: wrong
language, missing a required step, incorrect dependency ordering, or over-decomposed.

**Signals.**
- Session state shows PLANNING_FAILURE or a task graph that structurally cannot reach PASSED.
- The generated tasks name files in the wrong language (e.g. `.ts` for a Dart goal).
- The plan omits a necessary intermediate step (e.g. creates the caller but not the module).

**Sub-classes.**
- `PLANNING/LANGUAGE_BIAS` — wrong language despite explicit goal (was the dominant failure before
  P12.24 language inference).
- `PLANNING/MISSING_STEP` — correct language, task graph structurally incomplete.
- `PLANNING/OVER_DECOMPOSE` — so many tasks that dependency chain is fragile.

**Fix decision.** Language inference, few-shot neutrality, language-hint injection. Fixes must
be deterministic and generalise across all languages, not only those in the benchmark.

---

### 3. CONTEXT

**Definition.** The model did not have the information it needed: a file was not in the context
window, a relevant symbol was not retrieved, or an import graph edge was missing.

**Signals.**
- Model wrote code that references a name/API that does not exist in the workspace (invented).
- Model correctly described what to do but edited the wrong file (wrong path).
- Model wrote partial fix: correct in files it "saw" but missed a file not retrieved.

**Sub-classes.**
- `CONTEXT/MISSING_FILE` — relevant file ranked too low and was truncated.
- `CONTEXT/MISSING_SYMBOL` — symbol from an unindexed file was used without knowledge of its
  actual signature.
- `CONTEXT/RETRIEVAL_ORDER` — wrong file ranked higher than the actually-relevant one.

**Fix decision.** Retrieval ranking, LSP integration, context-collector scope. Fixes must be
measured against a *diverse set* of retrieval scenarios, not only the failing benchmark case.

---

### 4. VERIFICATION

**Definition.** The verification check itself produced an incorrect verdict — either a false FAIL
(correct code flagged as wrong) or a false PASS (wrong code let through).

**Sub-class: VERIFICATION/ENV_MISSING.**
The check command could not run because a required environment variable, toolchain, or cache
directory was missing from the spawned process's environment. The root cause is the harness's
`buildCheckEnv`, not the model.
- Signal: `exit -1`, "not found", "LOCALAPPDATA not defined", "GOCACHE not defined".
- Example: Dart `pub get` failing with "No LOCALAPPDATA" (fixed in P12.29).
- Fix: add the missing variable to `TOOLCHAIN_ENV_PASSTHROUGH`.

**Sub-class: VERIFICATION/TOOLCHAIN_CRASH.**
The check tool itself crashed or timed out for reasons unrelated to the model's code correctness.
- Signal: exit code < 0, "Oops; flutter has exited unexpectedly", `TIMED OUT`.
- Example: `flutter test` crashing with null-pointer on a headless machine.
- Fix: demote the crashing check to non-blocking or replace with a more stable check.

**Sub-class: VERIFICATION/FALSE_PASS.**
The check ran and exited 0 but the code is actually wrong. This is a semantic gap in the check
design — not a model failure. Most commonly: a check that only asserts a file exists, not that
it has the right content; or a check that runs a test suite that does not cover the affected code.
- Signal: task PASSED but manual inspection shows incorrect behaviour.
- Example: `file_exists` check passes even though the file is empty.
- Fix: strengthen the check (add `file_contains`, add a behavioural command check).

**Sub-class: VERIFICATION/WRONG_CLASSIFICATION.**
The check ran and produced a meaningful FAIL, but the `FailureClassifier` assigned the wrong
class (e.g. classified a lint/analyze failure as TOOL instead of SYNTAX), causing the wrong
recovery policy to fire.
- Signal: recovery policy fires ESCALATE with only 2 attempts when more retries would have
  succeeded; or FIX retries when ROLLBACK would have been appropriate.
- Example: `flutter analyze` compile error classified as TOOL (2-attempt cap) instead of SYNTAX
  (FIX→ROLLBACK→ESCALATE, 3 attempts) — observed in the Flutter todo run.
- Fix: tighten the `classifyFailure` heuristics in `failure-classifier.ts`.

**Fix decision.** Verification fixes are always legitimate harness improvements — they make the
external verdict more accurate. The test: "does this fix improve verdict accuracy on a codebase
we have never seen before?" If yes, it generalises. If it only fixes one benchmark pattern, it is
overfit.

---

### 5. GOVERNANCE

**Definition.** The orchestration layer (session lock, recovery loop, approval gate, budget)
produced an incorrect outcome: a session was aborted that should have continued, a recovery
action fired incorrectly, or a budget was exhausted prematurely.

**Sub-classes.**
- `GOVERNANCE/STALE_LOCK` — workspace lock not released after crash; new session blocked.
  Fixed in P12.23 with `reclaimStale()`.
- `GOVERNANCE/PREMATURE_ABORT` — session ABORTED before recovery had a chance to fix the issue.
- `GOVERNANCE/RECOVERY_LOOP` — recovery chose the wrong action for a failure class (e.g. ROLLBACK
  when the file was correct, FIX when the file was structurally wrong).
- `GOVERNANCE/OVER_APPROVAL` — approval gate blocked a tool call that the autonomy level should
  auto-approve.

**Fix decision.** Governance fixes are always legitimate — they ensure the runtime enforces its
contracts. Each fix must correspond to a named invariant (RC-*, TG-*, SS-*). If no invariant
covers the failure, the taxonomy says "either fix the runtime or add the invariant — not both
without review."

---

### 6. INTERACTION

**Definition.** Neither the model nor the harness is individually wrong, but their combination
produces an incorrect outcome. These are the hardest failures to diagnose because each component
passes its own unit tests.

**Sub-class: INTERACTION/SEMANTIC_GAP.**
The model produced syntactically valid, structurally correct code, but semantically wrong — and
no check or invariant caught it. The harness has a *gap* in semantic coverage.
- Signal: task PASSED (all checks green), but the produced behaviour is incorrect under a test
  not included in the benchmark case.
- Example: model adds `import '../models/todo.dart'` (correct syntax) but imports the wrong
  module (wrong path). `dart analyze` passes, `dart test` passes, but a different test would fail.
- Fix: add a stronger behavioural check to the benchmark case, OR add a semantic invariant that
  catches this class of error. Do NOT patch the model prompt.

**Sub-class: INTERACTION/OVER_RESTRICT.**
The harness rejected a model output that was correct according to the spec.
- Signal: task FAILED, but manual inspection of the model's output shows it satisfies the
  acceptance criteria.
- Example: a tool call was denied by the autonomy gate because the path pattern matched a
  DESTRUCTIVE heuristic, but the operation was actually safe.
- Fix: loosen the specific heuristic, with evidence that the change does not weaken safety on a
  held-out set.

**Sub-class: INTERACTION/PROTOCOL.**
The model produced correct individual tool calls but in the wrong order, causing the harness to
reject a valid intermediate state.
- Signal: task FAILED at VERIFICATION with a state that would be correct if a prior step had
  not been skipped; the event log shows the missing step was never proposed.
- Example: model edits `checkout.js` before creating `discount.js`, causing an import error on
  the first verification attempt and burning recovery budget.
- Fix: planning prompt or task decomposition guidance. The fix must be generalised (not a
  per-case rule about checkout.js and discount.js).

---

## Decision table

| Class | Fix harness? | Fix model/prompt? | Add invariant? | Record only? |
|---|---|---|---|---|
| MODEL_CAPABILITY | ❌ usually | ✅ if generalises | ✅ if gap identified | ✅ always |
| PLANNING | Partial | ✅ language/few-shot | — | ✅ |
| CONTEXT | ✅ retrieval | — | — | ✅ |
| VERIFICATION/ENV_MISSING | ✅ | ❌ | — | ✅ |
| VERIFICATION/TOOLCHAIN_CRASH | ✅ | ❌ | — | ✅ |
| VERIFICATION/FALSE_PASS | ✅ stronger check | ❌ | ✅ if pattern | ✅ |
| VERIFICATION/WRONG_CLASSIFICATION | ✅ classifier | ❌ | — | ✅ |
| GOVERNANCE | ✅ | ❌ | ✅ must cite invariant | ✅ |
| INTERACTION/SEMANTIC_GAP | ✅ check or invariant | ❌ | ✅ | ✅ |
| INTERACTION/OVER_RESTRICT | ✅ heuristic | ❌ | — | ✅ |
| INTERACTION/PROTOCOL | Partial | ✅ decomposition | — | ✅ |

---

## Held-out discipline

Cases tagged `"heldOut": true` in the benchmark dataset are **never used to justify a harness
fix**. Their only role is to measure whether a fix applied to the training set generalised.

A fix is considered sound if:
1. It improves ≥1 training-set case.
2. It does not regress any held-out case.
3. Its failure class is documented here (not invented post-hoc).

A fix that passes criterion 1 but fails criterion 2 is overfit — it must be revised or reverted.

---

## Ablation protocol

When a failure is ambiguous (MODEL_CAPABILITY vs INTERACTION), run ablations:

1. **Governance ablation** (`--no-recovery`): disable recovery loop. If PASS → `GOVERNANCE/RECOVERY_LOOP`.
2. **Context ablation** (strip workspace files from context): if model now invents wrong names → confirms `CONTEXT/MISSING_FILE`.
3. **Model swap**: run with a stronger model (API). If PASS → `MODEL_CAPABILITY`; if still FAIL → `VERIFICATION` or `INTERACTION`.
4. **Check relaxation**: temporarily swap a check for a weaker one. If task now PASSES → `VERIFICATION/WRONG_CLASSIFICATION` or `OVER_RESTRICT`.

Ablation results should be recorded alongside the failure classification.

---

## Classification checklist (per run)

For each failing case after a benchmark run:

- [ ] Read the event log: what was the final failure class in `TASK_FAILED` payload?
- [ ] Read the check output: what did the check command print?
- [ ] Did a toolchain env error appear (LOCALAPPDATA, GOCACHE, etc.)? → `VERIFICATION/ENV_MISSING`
- [ ] Did the check tool crash/timeout unrelated to code? → `VERIFICATION/TOOLCHAIN_CRASH`
- [ ] Did the model complete all tool calls before VERIFYING? → if yes, likely MODEL_CAPABILITY
- [ ] Does the model output satisfy the spec if you read it manually? → if yes, `VERIFICATION/FALSE_PASS` or `INTERACTION/OVER_RESTRICT`
- [ ] Is the same failure observed with a different model? → if yes, `VERIFICATION` or `GOVERNANCE`
- [ ] Assign the class, record the `sessionId`, note the `heldOutAxis` if applicable.

---

*Last updated: P12.31. Maintained in `.agents/failure-taxonomy.md`. Reference this document before
filing any harness bug or proposing a prompt change.*
