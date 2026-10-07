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
