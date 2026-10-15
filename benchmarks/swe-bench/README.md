# SWE-bench adapter

Runs [SWE-bench](https://www.swebench.com/)-style issue-resolution tasks through CodeForge's own
evaluation pipeline (isolated workspace → real runtime → deterministic checks → evaluator), the
same path the native suite uses.

## What a SWE-bench record maps to

Each dataset record (JSON array or JSONL, one object per line) carries a real GitHub repo at a
`base_commit`, the issue text (`problem_statement`), the hidden judging tests (`test_patch` +
`FAIL_TO_PASS` / `PASS_TO_PASS`), and a reference `patch` (gold solution).

The adapter (`sweBenchInstanceToTask`) produces a **bundle** per record:

- a `BenchmarkTask` — `description` = the issue text, `category` = `BUGFIX`, and a single
  `command` verification check that runs the selected tests;
- a `SweBenchSetup` side-channel — the `repo`, `baseCommit`, `testPatch`, test selection, and
  (for provenance only) the `goldPatch`.

`BenchmarkTask.seedFiles` stays **empty**: a real repo is far too large to inline, and the
test_patch must be applied by the harness *after* the agent edits. The repo is materialised by the
runner's workspace setup instead.

### Evaluation integrity

The gold `patch` and the `test_patch` are **never** placed in the task description or seed files —
the agent solves the issue from the problem statement alone, and is judged only by the tests the
harness applies afterwards. The gold patch is retained in the setup for debugging/provenance only.

## Pieces

| Layer | Symbol | Role |
|---|---|---|
| agent-core (pure) | `validateSweBenchInstance`, `sweBenchInstanceToTask`, `sweBenchInstancesToTasks` | validate records, map to `BenchmarkTask` + `SweBenchSetup` |
| infrastructure (I/O) | `loadSweBenchDataset` | read a JSON/JSONL dataset file → validated bundles |
| infrastructure (I/O) | `SweBenchWorkspaceSetup` | `prepareBaseline` (clone + checkout `base_commit`) and `applyTestPatch` (apply the judging tests after the run) |

## End-to-end wiring

Per case, a SWE-bench-aware `AgentRunner`:

1. `prepareBaseline(root, setup)` — clone the repo into the isolated workspace and check out
   `base_commit` (BEFORE the agent runs).
2. run the CodeForge orchestrator against the repo with `task.description` as the goal.
3. `applyTestPatch(root, setup)` — apply `test_patch` on top of the agent's edits (AFTER the run,
   BEFORE the check).
4. the existing `command` check runs the `FAIL_TO_PASS` + `PASS_TO_PASS` selection; exit 0 = SUCCESS.

### Repo source and environment

`SweBenchWorkspaceSetup` clones from GitHub by default; pass `resolveRepoUrl` to point at a local
mirror/cache for offline, reproducible runs. The reference SWE-bench harness uses per-instance
Docker images to pin dependencies — that image path is the production route for exact
reproducibility; the git-clone setup here is the dependency-light alternative. Dependency install
(pip/tox/…) is driven by the test command / environment, as in the reference harness.

## Sample

`sample.jsonl` is a tiny self-contained record (not a real SWE-bench instance) that exercises the
loader and mapping shape. Real datasets: SWE-bench Lite / Verified / full, in JSONL.
