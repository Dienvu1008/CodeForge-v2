# DOGFOOD_RESULTS.md

**Phase 10 — P10.7 empirical dogfood run.** Honest measurement of CodeForge v2 running
real tasks end-to-end against a local Ollama model. This is the empirical substrate the
roadmap asks for (exit criterion #8): behaviour measured with evidence, not claims.

- Model: `qwen2.5-coder` (7B class) via Ollama `http://localhost:11434`
- Autonomy: `full` (reads + edits + commands auto-approved; DESTRUCTIVE still asks)
- Runtime: single long-running process; goals submitted via the first `--goal` plus
  `POST /goal` (P10.9 queue). Each goal ran as its own session through the full kernel
  path (Planner → GraphCommit → scheduler → TaskExecutor → verification → recovery).
- Workspace: a tiny npm project with a deliberately buggy `multiply` (returns `a+b`) and
  a `test.js` asserting multiplication, so `npm test` starts red.

## Per-task metrics (from the live `/metrics` endpoint — DogfoodMetrics)

| Task | Kind | Outcome | Task runs | Verif pass/fail | Tool calls | Events | Produced the artifact? |
|------|------|---------|-----------|-----------------|-----------|--------|------------------------|
| Fix `multiply` | bugfix | escalated → aborted | 2 | 0 / 2 | 2 | 36 | ❌ `multiply` left as `a+b` |
| Create README.md | docs | escalated → aborted | 2 | 0 / 1 | 30 | 172 | ✅ README.md written, sensible content |
| Add `square(n)` reusing `multiply` | feature | escalated → aborted | 2 | 0 / 0 | 56 | 298 | ✅ `square` added, correctly reuses + exports `multiply` |

(“escalated → aborted”: the run ended `AWAITING_HUMAN` because the strict completion gate
withheld PASSED while `npm test` was still red; the goal-queue worker then aborts the
unresolved session to release the workspace lock for the next goal — see Findings.)

## What works (verified end-to-end, real model)

- **Runtime machinery is solid.** The goal queue drained three goals back-to-back, each in
  its own session, with the full governance kernel in the loop. No crashes, no orphans.
- **The agent produces correct code.** The feature task added `square(n)` that **reuses the
  existing `multiply` symbol** and exports it — direct evidence that context wiring (P10.3)
  feeds the real codebase to the model. The docs task produced a reasonable README.
- **The completion gate is honest.** No task was marked PASSED while `npm test` was red.
  Verification is the source of truth (P10.1), exactly as intended — the agent cannot
  “claim” success.
- **Recovery + escalation are bounded.** Red verification drove recovery; when the model
  could not converge, the session escalated to a human rather than looping forever (P10.2).

## What is weak (honest)

- **7B execution quality is the bottleneck, not the runtime.** `qwen2.5-coder` frequently:
  - over-decomposes a one-line change into 2 tasks (even after the P10.4 prompt work);
  - leaves a pre-existing failing test unfixed while doing adjacent work (it added
    `square` but never fixed `multiply`, so `npm test` stayed red);
  - burns many tool calls (56 on the feature task) without reaching a green state.
- **Net task-PASSED rate on this run: 0/3.** The agent did real, correct work on 2 of 3
  tasks, but none reached a fully green `npm test`, so none PASSED under the strict gate.
  This is a model-capability ceiling; the same loop with a stronger model (or a workspace
  whose only failing test is the one being targeted) is expected to pass.

## Fix made during dogfood (P10.7)

- **Workspace-lock leak across queued goals.** A goal ending `AWAITING_HUMAN` is a
  NON-TERMINAL session, so it kept the workspace lock (SS-001: one agent per workspace).
  The next goal’s `SessionService.create` then threw `LOCK_HELD` and crashed the worker.
  Fix: after a run, if the session is still `AWAITING_HUMAN`, the goal-queue worker aborts
  it (releasing the lock) before the next goal; the worker also catches per-goal errors so
  one bad goal never takes down the queue. Verified: 3 goals now run back-to-back cleanly.

## Takeaway

The deterministic runtime — verification, recovery, context, planning, policy/approval,
goal ingress, streaming/progress — is working together end-to-end against a real model.
The remaining gap to a high task-success rate is **model capability at execution time**,
which the architecture already accommodates (swap in a stronger model; the kernel,
gating, and observability are unchanged). Measured, not claimed.

---

## Addendum — model comparison: `deepseek-r1:14b` (post-sign-off probe)

To decide whether a stronger model closes the task-success gap before building a UI, the
bugfix task (`multiply` returns `a+b`, test expects `a*b`) was re-run with `deepseek-r1:14b`
(a 14B reasoning model) under the same runtime, autonomy `full`.

| Dimension | `qwen2.5-coder` (7B) | `deepseek-r1:14b` |
|-----------|----------------------|-------------------|
| Fixed the actual bug? | ❌ left `multiply` as `a+b` | ✅ changed `multiply` to `a*b` (correct) |
| Reached a green test / PASSED? | ❌ | ❌ (see failure mode) |
| Latency per ReAct decision | ~2–3 s | ~90 s (14B + reasoning tokens) |
| Behaviour | under-performs: gives up / escalates | over-reaches: rewrites `test.js` to assert a `square` function that does not exist, breaking the suite it was supposed to make pass |
| Time on a one-line fix | ~8–17 s total | still looping after ~11 min (8 decisions of a 28-step budget) |

**Correctness signal (good):** the stronger model DID fix the real bug that the 7B model
could not — direct evidence that model capability is the lever, and that the runtime
machinery (planning, context, tool execution, the `<think>`-block parse) works unchanged with
a reasoning model.

**New failure mode (important):** `deepseek-r1` went off-task — after fixing `multiply` it
rewrote `test.js` to test an unrelated `square()` (undefined), so `npm test` stayed red by its
own doing. This is not a model-is-weak problem; it is an **under-specified instruction +
unconstrained tool scope** problem: nothing told the agent "make the EXISTING test pass; do
not change the test." A stronger model with more initiative is more likely to "improve" things
it was not asked to touch.

**Latency signal (operational):** at ~90 s per decision, a 14B reasoning model on this
hardware is too slow for an interactive UI loop. It is viable for background/batch autonomy,
not for a live chat where a user waits.

### What this tells us about building the UI now

- Raising model capability alone does **not** yield a reliable task-success rate — the 14B
  model failed the same task a different way. The next, cheapest lever is **executor-prompt
  constraints** (e.g. "satisfy the existing tests; do not modify test files unless asked";
  "stop once verification is green"), not a bigger model and not a UI.
- Therefore: **still too early for a full chat UI.** A thin read-only observability dashboard
  (consume `/stream` + `/state` + `/metrics`) is useful now for diagnosing exactly these
  behaviours; a goal-submitting chat UI should wait until the executor prompt + a small
  regression dogfood show a dependable task-PASSED rate.

---

## Addendum 2 — after tightening the executor prompt (P10.7+)

The two failure modes above (7B under-performs / leaves the pre-existing failing test
unfixed; 14B over-reaches and rewrites `test.js`) were addressed with a **prompt-only**
change to `TASK_EXECUTOR_SYSTEM_PROMPT` + `buildTaskPrompt` in `task-executor.ts`. No
kernel, verification, policy, or invariant was touched; determinism is preserved (temp=0).
"Don't edit test files" is model *guidance*; the CompletionGate still requires a real green
test (TI-005), so the change cannot let a false PASS through.

What changed:

- A short, strict RULES block: (1) SCOPE — change only what the task asks, don't edit
  `test.js`/`*.test.*`/`*.spec.*` or acceptance criteria, fix the SOURCE not the test;
  (2) CONTENT — `write_file` needs complete real content, no empty/stub; (3) STOP — once the
  checks pass, respond `done` on the next turn, stop exploring; (4) NO REPEATS.
- A deterministic, transcript-derived nudge (`looksLikeChecksPassed`): when the latest
  check command in the transcript exited 0 with clean output, the next prompt tells the agent
  the checks have PASSED and to emit `done` now. This is a read of the transcript, not model
  output — it does not decide completion, it only reduces post-green looping.
- The verify hint now points at the project's own checks (`run_command {"command":"npm test"}`).

### Re-run (same 3 tasks, workspace reset to clean baseline between runs)

| Task | Model | Fixed/added correctly? | Touched test files it shouldn't? | `npm test` green on disk? | Run outcome | Wall time |
|------|-------|------------------------|----------------------------------|---------------------------|-------------|-----------|
| bugfix: `multiply` a+b→a*b, don't edit test.js | qwen2.5-coder 7B | ✅ fixed source to `a*b` | ✅ no — `test.js` untouched | ✅ green | COMPLETED, 3/4 tasks PASSED | 33.4 s |
| feature: add `square` reusing `multiply` | qwen2.5-coder 7B | ✅ `square(n)=multiply(n,n)`, exported | ✅ only added `square` asserts (task asked for it) | ✅ green | COMPLETED, 2/2 PASSED | 37.0 s |
| docs: README for the two exports | qwen2.5-coder 7B | ✅ README matches real exports; code/test untouched | ✅ no | ✅ green | COMPLETED, 4/4 PASSED | 15.0 s |
| bugfix (confirm) | deepseek-r1:14b | ✅ fixed source to `a*b` | ✅ **no — `test.js` untouched (was the old failure)** | ✅ green | did **not** emit `done` (still looping at step budget) | >14 min, stopped manually |

### Honest read

- **qwen2.5-coder went from 0/3 → 3/3** task-PASSED on the same tasks after the prompt
  tightening. The bugfix the 7B model previously could not land now lands and reaches a green
  `npm test`; the feature and docs tasks are correct and in-scope; no empty files; no stray
  edits to test files. Each run finished in 15–37 s.
- **deepseek-r1:14b's over-reach failure mode is fixed**: it no longer rewrites `test.js`,
  and it produced the correct source fix (green on disk). This is the specific behaviour the
  SCOPE rule targeted.
- **deepseek-r1:14b's convergence/latency problem is NOT fixed by the prompt.** The correct
  fix sat green on disk for >10 min while the model kept reasoning and never emitted `done`;
  the run was stopped manually. At ~90 s/decision this model remains unsuitable for an
  interactive loop regardless of prompt. Prompt wording cannot make a slow reasoning model
  converge quickly.
- One cosmetic nit: in the docs task the README duplicated the `## square(n)` heading (two
  usage examples under repeated headers). Content is correct and in-scope; purely stylistic.

### Caveat on the numbers

This is a 3-task smoke suite on a tiny single-file project, not a benchmark. "3/3" means the
tightened prompt removed the *specific* dogfood-observed failure modes on *these* tasks with
qwen2.5-coder; it is not a general success-rate claim. A larger, varied task set is still
needed before trusting the agent broadly.

### Revised UI stance

With a fast 7B model now landing all three tasks green and in-scope, the substrate is closer
to "valuable", not just "ready". A **thin read-only observability dashboard** (`/stream` +
`/state` + `/metrics`) is clearly worth building now. A **goal-submitting chat UI** is more
defensible than before but should still be gated on a broader regression dogfood — and should
pair with a fast model (7B), since the 14B reasoning model's latency makes a live chat loop
painful. Determinism and the strict completion gate are unchanged, so the UI only ever
observes/triggers; it never decides success.

---

## Addendum 3 — second prompt pass: transcript feedback + stronger rules (P10.7++)

A review of ALL prompt-generation sites (executor system prompt, `buildTaskPrompt`, the
planner prompt, and the security boundary preamble) surfaced one real waste **bug** and a
few guidance gaps. Fixes are prompt/transcript-only — no kernel, verification, policy, or
invariant touched; temp=0 determinism preserved; the CompletionGate still owns PASSED.

What changed in `task-executor.ts`:

1. **Duplicate tool call no longer dropped silently (the bug).** When the idempotency engine
   detected a repeat MODIFY call, the loop did `continue` and wrote *nothing* to the
   transcript — so the model saw no result and tended to repeat the call again. Now the skip
   is recorded as a transcript line ("SKIPPED: duplicate … do NOT repeat it"), which closes a
   real loop source and reinforces the NO REPEATS rule.
2. **Two new executor RULES.** READ RESULTS (if a prior step shows ERROR / non-zero exit, fix
   that root cause before continuing) and VERIFY (after changing code, run the checks and
   confirm they pass before saying done). The reminder line in `buildTaskPrompt` matches.
3. **write_file framed as a whole-file replace.** The tool description and RULE 2 now say
   write_file replaces the WHOLE file — read it first and keep unrelated lines — to curb the
   "rewrite the file from scratch" habit that produced stray edits.
4. **Truncation is now signalled.** Transcript results are still clipped (2000 chars stored,
   800 shown) but now carry a `…[truncated]` marker so the model doesn't mistake a clipped
   result for the full output.

### Re-run (same 3 tasks, workspace reset between runs)

| Task | Model | Correct & in-scope? | test files untouched? | npm test green | Run outcome | Wall time |
|------|-------|---------------------|-----------------------|----------------|-------------|-----------|
| bugfix | qwen2.5-coder 7B | ✅ `a*b` | ✅ | ✅ | COMPLETED 3/4 PASSED | 40.6 s |
| feature `square` | qwen2.5-coder 7B | ✅ reuses+exports `multiply`, adds asserts | ✅ (added asserts only) | ✅ | COMPLETED 2/2 PASSED | 28.2 s |
| docs README | qwen2.5-coder 7B | ✅ full README; code/test untouched; **no duplicate heading this time** | ✅ | ✅ | COMPLETED 4/4 PASSED | 22.8 s |
| bugfix (confirm) | deepseek-r1:14b | ✅ `a*b` | ✅ | ✅ | **COMPLETED 1/1 PASSED** (converged on its own) | 532 s |

### Honest read

- **qwen2.5-coder stays 3/3**, and the docs output improved (the earlier duplicated
  `## square(n)` heading is gone; the README now has structured Parameters/Returns + runnable
  examples). No regression from the extra rules — the small model did not get lost.
- **deepseek-r1:14b now CONVERGES.** The previous pass had it produce the correct fix but then
  loop past its budget and never emit `done` (stopped manually at >14 min). This pass it
  reached `done` by itself — **COMPLETED 1/1 PASSED** in 532 s, one task (no over-decompose),
  test.js untouched. The STOP/VERIFY/READ-RESULTS rules plus the duplicate-skip feedback are
  the plausible cause; this is a single run, so treat it as encouraging, not proven.
- **Latency unchanged and still the gate.** 532 s (~9 min) for a one-line fix confirms the
  14B reasoning model is background-only, never interactive — a model property no prompt
  fixes. Fast 7B at 20–40 s/task remains the model to pair with any UI.

### Caveat

Still a 3-task smoke suite on a one-file project, not a benchmark. The result shows the
specific dogfood failure modes (silent-duplicate loops, over-reach into test files,
non-convergence) are addressed on these tasks; it is not a general success-rate claim. A
broader, varied task set is the right next measurement before trusting the agent widely.

---

## Addendum 4 — Phase 11 learning plane wired into the live runtime (P11.6)

The learning plane (SelfModel → LearningStore → RecoveryAdvisor → AdviceGate) was wired into
the `SessionOrchestrator` and exposed via a `--learning on|off` CLI flag (default off). When on,
the orchestrator asks the RecoveryAdvisor (seeded from persisted cross-session lessons merged
with the current task's history) for a recovery try-order, clamps it through the AdviceGate, and
passes it to `decide()`. After each goal the CLI distills the session's recovery history into
persisted lessons for future sessions. When off (or any advisor dep unwired), the orchestrator
is byte-identical to Phase 10 (LE-002).

### What was verified live (qwen2.5-coder, `--learning on`)

- **The plane wires end-to-end.** Startup banner shows `Learning: ON`; a run that hit recovery
  persisted a lesson (`Learning: persisted 1 lesson(s)`), and the `learning_lessons` row is
  correct: `(UNKNOWN, ESCALATE) → 1/1` with provenance.
- **Flag-off safety holds.** A clean run (`COMPLETED 3/3`) was identical to the Phase 10 path;
  the learning write only happens post-run and never altered the decision.

### Honest result: 0 advised decisions — and WHY (this is the valuable finding)

Across the dogfood sessions, the advisor produced **zero** actual reorderings. The reasons are
structural, not bugs, and they tell us what the advisor needs to be useful:

1. **Single-element allowed-sets can't be reordered.** The failing session's class was `UNKNOWN`,
   whose policy allowed-set is `['ESCALATE']`. There is nothing to reorder, so the gate correctly
   collapses any advice to null (LE-003). The one lesson learned — `(UNKNOWN, ESCALATE)` — is
   therefore inert by construction.
2. **A single short task has too little signal.** The advisor needs ≥2 terminal samples for a
   given (class, action) before it trusts a success rate (minSamples), and it needs *different*
   actions to compare. One bugfix task produces 1–2 recovery actions of the *same* action — never
   enough to rank one action above another within a session.
3. **The recovery success signal is NOISY (the real blocker).** `RecoveryEngine` records
   `outcome = SUCCEEDED` for RETRY/FIX as soon as the attempt is *authorized*, NOT based on
   whether the retried run ultimately passed verification. So a lesson says "RETRY succeeded"
   even when the retry later failed. Learning from this signal would be learning from noise.

### What this means (measured, not claimed)

- The architecture integrates cleanly and safely — zero-authority held, flag-off parity held,
  lessons persist with provenance and bounds. The wiring is correct.
- But the advisor cannot yet add measurable task-success value, because the **outcome signal it
  learns from does not reflect real recovery success**, and the local-model dogfood tasks are too
  short/one-shot to accumulate comparative history. These are the next things to fix BEFORE
  claiming learning improves outcomes:
  1. Make `RecoveryAction.outcome` reflect the *verified* result of the retried run (did the next
     verification pass?), not merely "attempt authorized". This is the highest-value change.
  2. Accumulate lessons across many varied sessions (a real benchmark/fixture suite), so the
     advisor has comparative (class, action) history with enough samples.
- Until then, `--learning on` is safe to ship (it cannot hurt — worst case it is a no-op) but
  should not be presented as improving success rates. Honest status: **integrated and safe,
  value not yet demonstrated.**
