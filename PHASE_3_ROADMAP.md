# PHASE_3_ROADMAP.md

**Ollama Coding Agent — Kế hoạch Phase 3 (Real Tool Execution + Code Intelligence)**

Version: 1.0
Status: Working plan
Owner: Execution Plane / Tools + WorkspaceManager
Scope: Bổ sung real tool implementations (filesystem, git, shell) và VS Code extension
       integration. Đây là bước chuyển từ runtime sandbox sang agent thực sự chạm vào filesystem.
Related:
`PHASE_2_SIGNOFF.md`, `INVARIANTS.md`, `SECURITY_MODEL.md`, `DOMAIN_CONTRACTS.md`,
`Coding Agent Architecture Target.md §53-54`

---

## 0. Nguyên tắc Phase 3

> **Phase 2 kết nối LLM thật. Phase 3 kết nối filesystem thật: tool calls chạm code.**

Ba luật:

1. **Mọi tool call qua ToolGateway** (TG-001 — đã enforce từ Phase 1.5). Real executors inject vào ToolGateway, không bypass.
2. **WorkspaceManager kiểm soát boundary** (WS-003/004/005/006): path traversal, symlink escape, unauthorized mutation đều bị chặn.
3. **ArtifactStore lưu output thật**: stdout/stderr của tool calls được lưu vào file (không trong SQLite).

North Star: *Phase 3 xong khi agent có thể đọc file thật, viết file thật, chạy git command thật, và ArtifactStore lưu output — tất cả đi qua ToolGateway + WorkspaceManager + ProcessSupervisor đã có.*

---

## 1. Con số Phase 3

Phase 3 không có invariants **mới** trong `invariants.yaml` (phase==3 = 0). Các invariants liên quan đều đã được phân bổ vào:
- Phase 1 (WS-003/004/005/006/010 — workspace boundary — đã enforce)
- Phase 1.5 (TG-001..010 — ToolGateway lifecycle — đã enforce)
- HIGH còn dở từ Phase 1.5: **TG-006** (idempotency key), **TG-008** (provenance ghi vào tool call), **OB-002/003** (events cho tool calls + verification)

Phase 3 là **implementation milestone** — các contracts đã có, giờ là real executors.

---

## 2. Scope Phase 3

### 2.1 In-scope

| Component | Mục tiêu | Enforces |
|---|---|---|
| `ToolRegistry` | Đăng ký tool definitions với schema + risk class | TG-009 (schema validation at source) |
| `FilesystemTools` | `read_file`, `write_file`, `list_dir`, `delete_file`, `move_file` | WS-003/004/005, SE-009 |
| `GitTools` | `git_status`, `git_diff`, `git_add`, `git_commit`, `git_log` | WS-003, TG-007 |
| `ShellTools` | `run_command` (allowlisted, bounded timeout) | SE-007/008, TG-010 |
| `WorkspaceManager` (full impl) | Path canonicalization, symlink check, change tracking | WS-003/004/005/006/010 |
| `ArtifactStore` | Lưu stdout/stderr artifacts vào disk + SQLite metadata | PR-003, OB-002 |
| `TaskExecutor` | Orchestrate tool calls cho một TaskRun | EX-001..005 |
| `NodeToolExecutor` | Real `ToolExecutor` dùng `NodeProcessSupervisor` | TG-001, SE-007 |
| TG-006/TG-008 | idempotency key + provenance recording trên tool call | TG-006, TG-008 (HIGH) |
| VS Code extension bridge | `vscode.workspace.*` adapter (read/write via VS Code API) | — |
| Schema migration v4 | `artifacts` table | CP-001/007 |
| Integration E2E P3-I1 | Real file read/write/git với NodeProcessSupervisor | all above |

### 2.2 Out-of-scope (Phase 3)

- Replanner / FailureAnalyzer (Phase 5)
- RecoveryEngine (Phase 5)
- Tree-sitter / LSP (Phase 6)
- LLM summarization in Compactor (deferred)
- NetworkPolicy enforcement (deferred)
- Multi-agent (Phase 8+)

---

## 3. Kiến trúc những gì đã có

### 3.1 Đã có — dùng ngay

| Thứ | Location |
|---|---|
| `ToolGateway` + `ToolPolicy` + `ApprovalEngine` | `agent-core/src/tool/` (P1.5-TG1/TG2) |
| `ToolCallRepository`, `ApprovalRepository` | `infrastructure/src/repositories/tool-call-repository.ts` |
| `ProcessSupervisor` contract + `NodeProcessSupervisor` | `agent-core/src/process/`, `infrastructure/src/process/` |
| `EnvGuard` | `agent-core/src/security/env-guard.ts` |
| Path canonicalization + symlink check | `infrastructure/src/path/` (Phase 0) |
| `WorkspaceRevision` + hash | `infrastructure/src/workspace-revision/` |
| `ToolCall`, `Approval`, `ToolResult` domain types | `agent-core/src/domain/tool-call.ts` |
| `ExecutionCoordinator` | `agent-core/src/execution/execution-coordinator.ts` |
| `TaskRunService` + `NoopProcessReconciler` | `agent-core/src/task/task-run-service.ts` |
| `SqliteVerificationRepository` | infra (P1-F5) |
| Schema v1-v3 | `infrastructure/src/sqlite/migrations/` |

### 3.2 Cần tạo mới (Phase 3)

| Component | Package | Phần cốt lõi |
|---|---|---|
| `ToolRegistry` | agent-core | Map tool name → `ToolDefinition` (schema, riskClass, executor factory) |
| `FilesystemExecutor` | infrastructure | `read_file`, `write_file`, `list_dir`, `delete_file` qua Node fs |
| `GitExecutor` | infrastructure | git commands qua `NodeProcessSupervisor` |
| `ShellExecutor` | infrastructure | allowlisted shell commands qua `NodeProcessSupervisor` |
| `WorkspaceManager` (full) | agent-core + infrastructure | canonicalize + check + track `ChangeRecord` |
| `ArtifactStore` | infrastructure | write bytes → disk + insert `artifacts` row |
| `NodeToolExecutor` | infrastructure | `ToolExecutor` impl dùng `NodeProcessSupervisor` + real tools |
| `TaskExecutor` | agent-core | orchestrate: context → model → tool calls → finalize run |
| Schema migration v4 | infrastructure | `artifacts` table |
| VS Code extension bridge | new `packages/vscode-bridge/` | `VsCodeWorkspaceAdapter` (Phase 3+) |
| E2E P3-I1 | tests | real file read/write + git, no FakeProcessSupervisor |

---

## 4. Component breakdown

### 4.1 P3-TR1 — ToolRegistry

```
agent-core/src/tool/
  tool-registry.ts   ← ToolRegistry: register/get ToolDefinition
```

`ToolDefinition`: `{ toolName, version, description, riskClass, argsSchema, executor }`.
`ToolRegistry.register(def)` — idempotent. `ToolRegistry.get(toolName)` → ToolDefinition | null.
TG-006: each registered tool has an idempotency key strategy.
TG-008: each tool call records provenance automatically.

### 4.2 P3-FS1 — FilesystemExecutor

```
infrastructure/src/tools/
  filesystem-executor.ts  ← read_file, write_file, list_dir, delete_file
```

All operations:
- Path goes through `canonicalizePath(root, relpath)` first (WS-003/004/005).
- Rejected if outside workspace root.
- `write_file`/`delete_file` append a `ChangeRecord` (WS-010 mutation tracking).
- `read_file` on binary files: returns metadata + hex preview (§5.6 CONTEXT_SPEC).

### 4.3 P3-GIT1 — GitExecutor

```
infrastructure/src/tools/
  git-executor.ts  ← git_status, git_diff, git_add, git_commit, git_log
```

Runs via `NodeProcessSupervisor` (`shell:false`, env from `EnvGuard`).
`git_commit` requires MODIFY_WORKSPACE risk class → approval in production.
TG-010: timeout per operation.

### 4.4 P3-SH1 — ShellExecutor

```
infrastructure/src/tools/
  shell-executor.ts  ← run_command (allowlisted)
```

Only runs if tool name is in the allowlist (configured by policy).
`shell:false` (SE-003 §9.4). Arguments are array, never interpolated.
ProcessSupervisor timeout enforced (SE-007/008).

### 4.5 P3-WM1 — WorkspaceManager (full)

```
agent-core/src/workspace/
  workspace-manager.ts   ← canonicalize, check boundary, track changes
infrastructure/src/workspace/
  node-workspace-manager.ts  ← fs impl
```

`WorkspaceManager.checkPath(root, relpath)` → allowed | PATH_ESCAPE | SYMLINK_ESCAPE.
`WorkspaceManager.recordChange(change: ChangeRecord)` → appends to event log.
`WorkspaceManager.computeRevision(root)` → delegates to `computeWorkspaceRevision`.

### 4.6 P3-AS1 — ArtifactStore

```
infrastructure/src/artifacts/
  artifact-store.ts   ← write(content, metadata) → Artifact
```

Content stored as files under `<workspaceRoot>/.cf2/artifacts/<artifactId>`.
SQLite `artifacts` table (migration v4) stores metadata only (§39 Architecture Target).
`outputArtifactId`/`stderrArtifactId` on `VerificationCheck` and `ToolCall.result` populated.

### 4.7 P3-TE1 — TaskExecutor + NodeToolExecutor

```
agent-core/src/execution/
  task-executor.ts      ← TaskExecutor service (orchestrate one TaskRun)
infrastructure/src/execution/
  node-tool-executor.ts ← ToolExecutor impl: ToolGateway + NodeProcessSupervisor
```

`TaskExecutor.executeRun(taskRun, context)`:
1. `ContextBuilder.build()` → snapshot.
2. `ModelGateway.generate()` → raw output.
3. `StructuredOutputParser` → ToolCall proposals.
4. Loop: `ToolGateway.request(call)` → `ToolGateway.execute(call, nodeToolExecutor)`.
5. `TaskRunService.finalize()` → SUCCEEDED/FAILED.
6. `VerificationEngine.verify()` → report.
7. `CompletionGate.canComplete()` → PASSED.

### 4.8 P3-I1 — Integration E2E

Real file system test: creates a temp workspace, reads files, runs `git init`, writes output.
No FakeProcessSupervisor — uses `NodeProcessSupervisor` directly.

---

## 5. Timeline (5 tuần)

```
Tuần 1 — Tool Infrastructure
  P3-TR1   ToolRegistry                                             [DONE ✓] 681 tests
  P3-WM1   WorkspaceManager + NodeWorkspaceManager                 [DONE ✓]
  P3-FS1   FilesystemExecutor (read/write/list/delete)             [DONE ✓]
  P3-AS1   ArtifactStore + Schema migration v4                     [DONE ✓] 707 tests, W+WSL

Tuần 2 — Git + Shell
  P3-GIT1  GitExecutor (status/diff/add/commit/log)                [2 ngày]
  P3-SH1   ShellExecutor (allowlisted)                             [1 ngày]

Tuần 3 — TaskExecutor
  P3-TE1   NodeToolExecutor + TaskExecutor                         [3 ngày]
  P3-TE1   TG-006/TG-008 idempotency + provenance                  [2 ngày]

Tuần 4 — Integration + VS Code
  P3-I1    Integration E2E (real filesystem + git)                  [2 ngày]
  VSCode   VS Code extension bridge (vscode.workspace adapter)      [2 ngày]
  —        Buffer / fix                                             [1 ngày]

Tuần 5 — Sign-off
  —        PHASE_3_SIGNOFF.md                                       [1 ngày]
  —        Buffer                                                    [4 ngày]
```

---

## 6. Exit criteria Phase 3

1. Tất cả component §4 implemented.
2. TG-006/008 (HIGH) enforced: idempotency key + provenance recording.
3. WS-003/004/005/006 enforced thật qua WorkspaceManager (path + symlink check).
4. ArtifactStore lưu stdout/stderr vào disk.
5. E2E P3-I1 (real filesystem + git, NodeProcessSupervisor) pass.
6. Không TypeScript error / ESLint error / dependency-cruiser violation.
7. CI green trên 2 OS.
8. `PHASE_3_SIGNOFF.md` được tạo.

---

## 7. Rủi ro

| Rủi ro | Xác suất | Tác động | Mitigation |
|---|---|---|---|
| Git process trên Windows khác Linux | Trung bình | Trung bình | Test cả 2 OS; dùng `--no-pager` flag |
| Path separator trên Windows | Cao | Cao | canonicalizePath đã xử lý, test cross-platform |
| ArtifactStore disk cleanup | Thấp | Thấp | TTL policy, test cleanup |
| VS Code API compatibility | Trung bình | Trung bình | Dùng minimal stable API (workspaceFolder, fs) |
| NodeToolExecutor timeout | Thấp | Cao | SE-007/SE-008 đã enforce trong ProcessSupervisor |

---

## 8. Những gì Phase 3 KHÔNG làm

- Không có Replanner LLM (Phase 5).
- Không có RecoveryEngine (Phase 5).
- Không có Tree-sitter / LSP import analysis (Phase 6).
- Không có streaming LLM (deferred; OllamaGateway đã ready cho Phase 3.5).
- Không có multi-workspace (Phase 8+).
