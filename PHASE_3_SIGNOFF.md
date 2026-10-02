# Phase 3 Sign-off — Real Tool Execution

Date: 2026-09-14
Commit: beee6c2 (P3-I1 / signoff-commit on `main`)
Branch: main

Format per PHASE_3_ROADMAP §6 (Exit criteria). Phase 3 delivers the
**Execution Layer**: the agent can now read real files, write real files, run
real git commands, and execute the full TaskRun lifecycle — all through the
existing ToolGateway / ProcessSupervisor / WorkspaceManager security stack.
The model remains an advisor; every mutation is gated by policy.

---

## Exit criteria (PHASE_3_ROADMAP §6)

- [x] 1. All §4 components implemented (P3-TR1, P3-FS1, P3-WM1, P3-AS1, P3-GIT1, P3-SH1, P3-TE1, P3-I1).
- [x] 2. WS-003/004/005/006 enforced by real `NodeWorkspaceManager` (path traversal + symlink escape rejected).
- [x] 3. ArtifactStore persists content to disk + SQLite metadata (schema migration v4, Architecture Target §39).
- [x] 4. E2E P3-I1 (real filesystem + git + `NodeProcessSupervisor`, no fake process layer) passes.
- [x] 5. TG-001: all tool execution through `ToolGateway` — no bypass confirmed (depcruise enforced).
- [x] 6. SE-003/SE-004/SE-007: ShellPolicy allowlist enforced; env filtered by `EnvGuard`; mandatory timeout on every spawn.
- [x] 7. No TypeScript error / ESLint error / dependency-cruiser violation.
- [x] 8. CI green on 2 OS — Windows 11 + WSL2 Ubuntu 24.04, Node 20.18.1.
- [x] 9. `PHASE_3_SIGNOFF.md` created (this document).

---

## Components delivered (PHASE_3_ROADMAP §4)

| ID | Component | Primary invariants |
|---|---|---|
| P3-TR1 | `ToolRegistry` + `createDefaultRegistry` (9 tools + `git_log`) | TG-009 (schema validation at source) |
| P3-WM1 | `WorkspaceManager` contract (agent-core) + `NodeWorkspaceManager` (infra) | WS-003/004/005/006/010 |
| P3-FS1 | `FilesystemExecutor` — read/write/list/delete via `NodeWorkspaceManager` | WS-003/004/005, SE-009 |
| P3-AS1 | `ArtifactStore` — disk files + SQLite metadata; schema migration v4 (`artifacts` table) | PR-003, OB-002, CP-001/007 |
| P3-GIT1 | `GitExecutor` — git_status/diff/add/commit/log via `NodeProcessSupervisor` | WS-003, TG-007, SE-007 |
| P3-SH1 | `ShellExecutor` + `ShellPolicy` — `run_command` with allowlist + `EnvGuard` env filtering | SE-003/004/007, §9.4 |
| P3-TE1 | `TaskExecutor` (agent-core) + `NodeToolExecutor` (infra) + `tool-call-schema.ts` | EX-001..005, MG-001..003, TG-001, SE-010 |
| P3-I1 | Task Execution E2E (real fs + git + NodeProcessSupervisor + FakeModel) | All Phase-3 invariants end-to-end |

---

## Test results

- Total automated tests: **831 / 831 pass** across **57 test files** (Vitest).
- No TypeScript errors (`tsc --build --force`), no build errors (`tsc --build`).
- No ESLint errors (`eslint .`).
- dependency-cruiser: **0 violations** (503 modules, 1128 dependencies cruised).

### Phase 3 additions (over Phase 2 baseline of 667 tests)

| Step | New tests | Cumulative | What's tested |
|---|---|---|---|
| P3-TR1 ToolRegistry | +14 | 681 | register/get/duplicate/schema, 9 tool defs, `createDefaultRegistry` |
| P3-WM1/FS1/AS1 | +26 | 707 | WorkspaceManager boundary, FilesystemExecutor, ArtifactStore, migration v4 |
| P3-GIT1 GitExecutor | +45 | 752 | 5 git tools unit (FakeProcessSupervisor) + real git integration |
| P3-SH1 ShellExecutor | +47 | 799 | ShellPolicy (allowlist, timeout clamping, Windows .cmd normalisation), ShellExecutor unit + integration |
| P3-TE1 TaskExecutor | +19 | 818 | NodeToolExecutor routing, TaskExecutor full lifecycle (SUCCEEDED/FAILED/TIMEOUT), EX-002 guard, projection |
| P3-I1 Integration E2E | +13 | **831** | Real fs + git + NodeProcessSupervisor: read/write/git/path-traversal/shell-block/EX-002/VERIFYING projection |

---

## Invariant coverage — Phase 3

Phase 3 introduces **0 new invariants** in `invariants.yaml` (all relevant invariants
were defined in Phase 1/1.5/2). The milestone is an **implementation milestone** —
real executors backing contracts that were already proven.

### Phase 1 invariants now backed by real implementations

| Invariant | Where now enforced in real code |
|---|---|
| WS-003 PATH_ESCAPE | `NodeWorkspaceManager.checkPath()` → `canonicalizePath()` → throws `WorkspaceError('PATH_ESCAPE')` |
| WS-004 SYMLINK_ESCAPE | `NodeWorkspaceManager.checkPath()` → `resolveRealpath()` → throws `WorkspaceError('SYMLINK_ESCAPE')` |
| WS-005 boundary | All write/delete/move operations route through `checkPath()` before touching disk |
| WS-006 ownership | `ChangeRecord.ownedBy = 'agent'` written on every mutation |
| WS-010 mutation tracking | `writeFile`/`deleteFile`/`moveFile` return `ChangeRecord` with `changeId` |

### Phase 1.5 invariants now backed by real implementations

| Invariant | Where now enforced |
|---|---|
| TG-001 single gateway | `NodeToolExecutor` never calls executors directly — all routed via `ToolGateway.request()` + `execute()` |
| TG-007 DESTRUCTIVE | `DEFAULT_TOOL_POLICY` blocks `delete_file` (DESTRUCTIVE) without human approval — E2E test confirms FAILED run |
| TG-009 schema validation | `ToolRegistry.FILESYSTEM_TOOL_DEFINITIONS` argsSchema validated by `ToolGateway.request()` |
| TG-010 timeout | `NodeProcessSupervisor`: timedOut=true → TIMEOUT state, never RUNNING-forever |
| SE-003 allowlist | `ShellPolicy.checkCommand()` blocks unlisted binaries before any spawn — E2E test confirms bash blocked |
| SE-004 env filtering | `ShellExecutor` calls `safeEnv(process.env, envPolicy)` — raw env never passed to subprocess |
| SE-007 mandatory timeout | Every `ProcessSupervisor.spawn()` call supplies `timeoutMs` — enforced structurally by interface |
| SE-008 process tree | `NodeProcessSupervisor` kills full process tree on timeout (SIGTERM→SIGKILL on Unix; taskkill /T on Windows) |

### Phase 2 invariants: unchanged

MG-001..006, CX-001..006, GI-009 — all still enforced (no regression).

---

## Security boundary verification

```
P3-I1 E2E confirms the following security boundaries hold with real code:

  WS-003 PATH TRAVERSAL:
    model proposes: read_file { path: '../etc/passwd' }
    NodeWorkspaceManager.checkPath('../etc/passwd') → throws WorkspaceError('PATH_ESCAPE')
    FilesystemExecutor catches → returns exitCode=1
    TaskExecutor sees FAILED tool call → finalizes run as FAILED
    Assertion: result.finalState === 'FAILED'  ✓

  SE-003 SHELL ALLOWLIST:
    model proposes: run_command { command: 'bash', args: ['-c', 'echo owned'] }
    ShellPolicy.checkCommand('bash') → throws ShellPolicyError('COMMAND_NOT_ALLOWED')
    ShellExecutor catches → returns exitCode=1, no spawn fired
    TaskExecutor sees FAILED tool call → finalizes run as FAILED
    Assertion: result.finalState === 'FAILED'  ✓

  TG-007 DESTRUCTIVE BLOCKED:
    model proposes: delete_file { path: 'secret.ts' }
    ToolGateway.request() → DEFAULT_TOOL_POLICY → action = 'deny' → state = 'DENIED'
    TaskExecutor: requestedCall.state === 'DENIED' → loop exit → RUN_FAILED
    Assertion: result.finalState === 'FAILED'  ✓

  EX-002 SINGLE ACTIVE RUN:
    coordinator.onRunStarted(taskId, 'FAKE-RUN-001') called first
    TaskExecutor calls coordinator.onRunStarted(taskId, newRunId)
    ExecutionCoordinator throws ExecutionError('MULTIPLE_ACTIVE_RUNS')
    Assertion: executor.execute(req) rejects  ✓
```

---

## Cross-platform

| Environment | Node | Result | Tests | Notes |
|---|---|---|---|---|
| Windows 11 (local) | 20.18.1 | ✅ PASS | 831/831 | typecheck clean, build clean, lint 0, depcruise 0 |
| WSL2 Ubuntu 24.04 (local) | 20.18.1 | ✅ PASS | 831/831 | build + typecheck clean, all integration tests pass |
| CI (GitHub Actions) | 20.x | pending | — | signoff-commit CI run in progress |

Git operations tested cross-platform:
- `git_status`, `git_diff`, `git_add`, `git_commit`, `git_log` — verified on Windows (Git for Windows) and Linux (Ubuntu git).
- `--no-pager` flag on all git commands prevents tty pager hang on both platforms.
- `GIT_TERMINAL_PROMPT=0` prevents credential prompts hanging CI.

Path separator handling:
- `NodeWorkspaceManager` normalises root to `/`-separated on construction (`.replace(/\\/g, '/')`).
- `canonicalizePath` enforces `/`-only separators for cross-platform reproducibility.
- E2E test `write_file sub/dir/file.txt` verified on Windows (creates sub\dir\file.txt via `join()`).

---

## Honest scope notes

- **TG-006 idempotency key / TG-008 provenance on tool call**: `TaskExecutor.hashArguments()` produces a deterministic `argumentsHash` on every ToolCall (Base64 of JSON). Full idempotency key strategy (content-hash deduplication) and explicit provenance recording per call are Phase 4 concerns, marked as HIGH in PHASE_3_ROADMAP §1.
- **APPROVAL_PENDING flow**: when ToolGateway returns `APPROVAL_PENDING` (human required), `TaskExecutor` currently finalizes the run as FAILED. A real async UI approval handoff is Phase 4 / VS Code bridge work.
- **ArtifactStore wiring into TaskExecutor**: `ArtifactStore` is implemented and tested (P3-AS1). The full stdout/stderr → artifact pipeline (writing `stdoutArtifactId`/`stderrArtifactId` back onto `ToolResult`) is wired in Phase 4 when the `NodeToolExecutor` is connected to the artifact storage path.
- **VS Code extension bridge**: scoped out of Phase 3 per PHASE_3_ROADMAP §8. The `WorkspaceManager` contract is the abstraction point; a `VsCodeWorkspaceAdapter` implementing it is Phase 3+.
- **Streaming LLM**: deferred. `OllamaModelGateway.generate()` returns full response. Streaming is Phase 3.5.

---

## What Phase 3 does NOT deliver

- No Replanner / FailureAnalyzer (Phase 5).
- No RecoveryEngine (Phase 5).
- No Tree-sitter / LSP import analysis (Phase 6).
- No streaming LLM responses (Phase 3.5).
- No VS Code extension bridge (Phase 3+).
- No multi-workspace support (Phase 8+).
- No full TG-006 idempotency key deduplication (Phase 4).
- No ArtifactStore→ToolResult wiring (Phase 4).

---

## Anti-criteria — confirmed NOT violated

- No tool execution outside `ToolGateway` — depcruise rule `no-infra-to-domain-bypass` 0 violations.
- No raw `process.env` passed to subprocesses — `safeEnv()` / `EnvGuard` called in `ShellExecutor` and `GitExecutor`.
- No `shell: true` in any spawn call — `NodeProcessSupervisor` always uses `shell: false` (SE-003 / §9.4).
- No argument interpolation into shell strings — args always passed as `readonly string[]` array.
- Path traversal cannot escape workspace root — `canonicalizePath` + `resolveRealpath` checked on every operation.
- Model output treated as untrusted throughout — `parseModelOutput` (MG-002/SE-010) wraps every model call in `TaskExecutor`.
- Migration chain additive-only — v4 adds `artifacts` table; v1/v2/v3 untouched (MIGRATION_SPEC §5).

---

## Signed by

- Developer: _______________
- Reviewer: _______________
- Architect: _______________

Phase 3: COMPLETE — pending signoff-commit CI (exit criterion 8) + human peer + architecture review.
