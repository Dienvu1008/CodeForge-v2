# INFRASTRUCTURE_SPEC.md

**Ollama Coding Agent — Persistence, Process, Artifacts & Adapters**

Version: 1.0
Status: Architecture Baseline
Owner: infrastructure
Scope: v1 (single user, single workspace, sequential, local)
Related specs:
`INVARIANTS.md` (CP-*, PR-*, SE-*, DC-*), `DOMAIN_CONTRACTS.md`,
`WORKSPACE_SPEC_v1.0`, `CONTEXT_SPEC_v1.0`, `STATE_MACHINE_SPEC.md`,
`GRAPH_PROTOCOL.md`, `VERIFICATION_PROTOCOL.md`, `SECURITY_MODEL.md`,
`MIGRATION_SPEC.md`, `EVALUATION_MODEL.md`

---

## 0. Mục đích

Infrastructure là **lớp adapter** giữa domain và môi trường vật lý:

- SQLite (persistence);
- Filesystem;
- Git;
- Shell / Process;
- Ollama (LLM);
- Tree-sitter / LSP (Phase 6);
- Package managers;
- OS.

Nguyên tắc trung tâm:

> **Domain không phụ thuộc infrastructure. Infrastructure phục vụ domain qua contract.**

Và:

> **Infrastructure là adapter, không phải authority.**

File này định nghĩa:

- infrastructure layers;
- SQLite contract;
- EventLog contract;
- ArtifactStore contract;
- ProcessSupervisor contract;
- Filesystem adapter;
- Git adapter;
- Ollama adapter;
- Tree-sitter / LSP adapter;
- Package manager adapter;
- OS adapter;
- VS Code adapter;
- Dependency direction enforcement;
- Invariant mapping;
- Test matrix;
- North Star.

Tham chiếu: `INVARIANTS.md` → **DC-001..DC-005, CP-*, PR-*, SE-*, WS-***.

---

## 1. Nguyên tắc nền tảng

### 1.1 Adapter pattern

Mỗi infrastructure component là một **adapter** triển khai **interface** định nghĩa trong domain.

```
Domain (agent-core)
   │
   │  interface (port)
   ▼
Adapter (infrastructure)
   │
   │  native API
   ▼
Environment (SQLite, FS, Ollama, ...)
```

Domain không biết adapter cụ thể.

### 1.2 Dependency direction

```
agent-core
   ▲
   │ (imports interface only)
   │
planning / context / execution / verification / recovery
   ▲
   │ (imports agent-core + adapter interfaces)
   │
infrastructure
   │ (implements adapter interfaces)
   ▼
native APIs
```

Tham chiếu: `INVARIANTS.md` → **DC-001, DC-002, DC-003, DC-004, DC-005**.

### 1.3 Không được

- ❌ Domain import SQLite.
- ❌ Domain import Ollama client.
- ❌ Domain import fs.
- ❌ Domain import child_process.
- ❌ Adapter chứa business logic.
- ❌ Adapter tự quyết định policy.
- ❌ Adapter bypass ToolGateway.

### 1.4 Phải

- ✅ Adapter implement interface.
- ✅ Adapter là thin wrapper.
- ✅ Adapter translate error → domain error.
- ✅ Adapter log đầy đủ.
- ✅ Adapter redact secret.
- ✅ Adapter enforce boundary (path, timeout, env).

---

## 2. Infrastructure Layers

### 2.1 Layer structure

```
packages/infrastructure/
  src/
    sqlite/
      database.ts
      migrations/
      repositories/
    event-log/
      event-log.ts
      event-store.ts
    artifacts/
      artifact-store.ts
      artifact-store-fs.ts
    process/
      process-supervisor.ts
      process-tree.ts
    filesystem/
      fs-adapter.ts
      path-canonicalizer.ts
    git/
      git-adapter.ts
    ollama/
      ollama-adapter.ts
      ollama-client.ts
    tree-sitter/
      ts-adapter.ts
    lsp/
      lsp-adapter.ts
    package-manager/
      npm-adapter.ts
      dart-adapter.ts
      pip-adapter.ts
    os/
      os-adapter.ts
      env-adapter.ts
    vscode/
      vscode-bridge.ts
    index.ts
```

### 2.2 Interface location

- Interface định nghĩa trong `agent-core` (port).
- Implementation trong `infrastructure` (adapter).
- Không có interface trong `infrastructure`.

### 2.3 Adapter registry

```typescript
interface AdapterRegistry {
  sqlite: DatabaseAdapter;
  eventLog: EventLogAdapter;
  artifacts: ArtifactStoreAdapter;
  process: ProcessSupervisorAdapter;
  fs: FileSystemAdapter;
  git: GitAdapter;
  ollama: OllamaAdapter;
  treeSitter?: TreeSitterAdapter;
  lsp?: LspAdapter;
  packageManagers: PackageManagerAdapter[];
  os: OsAdapter;
  vscode?: VscodeBridge;
}
```

Adapter được inject vào application layer.

---

## 3. SQLite Contract

### 3.1 Vai trò

SQLite là **operational database** — nơi lưu state hiện tại của hệ thống.

SQLite trả lời câu hỏi:

> «Hệ thống đang ở đâu?»

EventLog trả lời câu hỏi:

> «Điều gì đã xảy ra?»

Hai vai trò khác nhau, cùng DB.

### 3.2 Interface

```typescript
interface DatabaseAdapter {
  open(path: string, options: DbOptions): Promise<Database>;
  close(): Promise<void>;

  transaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T>;

  query<T>(sql: string, params: unknown[]): Promise<T[]>;
  execute(sql: string, params: unknown[]): Promise<ExecuteResult>;

  migrate(plan: MigrationPlan): Promise<MigrationResult>;

  backup(path: string): Promise<void>;
  restore(path: string): Promise<void>;

  integrityCheck(): Promise<IntegrityReport>;
}

interface DbOptions {
  journalMode: 'WAL';
  synchronous: 'NORMAL' | 'FULL';
  foreignKeys: boolean;
  busyTimeoutMs: number;
  pageSize: number;
  cacheSizeKb: number;
}
```

### 3.3 Default options

```typescript
const DEFAULT_DB_OPTIONS: DbOptions = {
  journalMode: 'WAL',
  synchronous: 'NORMAL',
  foreignKeys: true,
  busyTimeoutMs: 5000,
  pageSize: 4096,
  cacheSizeKb: 65536,
};
```

### 3.4 Transaction rules

- Mọi state mutation đi qua `transaction()`.
- Transaction phải bao gồm:
  - state mutation;
  - event append;
  - (nếu có) version bump.
- Không có nested transaction.
- Nếu cần atomic multi-step → gộp vào một transaction.

Tham chiếu: `INVARIANTS.md` → **CP-001, GI-008**.

### 3.5 Parameterized queries

- Luôn dùng parameterized queries.
- Không string concatenation cho SQL.
- Không dynamic table/column names từ model.

### 3.6 WAL mode

- WAL mode bắt buộc.
- Cho phép đọc trong khi ghi.
- `wal_autocheckpoint` = 1000 pages.
- Checkpoint định kỳ.

### 3.7 Integrity

- `PRAGMA integrity_check` định kỳ (mỗi 100 transaction).
- Nếu fail → emit event, mark DB cần backup/restore.
- Không tự recover.

### 3.8 Backup

- `.backup` command (không copy file khi WAL active).
- Backup path: `~/.ollama-coding-agent/backups/<timestamp>/`.
- Backup verify đọc được.
- Retention theo policy.

### 3.9 Schema version

- `PRAGMA user_version` = schema version.
- `schema_versions` table lưu full history.
- Migration qua `MIGRATION_SPEC.md`.

### 3.10 File permissions

- DB file: `0600` (chỉ owner đọc/ghi).
- DB directory: `0700`.
- Không world-readable.
- Không trong workspace.

### 3.11 Error mapping

| Native error | Domain error |
|---|---|
| `SQLITE_BUSY` | `DB_BUSY` |
| `SQLITE_CORRUPT` | `DB_CORRUPT` |
| `SQLITE_CONSTRAINT` | `DB_CONSTRAINT` |
| `SQLITE_FULL` | `DB_FULL` |
| `SQLITE_READONLY` | `DB_READONLY` |

Tham chiếu: `INVARIANTS.md` → **CP-001, CP-007, CP-008, CP-009, SE-* (parameterized)**.

---

## 4. EventLog Contract

### 4.1 Vai trò

EventLog là **append-only record** của mọi sự kiện domain.

### 4.2 Interface

```typescript
interface EventLogAdapter {
  append(event: DomainEvent, tx?: Transaction): Promise<void>;
  stream(sessionId: string, fromSequence?: number): AsyncIterable<DomainEvent>;
  query(filter: EventFilter): Promise<DomainEvent[]>;
  count(sessionId: string): Promise<number>;
  lastSequence(sessionId: string): Promise<number>;
}

interface EventFilter {
  sessionId?: string;
  type?: string[];
  aggregateKind?: string;
  aggregateId?: string;
  fromSequence?: number;
  toSequence?: number;
  fromTime?: string;
  toTime?: string;
}
```

### 4.3 Append rules

- Append-only: không update, không delete.
- `sequenceNumber` per-session monotonic, không gap.
- Nếu gap → corruption, fail fast.
- Event append phải cùng transaction với state mutation.

### 4.4 Sequence generation

```
BEGIN
  SELECT MAX(sequence_number) FROM events WHERE session_id = ?
  INSERT INTO events (..., sequence_number) VALUES (..., max + 1)
COMMIT
```

Nếu concurrent (không trong v1): dùng `UNIQUE(session_id, sequence_number)` + retry.

### 4.5 Persistence schema

```sql
CREATE TABLE events (
  event_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  sequence_number INTEGER NOT NULL,
  event_version INTEGER NOT NULL,
  type TEXT NOT NULL,
  aggregate_kind TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  provenance_json TEXT,
  at TEXT NOT NULL,

  UNIQUE (session_id, sequence_number)
);

CREATE INDEX idx_events_session_seq ON events(session_id, sequence_number);
CREATE INDEX idx_events_type ON events(type);
CREATE INDEX idx_events_aggregate ON events(aggregate_kind, aggregate_id);
CREATE INDEX idx_events_time ON events(at);
```

### 4.6 Redaction

- Trước khi persist, redact secret trong `payload_json` và `provenance_json`.
- Redact không thể undo.
- Log event redaction.

### 4.7 Event replay

- Replay từ `fromSequence` → apply event → state.
- Replay phải deterministic.
- Nếu event version cũ → migrate on read.

### 4.8 Retention

- v1: giữ toàn bộ.
- v2: có thể snapshot + truncate.
- Không xóa event trong v1.

Tham chiếu: `INVARIANTS.md` → **CP-001, CP-008, OB-001, OB-002, OB-003, OB-004, PR-003**.

---

## 5. ArtifactStore Contract

### 5.1 Vai trò

ArtifactStore lưu **artifact bytes** (logs, patches, test results, screenshots) ra khỏi SQLite.

SQLite giữ **metadata**. ArtifactStore giữ **content**.

### 5.2 Interface

```typescript
interface ArtifactStoreAdapter {
  put(request: PutArtifactRequest): Promise<Artifact>;
  get(artifactId: string): Promise<ArtifactContent | null>;
  delete(artifactId: string): Promise<void>;
  exists(artifactId: string): Promise<boolean>;
  list(sessionId: string): Promise<Artifact[]>;
}

interface PutArtifactRequest {
  sessionId: string;
  kind: ArtifactKind;
  contentType: string;
  content: Buffer | string;
  provenance: Provenance;
  expiresAt?: string;
}

interface ArtifactContent {
  artifactId: string;
  contentType: string;
  content: Buffer;
  sha256: string;
}
```

### 5.3 Storage layout

```
~/.ollama-coding-agent/artifacts/
  <sessionId>/
    <kind>/
      <artifactId>.bin
      <artifactId>.meta.json
```

- `artifactId` là ULID.
- Không dùng path từ user input.
- Không dùng filename từ workspace.

### 5.4 Content addressing

- Mỗi artifact có `sha256` của content.
- Nếu content trùng → có thể dedup (optional, v2).
- v1: không dedup, đơn giản.

### 5.5 Redaction

- Redact secret trước khi persist.
- Artifact không chứa secret chưa redact.
- Nếu policy không cho phép redact → reject put.

### 5.6 Retention

- Policy quyết định.
- Default: giữ theo session.
- Session terminal + N days → xóa.

### 5.7 File permissions

- Artifact dir: `0700`.
- Artifact file: `0600`.

### 5.8 Error mapping

| Native | Domain |
|---|---|
| `ENOSPC` | `ARTIFACT_DISK_FULL` |
| `EACCES` | `ARTIFACT_PERMISSION` |
| `ENOENT` | `ARTIFACT_NOT_FOUND` |

Tham chiếu: `INVARIANTS.md` → **PR-001, PR-004, SE-005**.

---

## 6. ProcessSupervisor Contract

### 6.1 Vai trò

ProcessSupervisor là **cổng duy nhất** để spawn process.

Không component nào được gọi `child_process` trực tiếp.

### 6.2 Interface

```typescript
interface ProcessSupervisorAdapter {
  spawn(request: SpawnRequest): Promise<ProcessHandle>;
  kill(handle: ProcessHandle, signal?: Signal): Promise<void>;
  killTree(handle: ProcessHandle): Promise<void>;

  wait(handle: ProcessHandle): Promise<ProcessResult>;

  list(): Promise<ProcessHandle[]>;
  cleanupOrphans(): Promise<OrphanReport>;
}

interface SpawnRequest {
  command: string;
  args: string[];
  cwd: string;                    // phải nằm trong workspace root
  env: Record<string, string>;    // đã qua allowlist
  timeoutMs: number;

  sessionId: string;
  toolCallId?: string;

  stdin?: Buffer;
  captureStdout: boolean;
  captureStderr: boolean;

  limits: ProcessLimits;
}

interface ProcessLimits {
  wallClockMs: number;
  cpuMs?: number;
  memoryBytes?: number;
  maxProcesses: number;
  maxFileDescriptors?: number;
}

interface ProcessHandle {
  processId: string;              // internal ULID
  pid: number;
  sessionId: string;
  toolCallId?: string;
  startedAt: string;
}

interface ProcessResult {
  exitCode: number | null;
  signal: string | null;
  stdout?: Buffer;
  stderr?: Buffer;
  durationMs: number;
  timedOut: boolean;
  killed: boolean;
}
```

### 6.3 Rules

- ❌ Không `shell: true`.
- ❌ Không interpolate model output vào command.
- ✅ Args phải là array.
- ✅ Cwd phải canonical, trong workspace root.
- ✅ Env phải qua allowlist.
- ✅ Timeout bắt buộc.
- ✅ Process tree tracking.

### 6.4 Process tree

- Track PID + children.
- Dùng `tree-kill` hoặc platform-specific.
- Kill theo thứ tự: SIGTERM → wait N giây → SIGKILL.
- Kill toàn bộ tree, không chỉ PID chính.

### 6.5 Orphan cleanup

Khi runtime start:

1. Đọc danh sách PID đã spawn trong session cũ.
2. Với mỗi PID:
   - Check process còn sống không.
   - Nếu sống và thuộc runtime → kill.
   - Nếu không sống → cleanup record.
3. Verify không còn orphan.

### 6.6 Environment

- Env allowlist (xem `SECURITY_MODEL.md` §7).
- Không pass env từ parent process trực tiếp.
- Redact secret trong env trước khi log.

### 6.7 Resource limits

- Wall-clock timeout bắt buộc.
- Memory limit (nếu OS hỗ trợ).
- Max processes.
- Max file descriptors.

### 6.8 Exit handling

- Exit code 0 → SUCCEEDED.
- Exit code ≠ 0 → FAILED.
- Timeout → TIMEOUT.
- Signal → tuỳ signal.

### 6.9 Error mapping

| Native | Domain |
|---|---|
| `ENOENT` | `PROCESS_COMMAND_NOT_FOUND` |
| `EACCES` | `PROCESS_PERMISSION` |
| `ETIMEDOUT` | `PROCESS_TIMEOUT` |
| `ENOMEM` | `PROCESS_OOM` |

Tham chiếu: `INVARIANTS.md` → **SE-007, SE-008, CP-005, TG-010**.

---

## 7. Filesystem Adapter

### 7.1 Vai trò

Filesystem adapter là **wrapper an toàn** cho `fs` module.

Không component nào gọi `fs` trực tiếp.

### 7.2 Interface

```typescript
interface FileSystemAdapter {
  readFile(path: string, opts?: ReadOptions): Promise<Buffer>;
  writeFile(path: string, content: Buffer | string, opts?: WriteOptions): Promise<void>;
  delete(path: string, opts?: DeleteOptions): Promise<void>;
  rename(from: string, to: string, opts?: RenameOptions): Promise<void>;
  stat(path: string): Promise<FileStat>;
  readdir(path: string, opts?: ReaddirOptions): Promise<DirEntry[]>;
  exists(path: string): Promise<boolean>;

  realpath(path: string): Promise<string>;
  canonicalize(path: string, root: string): Promise<string>;
}

interface ReadOptions {
  encoding?: 'utf8' | 'binary';
  maxBytes?: number;
}

interface WriteOptions {
  atomic?: boolean;
  mode?: number;
  createDirs?: boolean;
}
```

### 7.3 Boundary enforcement

- Mọi path phải canonicalize qua `WorkspaceManager`.
- Không cho phép path ngoài workspace root.
- Không follow symlink ra ngoài root.
- Reject null byte trong path.

### 7.4 Atomic write

- Write vào temp file.
- `fsync` (nếu policy).
- Rename vào đích.
- Đảm bảo atomic trên cùng filesystem.

### 7.5 Case sensitivity

- Detect OS case sensitivity.
- Normalize theo policy.
- Reject case collision.

### 7.6 Error mapping

| Native | Domain |
|---|---|
| `ENOENT` | `FS_NOT_FOUND` |
| `EACCES` | `FS_PERMISSION` |
| `ENOSPC` | `FS_DISK_FULL` |
| `EEXIST` | `FS_EXISTS` |
| `EISDIR` | `FS_IS_DIR` |

Tham chiếu: `INVARIANTS.md` → **WS-003, WS-004, WS-005**.

---

## 8. Git Adapter

### 8.1 Vai trò

Git adapter cung cấp metadata Git mà không quyết định policy.

### 8.2 Interface

```typescript
interface GitAdapter {
  isRepo(root: string): Promise<boolean>;
  status(root: string): Promise<GitStatus>;
  diff(root: string, opts?: DiffOptions): Promise<GitDiff>;
  log(root: string, opts?: LogOptions): Promise<GitCommit[]>;
  branch(root: string): Promise<string>;
  head(root: string): Promise<string>;

  add(root: string, paths: string[]): Promise<void>;
  commit(root: string, message: string, opts?: CommitOptions): Promise<string>;

  currentUser(root: string): Promise<GitUser>;
}

interface GitStatus {
  branch: string;
  head: string;
  isDirty: boolean;
  hasStagedChanges: boolean;
  hasUntracked: boolean;
  files: GitFileStatus[];
}
```

### 8.3 Rules

- Git adapter chỉ **đọc** metadata.
- Git **write** (add, commit) qua ToolGateway (không tự động).
- Không force push.
- Không rewrite history.
- Không thay đổi config Git.

### 8.4 WorkspaceRevision vs Git

- WorkspaceRevision **không phụ thuộc** Git.
- Git metadata là informational only.
- Verification freshness dùng WorkspaceRevision, không dùng Git commit.

### 8.5 Sensitive data

- Không expose `.git/config` với remote URL chứa token.
- Redact secret trong Git output.

### 8.6 Error mapping

| Native | Domain |
|---|---|
| `not a git repo` | `GIT_NOT_REPO` |
| `no such branch` | `GIT_BRANCH_NOT_FOUND` |
| `conflict` | `GIT_CONFLICT` |

Tham chiếu: `INVARIANTS.md` → **WS-009, PR-004**.

---

## 9. Ollama Adapter

### 9.1 Vai trò

Ollama adapter là **client duy nhất** cho Ollama API.

Không component nào gọi Ollama trực tiếp.

### 9.2 Interface

```typescript
interface OllamaAdapter {
  generate(request: OllamaGenerateRequest): Promise<OllamaGenerateResponse>;
  list(): Promise<OllamaModel[]>;
  pull(model: string): Promise<void>;
  health(): Promise<OllamaHealth>;
}

interface OllamaGenerateRequest {
  model: string;
  prompt: string;
  system?: string;
  format?: 'json';
  options?: {
    temperature?: number;
    top_p?: number;
    num_predict?: number;
    stop?: string[];
  };
  timeoutMs: number;
}

interface OllamaGenerateResponse {
  model: string;
  response: string;
  done: boolean;
  doneReason: string;
  context?: number[];
  totalDurationMs: number;
  loadDurationMs?: number;
  promptEvalCount?: number;
  evalCount?: number;
}
```

### 9.3 Rules

- Endpoint mặc định: `http://localhost:11434`.
- Nếu remote → HTTPS bắt buộc.
- Không gửi secret trong prompt.
- Timeout bắt buộc.
- Retry bounded (xem `MODEL_GATEWAY`).

### 9.4 Model identity

- Ghi `model` + `version` vào provenance.
- Không tự ý switch model.
- Model switch theo policy.

### 9.5 Error mapping

| Native | Domain |
|---|---|
| `ECONNREFUSED` | `MODEL_UNAVAILABLE` |
| `ETIMEDOUT` | `MODEL_TIMEOUT` |
| `context length exceeded` | `MODEL_CONTEXT_OVERFLOW` |
| `invalid json` | `MODEL_OUTPUT_INVALID` |

Tham chiếu: `INVARIANTS.md` → **MG-001..MG-006, SE-010**.

---

## 10. Tree-sitter Adapter (Phase 6)

### 10.1 Vai trò

Tree-sitter cung cấp AST cho code intelligence.

### 10.2 Interface

```typescript
interface TreeSitterAdapter {
  parse(path: string, content: string, language: string): Promise<SyntaxTree>;
  query(tree: SyntaxTree, query: string): Promise<SyntaxMatch[]>;
  supportedLanguages(): string[];
}

interface SyntaxTree {
  root: SyntaxNode;
  language: string;
}

interface SyntaxNode {
  type: string;
  startByte: number;
  endByte: number;
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };
  children: SyntaxNode[];
  text: string;
}
```

### 10.3 Languages (v1)

- TypeScript / JavaScript.
- Dart (Flutter).
- Python (sau).

### 10.4 Use cases

- Symbol extraction.
- Import graph.
- Affected set computation.
- Verification scope.
- Context retrieval.

### 10.5 Performance

- Parse on-demand.
- Cache tree theo (path, mtime).
- Incremental parse khi có thể.

Tham chiếu: `INVARIANTS.md` → **VR-010, CX-002**.

---

## 11. LSP Adapter (Phase 6)

### 11.1 Vai trò

LSP adapter cung cấp semantic information (definition, reference, hover).

### 11.2 Interface

```typescript
interface LspAdapter {
  start(workspaceRoot: string, language: string): Promise<LspSession>;
  stop(session: LspSession): Promise<void>;

  definition(session: LspSession, path: string, position: Position): Promise<Location[]>;
  references(session: LspSession, path: string, position: Position): Promise<Location[]>;
  hover(session: LspSession, path: string, position: Position): Promise<Hover | null>;
  symbols(session: LspSession, path: string): Promise<SymbolInformation[]>;
}
```

### 11.3 LSP servers (v1)

- `typescript-language-server`.
- `dart language-server`.
- `pyright` (sau).

### 11.4 Rules

- LSP là **read-only**.
- Không auto-fix qua LSP.
- Không ghi file qua LSP.

### 11.5 Performance

- LSP có thể chậm.
- Cache kết quả.
- Không block critical path.

---

## 12. Package Manager Adapter

### 12.1 Vai trò

Adapter cho package managers (npm, yarn, pnpm, dart pub, pip).

### 12.2 Interface

```typescript
interface PackageManagerAdapter {
  detect(root: string): Promise<PackageManagerKind | null>;

  install(root: string, opts: InstallOptions): Promise<InstallResult>;
  add(root: string, packages: string[], opts?: AddOptions): Promise<AddResult>;
  remove(root: string, packages: string[]): Promise<RemoveResult>;
  list(root: string): Promise<Package[]>;
}

type PackageManagerKind = 'npm' | 'yarn' | 'pnpm' | 'dart_pub' | 'pip' | 'poetry';
```

### 12.3 Rules

- Package install qua ToolGateway.
- Risk class `PACKAGE_INSTALL`.
- Approval bắt buộc (trừ khi policy override).
- Network qua policy.
- Scratch zone: `node_modules/`, `.venv/`, `.dart_tool/`.

### 12.4 Lock file

- Không sửa lock file trực tiếp.
- Chỉ package manager sửa.
- Lock file trong protected set (không scratch).

### 12.5 Error mapping

| Native | Domain |
|---|---|
| `network error` | `PKG_NETWORK_ERROR` |
| `not found` | `PKG_NOT_FOUND` |
| `conflict` | `PKG_CONFLICT` |

Tham chiếu: `INVARIANTS.md` → **TG-007, SE-006**.

---

## 13. OS Adapter

### 13.1 Vai trò

OS adapter cung cấp thông tin platform-agnostic.

### 13.2 Interface

```typescript
interface OsAdapter {
  platform(): 'win32' | 'darwin' | 'linux';
  isCaseSensitive(): Promise<boolean>;
  tmpDir(): string;
  homeDir(): string;
  pathSeparator(): '/' | '\\';
  cpuCount(): number;
  totalMemoryBytes(): number;
  availableMemoryBytes(): Promise<number>;
}

interface EnvAdapter {
  get(key: string): string | undefined;
  allowlist(): Record<string, string>;
  redact(values: Record<string, string>): Record<string, string>;
}
```

### 13.3 Rules

- Case sensitivity detect, không hardcode.
- Path separator theo OS.
- Env allowlist theo policy.
- Redact secret.

### 13.4 Cross-platform

- Windows: `\\?\` long path.
- macOS: case-insensitive APFS.
- Linux: case-sensitive ext4.

Tham chiếu: `WORKSPACE_SPEC_v1.0` §7.

---

## 14. VS Code Adapter

### 14.1 Vai trò

VS Code adapter là bridge giữa extension và runtime.

### 14.2 Interface

```typescript
interface VscodeBridge {
  sendToWebview(message: WebviewMessage): Promise<void>;
  onWebviewMessage(handler: (msg: WebviewMessage) => void): void;

  sendToRuntime(message: RuntimeMessage): Promise<void>;
  onRuntimeMessage(handler: (msg: RuntimeMessage) => void): void;

  showApproval(request: ApprovalRequest): Promise<ApprovalDecision>;
  showEscalation(request: EscalationRequest): Promise<EscalationDecision>;
  showNotification(msg: NotificationMessage): Promise<void>;
}
```

### 14.3 Rules

- Mọi message phải qua schema validation.
- Không trust webview content.
- CSP strict.
- Không inline script.
- Approval UI hiển thị đầy đủ thông tin.

### 14.4 Approval UI

- Tool name.
- Arguments.
- Risk class.
- Target path.
- Diff (nếu modify).
- Không auto-approve.
- Không "remember forever" cho DESTRUCTIVE.

Tham chiếu: `INVARIANTS.md` → **HI-001..HI-006, SE-* (VS Code)**.

---

## 15. Dependency Direction Enforcement

### 15.1 Rule

- `agent-core` không import infrastructure.
- `agent-core` không import Ollama client.
- `agent-core` không import SQLite.
- `agent-core` không import fs.
- `agent-core` không import child_process.

### 15.2 Enforcement

- Dependency-cruiser rule trong CI.
- ESLint rule `no-restricted-imports`.
- Fail build nếu vi phạm.

### 15.3 Configuration

```json
{
  "forbidden": [
    {
      "name": "no-domain-to-infra",
      "from": { "path": "packages/agent-core" },
      "to": { "path": "packages/infrastructure" }
    },
    {
      "name": "no-domain-to-models",
      "from": { "path": "packages/agent-core" },
      "to": { "path": "packages/models" }
    },
    {
      "name": "no-verification-to-models",
      "from": { "path": "packages/verification" },
      "to": { "path": "packages/models" }
    }
  ]
}
```

Tham chiếu: `INVARIANTS.md` → **DC-001..DC-005**.

---

## 16. Invariant Mapping

| Invariant | Enforcement |
|---|---|
| CP-001 | §3.4 transaction |
| CP-007 | §3.9 + MIGRATION_SPEC |
| CP-008 | §4.3 append-only |
| CP-009 | §3.8 backup + restore |
| PR-001 | §5 artifact provenance |
| PR-003 | §4 append-only, §5 append-only |
| PR-004 | §4.6, §5.5, §6.6 redaction |
| SE-004 | §13 env allowlist |
| SE-005 | redaction all layers |
| SE-007 | §6 timeout |
| SE-008 | §6.4 process tree |
| SE-010 | §9 model output untrusted |
| WS-003 | §7.3 boundary |
| WS-004 | §7.3 symlink |
| WS-009 | §8.4 Git not authority |
| TG-010 | §6 timeout handling |
| MG-001 | §9 only adapter |
| MG-002 | §9 structured output |
| MG-005 | §9.5 error mapping |
| OB-001 | §4 append on transition |
| OB-002 | §4 append on tool call |
| DC-001 | §15 enforcement |
| DC-002 | §1.1 adapter pattern |
| DC-003 | §15 rule |
| DC-004 | §15 rule |
| DC-005 | §15 rule |

---

## 17. Test Matrix

### 17.1 SQLite tests

| Test | Target |
|---|---|
| `open-close` | lifecycle |
| `transaction-atomic` | rollback on error |
| `transaction-nested-reject` | no nested |
| `wal-mode` | enabled |
| `integrity-check` | pass |
| `backup-restore` | data preserved |
| `parameterized-query` | SQL injection safe |
| `file-permissions` | 0600 |

### 17.2 EventLog tests

| Test | Target |
|---|---|
| `append-only` | no update/delete |
| `sequence-monotonic` | no gap |
| `query-by-session` | correct |
| `replay` | deterministic |
| `redaction` | secret removed |
| `concurrent-append` | unique constraint |

### 17.3 ArtifactStore tests

| Test | Target |
|---|---|
| `put-get` | roundtrip |
| `sha256` | verified |
| `redaction` | secret removed |
| `delete` | removed |
| `permissions` | 0600 |
| `list-by-session` | correct |

### 17.4 ProcessSupervisor tests

| Test | Target |
|---|---|
| `spawn-simple` | exit 0 |
| `spawn-fail` | exit ≠ 0 |
| `timeout` | killed |
| `process-tree` | tree killed |
| `orphan-cleanup` | cleaned |
| `env-allowlist` | enforced |
| `cwd-boundary` | enforced |
| `no-shell` | enforced |

### 17.5 Filesystem tests

| Test | Target |
|---|---|
| `canonicalize` | correct |
| `path-escape` | rejected |
| `symlink-escape` | rejected |
| `atomic-write` | atomic |
| `case-collision` | detected |

### 17.6 Git tests

| Test | Target |
|---|---|
| `status` | correct |
| `diff` | correct |
| `log` | correct |
| `no-write` | adapter read-only |
| `secret-redact` | URL redacted |

### 17.7 Ollama tests

| Test | Target |
|---|---|
| `health` | works |
| `generate` | works |
| `timeout` | MODEL_TIMEOUT |
| `unavailable` | MODEL_UNAVAILABLE |
| `context-overflow` | MODEL_CONTEXT_OVERFLOW |
| `invalid-json` | MODEL_OUTPUT_INVALID |

### 17.8 OS adapter tests

| Test | Target |
|---|---|
| `platform-detect` | correct |
| `case-sensitivity` | correct |
| `path-separator` | correct |
| `env-allowlist` | enforced |

### 17.9 VS Code adapter tests

| Test | Target |
|---|---|
| `message-schema` | validated |
| `approval-ui` | correct |
| `no-auto-approve` | enforced |
| `csp` | strict |

### 17.10 Dependency direction tests

| Test | Target |
|---|---|
| `no-domain-to-infra` | enforced |
| `no-domain-to-models` | enforced |
| `no-verification-to-models` | enforced |

---

## 18. Adversarial Tests

| Adversary | Attempt | Expected |
|---|---|---|
| SQL injection | `'; DROP TABLE` | parameterized, safe |
| Path traversal | `../../etc` | rejected |
| Symlink escape | symlink to `/etc` | rejected |
| Env leak | `AWS_SECRET` in child | excluded |
| Secret in log | JWT in output | redacted |
| Fork bomb | deep process tree | killed |
| Process orphan | crash | cleaned |
| Model output invalid | malformed JSON | MODEL_OUTPUT_INVALID |
| Model timeout | slow response | MODEL_TIMEOUT |
| Shell injection | `; rm -rf` | rejected |
| DB corruption | kill mid-write | WAL recovers |
| Disk full | during write | rollback |
| Concurrent DB | two writers | busy timeout |
| Approval forge | model output claims approval | ignored |

---

## 19. Open Questions (Phase 0)

1. **SQLite version**: minimum version?
2. **Backup retention**: bao lâu?
3. **Artifact retention**: bao lâu?
4. **Process limits**: default values?
5. **Ollama endpoint**: localhost only hay remote?
6. **LSP server**: bundle hay user install?
7. **Tree-sitter**: bundle grammar hay user install?
8. **VS Code version**: minimum?
9. **Node version**: minimum?
10. **Windows long path**: có cần enable không?

---

## 20. North Star

> **Infrastructure là adapter, không phải authority. Domain không biết environment. Environment không quyết định domain.**

Mọi adapter, mọi transaction, mọi process, mọi artifact tồn tại để trả lời:

- **Ai gọi**?
- **Gọi gì**?
- **Có qua boundary** không?
- **Có bị redact** không?
- **Có audit** không?
- **Có recover** không?

Và câu hỏi cuối cùng:

> **Runtime an toàn không phụ thuộc vào việc model ngoan, mà phụ thuộc vào việc infrastructure không thể bị bypass.**

---

## 21. Recommended Next Steps

Với `INFRASTRUCTURE_SPEC.md`, chúng ta đã hoàn thành **9 file spec cốt lõi** của Phase 0:

| # | File | Status |
|---|---|---|
| 1 | `INVARIANTS.md` | ✅ |
| 2 | `WORKSPACE_SPEC_v1.0.md` | ✅ |
| 3 | `DOMAIN_CONTRACTS.md` | ✅ |
| 4 | `STATE_MACHINE_SPEC.md` | ✅ |
| 5 | `GRAPH_PROTOCOL.md` | ✅ |
| 6 | `VERIFICATION_PROTOCOL.md` | ✅ |
| 7 | `SECURITY_MODEL.md` | ✅ |
| 8 | `MIGRATION_SPEC.md` | ✅ |
| 9 | `EVALUATION_MODEL.md` | ✅ |
| 10 | `CONTEXT_SPEC_v1.0.md` | ✅ |
| 11 | `INFRASTRUCTURE_SPEC.md` | ✅ |

