# Interaction benchmark — Qwen3.5 (9B Q4_K_M, Ollama 0.40.13), first run

Date: 2026-10-31. Benchmark: `benchmarks/codeforge-interaction` v0.1.0 (12 cases, 4 held out).
Runner: `scripts/run-progressive.mjs Qwen3.5:latest --benchmark … --split all --interaction <arm>`.
Logs: `bench-ix-qwen35-off.log`, `-assume.log`, `-ask.log`, `-ask-debug.log` (ask arm re-run with
`CF_DEBUG=1`: workspace files, written tool arguments, raw model responses, full check output).

## Results

| Arm | Pass | Vague asked | Plan options offered | Failure classes (runner) |
|---|---|---|---|---|
| off (no mission stage) | 0/12 | — | — | VERIFICATION_FAILURE 12 |
| assume (Tier B1/B2) | 0/12 | 0/6 | 0/6 | VERIFICATION 11, PLANNING 1 |
| ask (Tier C, simulated user) | 0/12 | 4/6 | 6/6 (user pick 6) | VERIFICATION 11, IMPLEMENTATION 1 |
| ask, debug re-run | 1/12 (IV-02) | 4/6 | 6/6 (user pick 6) | VERIFICATION 11 |

**Headline:** no measurable effect of asking or plan options on this model. The two ask runs differ
by one case (IV-02), which is the noise level. The interaction *mechanics* worked (questions were
asked and answered, options proposed and picked), but the outcome is dominated by four upstream
failure causes, two of them in the harness. Asking cannot help while those are in place.

Environment caveat: Ollama ran **100% on CPU** (the RTX 5060 was not used), ~25 min per arm, and the
llama-server process crashed once mid-run (that run was discarded). One planner call timed out at
300 s in an earlier diagnostic run.

## Per-case classification (ask debug run)

| Case | Split | Detected | What happened | Class |
|---|---|---|---|---|
| IV-01 | train | UNKNOWN, asked 2q | right file `temp.js`, wrong values (AssertionError) | MODEL_CAPABILITY |
| IV-02 | train | UNKNOWN, asked 3q | `slug.js` correct | PASS |
| IV-03 | train | INFERRED, assumed | wrote `word_count.sh` (bash); intent never reached the agent | INTERACTION/DETECTION_MISS |
| IV-04 | train | INFERRED, assumed | `Money.js` class, file starts with a stray `/` → SyntaxError | INTERACTION/DETECTION_MISS + MODEL_CAPABILITY/OUTPUT_CORRUPTION |
| IV-05 | held out | UNKNOWN, asked 2q | Planner task "simple input validation function" → `validate()`; the done summary *claims* `isValidEmail` | INTERACTION/ANSWER_NOT_PLANNED |
| IV-06 | held out | UNKNOWN, asked 2q | Planner task "Create a Python script…" → `date_ops.py` although the answer said `dates.js` (CommonJS) | INTERACTION/ANSWER_NOT_PLANNED |
| IM-01 | train | KNOWN, plan o2 (user) | simulated user picked the **library** option; Planner installed `csv-parse`, `npm install` correctly denied, done with only `package.json` | BENCHMARK/SIMULATED_USER_MISPICK (+ MODEL_CAPABILITY premature done) |
| IM-02 | train | INFERRED, plan o1 (user) | `cache.js` starts with `//**` → SyntaxError | MODEL_CAPABILITY/OUTPUT_CORRUPTION, undetected (VERIFICATION/NO_INRUN_CHECK) |
| IM-03 | train | KNOWN, plan o1 (user) | `createLimiter(limit, windowMs)` positional, goal stated `createLimiter({ limit, windowMs })` | MODEL_CAPABILITY |
| IM-04 | train | KNOWN, plan o2 (user) | `todos.js` starts with `/\n *` → SyntaxError | OUTPUT_CORRUPTION, undetected |
| IM-05 | held out | INFERRED, plan o3 (user) | `md2html.js` starts with `/function` → SyntaxError | OUTPUT_CORRUPTION, undetected |
| IM-06 | held out | INFERRED, plan o1 (user) | `events.js` starts with `/const` → SyntaxError (also seen in the off arm) | OUTPUT_CORRUPTION, undetected |

### Cause 1 — output corruption, undetected (5/12 in one run; ≥3 training cases)

The model's raw JSON tool call already contains the stray `/` (`{"path":"events.js","content":"/function createEmitter() {…`),
so the harness does not introduce it (the Ollama adapter returns `raw` as-is; the validator only
strips `<think>` and fences). It looks like a broken `/**` doc-comment opener under JSON-grammar
sampling. It is a model/sampler defect (record, do not prompt-patch).

What turns it into a failure is a **harness gap**: these workspaces have no test script, so
`buildVerificationPolicy(inspectProject(ws))` returns **zero checks**. A file that does not even parse
is accepted as COMPLETED, and the recovery loop (worth ~10 cases on the progressive curve) never
runs. The progressive cases have `npm test`, which is why the control cases PG-01..04 still pass 4/4
in the same environment. → `VERIFICATION/NO_INRUN_CHECK`.

### Cause 2 — clarification answers never reach the Planner (structural)

Code inspection: `SessionOrchestrator` passes the stage's `assumptions` (including the
`[user-provided]` statements) only to `TaskExecutorRequest.goalAssumptions`;
`planner.plan(...)` receives the goal description, the prompt plan, the language hint and (Phase 2)
the chosen approach, but **not the clarification answers**. The Planner therefore decomposes the
vague goal as if nobody had answered ("Create a Python script that handles basic date operations"),
and the executor follows the task over the stated assumption, sometimes while echoing the
assumption in its done summary (IV-05). → `INTERACTION/ANSWER_NOT_PLANNED`.

Held-out note: the two clearest examples (IV-05, IV-06) are held-out cases. They do not justify the
fix; the justification is the structural gap found in the code, the same path that already carries
`CHOSEN_APPROACH`. Held-out cases will measure whether the fix generalises.

### Cause 3 — detection recall (2/6 vague goals not asked)

"write a tool for word counts" and "make a helper that handles money stuff" score INFERRED (one
signal), so the gate does not ask and Tier B1 assumes. That is the detector working as designed; the
assumption was simply wrong. Do **not** tune the analyzer on these two cases (overfitting); a recall
study needs a broader, independent set of vague goals.

### Cause 4 — simulated user mis-pick (benchmark apparatus)

IM-01: the user wants "Node built-ins only" and quoted-field parsing. Its keywords `quoted`/`quote`
matched the **library** option's pros ("Handles edge cases like quoted fields…"), while the built-in
option's "Zero external dependencies" matched none of `no dependenc` / `no external`. The simulated
user only has positive keywords, so it cannot express a must-not. This is a defect in the measuring
instrument, not in the agent.

## Recommendations (ordered; each must be re-measured on all three arms)

1. **Thread clarification statements into the Planner** (a bounded `USER_CLARIFICATIONS` section, the
   same mechanism as `CHOSEN_APPROACH`; absent ⇒ prompt byte-identical). General: affects every
   clarified goal, not a benchmark pattern.
2. **In-run syntax check when a project has no test command** (e.g. `node --check` on changed `.js`
   files; the same idea for other languages with a cheap parse check). This is a verdict-accuracy
   fix on any codebase and gives the existing SYNTAX recovery (FIX → ROLLBACK) something to act on.
3. **Simulated user: add `avoid` keywords** (must-not constraints score negative, e.g. `library`,
   `npm`, `third-party`, `dependency` for IM-01/IM-04/IM-05). Only the instrument changes; the
   agent-facing goal does not.
4. **Detection recall:** record only. Revisit with an independent set of vague goals.
5. **Environment:** get Ollama onto the GPU before the next measurement (CPU-only made a 3-arm run
   take ~80 min and was unstable).

MODEL_CAPABILITY items (IV-01 values, IM-03 signature, IM-01 premature done) are recorded, not patched.