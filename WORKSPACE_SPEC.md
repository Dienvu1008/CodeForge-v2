# WORKSPACE_SPEC_v1.0.md

**Ollama Coding Agent — Workspace Subsystem Specification**

Version: 1.0
Status: Architecture Baseline
Owner: Execution Plane / WorkspaceManager
Scope: v1 (single user, single workspace, sequential, local)
Related specs:
`INVARIANTS.md` (WS-*, VR-*, CP-*, SE-*), `DOMAIN_CONTRACTS.md`,
`VERIFICATION_PROTOCOL.md`, `SECURITY_MODEL.md`, `MIGRATION_SPEC.md`

---

## 0. Mục đích

Workspace là **vùng vật lý nơi agent thực thi công việc**. Đây là nơi mọi mutation, verification, và evidence diễn ra. Vì vậy Workspace phải có:

- **boundary rõ ràng** (agent không được mutate ngoài policy);
- **revision có thể hash canonical** (verification freshness);
- **scratch zone tường minh** (verification có thể mutate cục bộ an toàn);
- **lock** (single active session);
- **crash-safe reconciliation** (không để state mồ côi).

Toàn bộ spec này phục vụ một câu hỏi duy nhất:

> «Workspace nào đang được agent xác nhận, tại revision nào, với mutation nào?»

Câu trả lời phải **deterministic, auditable, reproducible**.

---

## 1. Định nghĩa

| Thuật ngữ | Định nghĩa |
|---|---|
| **Workspace** | Một thư mục root mà agent được phép đọc/ghi theo policy. |
| **WorkspaceRoot** | Canonical absolute path của workspace. |
| **WorkspaceRevision** | Snapshot logic của workspace tại một thời điểm, có hash canonical. |
| **Scratch Zone** | Tập path được declare mà verification/tooling có thể mutate mà không làm invalid revision. |
| **Protected Set** | Tập path thuộc workspace revision hash (mọi thứ trừ scratch zone). |
| **Agent-Owned Change** | Mutation do agent tạo trong session hiện tại. |
| **User-Existing Change** | Mutation đã có trước session (kể cả uncommitted). |
| **Canonical Form** | Chuẩn hóa logic của workspace để hash cross-platform ổn định. |
| **WorkspaceLock** | Khóa độc quyền 1 session / workspace. |

---

## 2. Workspace Root và Boundary

### 2.1 WorkspaceRoot

- Là **canonical absolute path** (đã resolve symlink, normalize case theo OS policy).
- Được chọn khi user mở workspace trong VS Code hoặc khi session được tạo.
- Không thay đổi trong suốt session.
- Nếu root thay đổi (user di chuyển/rename), session phải ABORT và tạo session mới.

### 2.2 Boundary rules

- Mọi filesystem operation phải resolve realpath và check nằm trong `WorkspaceRoot`.
- **Không** cho phép `..` escape, symlink escape, hoặc absolute path escape.
- **Không** cho phép truy cập parent directory.
- **Không** cho phép truy cập sibling directory ngoài workspace.
- Trường hợp đặc biệt: `.git` được phép **đọc** để lấy metadata; **ghi** chỉ trong policy rõ ràng (ví dụ `git commit`).

Tham chiếu: `INVARIANTS.md` → **WS-003, WS-004, WS-005**.

---

## 3. Path Policy

### 3.1 Canonicalization

Path canonicalization phải được thực hiện **trước mọi operation**:

```
canonical(path) =
  realpath(
    normalize(
      absolutize(path, workspaceRoot)
    )
  )
```

Trong đó:

| Step | Rule |
|---|---|
| `absolutize` | Nếu relative, join với workspaceRoot. |
| `normalize` | Loại `..`, `.`, redundant separators. |
| `realpath` | Resolve symlink; reject nếu target ngoài root. |

### 3.2 Path separators

- Input có thể dùng `\` hoặc `/`.
- Internal canonical form dùng `/`.
- Khi ghi disk, dùng separator của OS.

### 3.3 Case sensitivity

| OS | Default policy |
|---|---|
| Windows | Case-insensitive (theo NTFS default) |
| macOS | Case-insensitive (theo APFS default) |
| Linux | Case-sensitive |

Policy **không được hardcode**; phải đọc từ `os.caseSensitivity`.

Nếu policy phát hiện case collision (hai file chỉ khác case) trên case-insensitive FS → **reject commit** để tránh mất file khi copy cross-platform.

### 3.4 Symlink policy

| Hành vi | Policy |
|---|---|
| Đọc file qua symlink nội bộ root | Cho phép, resolve realpath |
| Đọc file qua symlink ra ngoài root | **Reject** |
| Ghi file qua symlink ra ngoài root | **Reject** |
| Tạo symlink mới ra ngoài root | **Reject** |
| Tạo symlink nội bộ root | Cho phép nếu policy cho phép |
| Follow symlink trong hash | **Không** — hash dùng realpath đã resolve |
| Symlink loop | Reject (`MAX_SYMLINK_DEPTH`) |

### 3.5 Reserved paths

Các path sau **không được** mutate bởi agent ngoài policy tường minh:

- `.git/` (trừ khi tool `git` được approve)
- `node_modules/` (trừ khi scratch-zone hoặc package install tool)
- `.env`, `.env.*` (đọc có thể; ghi cần approval)
- bất kỳ path trong `excludedScratchPaths`

---

## 4. Scratch Zone

### 4.1 Định nghĩa

Scratch Zone là tập path **được declare tường minh** mà mutation trong đó **không** làm thay đổi WorkspaceRevision hash.

Mục đích: cho phép verification/tooling tạo artifact tạm (test cache, build output) mà không invalidate chính verification.

### 4.2 Cấu trúc declaration

```yaml
scratchZones:
  - id: node
    paths:
      - node_modules/
      - .npm/
      - .cache/
    reason: "npm/yarn/pnpm install and cache"
    lifecycle: per-session | per-run | ephemeral

  - id: python
    paths:
      - .pytest_cache/
      - __pycache__/
      - .mypy_cache/
      - .ruff_cache/
      - .venv/
    reason: "python test and type cache"
    lifecycle: per-session

  - id: build
    paths:
      - dist/
      - build/
      - out/
      - coverage/
      - test-results/
    reason: "build and test output"
    lifecycle: per-run

  - id: tmp
    paths:
      - .tmp/
      - .agent-tmp/
    reason: "agent scratch"
    lifecycle: ephemeral
```

### 4.3 Rules

- Scratch zone phải là **prefix match** trên canonical path.
- Scratch zone **không được** bao gồm source code.
- Scratch zone **không được** bao gồm `.git/`.
- Scratch zone phải được declare **trước** verification; không được thêm giữa verification.
- Nếu verification mutate path ngoài scratch → **VR-003 violation**.

### 4.4 Interaction với hash

```
hash(workspace) = hash(
  files in (workspaceRoot \ union(scratchZones))
)
```

- File trong scratch zone: **không** đóng góp vào hash.
- File trong protected set: **có** đóng góp.
- Nếu scratch zone path bị xóa hoặc tạo lại: hash **không** đổi.

### 4.5 Lifecycle

| Lifecycle | Khi nào xóa |
|---|---|
| `ephemeral` | Cuối mỗi TaskRun |
| `per-run` | Cuối mỗi verification |
| `per-session` | Khi session COMPLETED/ABORTED |

Xóa scratch zone **không** tạo revision mới.

Tham chiếu: `INVARIANTS.md` → **WS-007, VR-003, VR-008**.

---

## 5. WorkspaceRevision

### 5.1 Định nghĩa

WorkspaceRevision là **snapshot logic** của workspace tại một thời điểm, có hash canonical.

### 5.2 Schema

```typescript
interface WorkspaceRevision {
  revisionId: string;              // ULID, unique
  canonicalFormVersion: string;    // "v1"
  root: string;                    // canonical absolute path
  includedPaths: string[];         // sorted, canonical
  excludedScratchPaths: string[];  // sorted, canonical
  hashAlgorithm: "blake3" | "sha256";
  hash: string;                    // hex
  fileCount: number;
  totalBytes: number;              // optional, for diagnostics
  createdAt: string;               // ISO 8601
  createdBy: {
    sessionId: string;
    taskId?: string;
    taskRunId?: string;
    reason: "session_start" | "pre_verify" | "post_verify"
           | "pre_checkpoint" | "manual";
  };
  gitMetadata?: {
    head: string;
    branch: string;
    isDirty: boolean;
    hasStagedChanges: boolean;
  };
}
```

### 5.3 Rules

- `revisionId` là **immutable**.
- `hash` là **deterministic**.
- `gitMetadata` là **informational only** — không dùng cho freshness.
- `revisionId` không bao giờ tái sử dụng.
- Revision là **append-only**: không sửa revision đã tạo.

Tham chiếu: `INVARIANTS.md` → **WS-001, WS-002, WS-009**.

---

## 6. Canonical Hash

### 6.1 Mục tiêu

- Cross-platform reproducible: cùng logical content → cùng hash trên Windows/Linux/macOS.
- Không có false-negative: content khác → hash khác.
- Không phụ thuộc Git.
- Không phụ thuộc metadata hệ thống (mtime, owner, inode).

### 6.2 Algorithm

```
INPUT:
  root          = canonical workspace root
  excludedSet   = union(scratchZones) resolved to canonical
  algo          = "blake3" (default) | "sha256"

STEPS:
  1. Walk root recursively.
  2. For each entry:
       a. canonicalPath = realpath(entry)
       b. if canonicalPath outside root → SKIP + WARN
       c. if canonicalPath ∈ excludedSet → SKIP
       d. if entry is symlink → record as SYMLINK, do not follow
       e. if entry is file → record FILE
       f. if entry is directory → recurse (record DIRECTORY only
          if it contains no files; empty dirs matter)
  3. Sort entries by canonical relative path (byte-wise, UTF-8).
  4. For each entry, emit a canonical line:
       FILE   <relpath>\0<size>\0<sha256-of-content>\n
       SYMLINK <relpath>\0<target>\n
       DIR    <relpath>/\n
  5. Compute hash over concatenated canonical lines with `algo`.
```

### 6.3 Canonical line format

```
<type>\t<relpath>\t<payload>\n
```

Chi tiết:

| Field | Rule |
|---|---|
| `type` | `FILE`, `SYMLINK`, `DIR` |
| `relpath` | canonical relative path, `/` separator, UTF-8, NFC normalized |
| `payload` | FILE: `<size>\0<contentHash>`; SYMLINK: `<target>`; DIR: empty |
| Terminator | `\n` |
| Encoding | UTF-8, no BOM |

### 6.4 Line ending policy

File content hash dùng **raw bytes**, không normalize line endings. Lý do:

- Normalize có thể che giấu thay đổi thật.
- Cross-platform: file được tạo bởi tool trên Windows vs Linux có thể khác EOL — và đó là **thay đổi thật**.

Tuy nhiên, vì hash là cross-platform reproducible, test vectors phải dùng **binary fixtures**, không dùng text được check-out qua Git (Git autocrlf có thể thay đổi).

### 6.5 File content hashing

- Hash từng file bằng **SHA-256** (luôn, bất kể algo chính).
- Hash này được embed trong canonical line.
- Lý do: cho phép streaming hash, không cần load toàn bộ file.

### 6.6 Exclusion resolution

`excludedSet` phải được resolve theo:

- `realpath` của mỗi scratch path.
- Nếu scratch path chưa tồn tại, đánh dấu là "virtual exclusion" — nghĩa là bất kỳ file nào tương lai tạo tại path đó đều bị exclude.
- Match theo **path prefix**, không theo glob.

### 6.7 Performance

- Hash streaming: không load file > 16 MB vào memory.
- Parallel walk với bounded concurrency.
- Cache file hash theo `(realpath, size, mtime, inode)` — invalidate khi mtime đổi.
- Với workspace > 100k file, hash có thể mất vài giây; **không** block UI thread.

Tham chiếu: `INVARIANTS.md` → **WS-001, WS-002**.

---

## 7. Cross-Platform Test Vectors

### 7.1 Fixtures

Test vectors phải là **binary fixtures** đóng gói dưới dạng tarball hoặc base64, không phụ thuộc Git checkout.

Thư mục:

```
tests/workspace/vectors/
  v001-empty/
  v002-single-file/
  v003-multiple-files/
  v004-nested-dirs/
  v005-line-endings-crlf/
  v006-line-endings-lf/
  v007-line-endings-mixed/
  v008-unicode-nfc/
  v009-unicode-nfd/
  v010-symlink-internal/
  v011-symlink-external/
  v012-scratch-zone/
  v013-empty-directory/
  v014-file-with-spaces/
  v015-file-with-unicode-name/
  v016-case-collision/
  v017-large-file/
  v018-many-files/
  v019-permissions/
  v020-special-chars/
```

### 7.2 Expected results

Mỗi vector có `expected.json`:

```json
{
  "vectorId": "v002-single-file",
  "canonicalFormVersion": "v1",
  "hashAlgorithm": "blake3",
  "expectedHash": "...",
  "expectedFileCount": 1,
  "expectedBytes": 42,
  "notes": "single ASCII file"
}
```

### 7.3 Cross-platform CI matrix

| Runner | OS | FS |
|---|---|---|
| `ubuntu-latest` | Linux | ext4 |
| `macos-latest` | macOS | APFS |
| `windows-latest` | Windows | NTFS |

Mỗi runner phải:

1. Extract fixture.
2. Compute hash.
3. Assert `hash == expected.json.expectedHash`.

Nếu fail trên bất kỳ runner nào → **WS-001 violation**.

### 7.4 Test vector quan trọng

#### v005 vs v006 — Line endings

- v005: file có `\r\n`.
- v006: file có `\n`.
- **Expected**: hash khác nhau.
- Lý do: EOL là thay đổi thật.

#### v008 vs v009 — Unicode

- v008: filename dùng NFC (composed).
- v009: filename dùng NFD (decomposed).
- **Expected**: hash **giống nhau** sau NFC normalization.
- Lý do: NFC normalization là canonical.

#### v010 vs v011 — Symlink

- v010: symlink trỏ tới file nội bộ root → hash record SYMLINK với target.
- v011: symlink trỏ ra ngoài root → **reject** khi walk (skip với WARN).
- **Expected**: v011 không bao gồm symlink target content.

#### v012 — Scratch zone

- Workspace có `node_modules/foo.js`.
- `node_modules/` trong scratch zone.
- **Expected**: hash không bao gồm `node_modules/foo.js`.

#### v013 — Empty directory

- Workspace có `src/` rỗng.
- **Expected**: hash bao gồm `DIR src/`.
- Lý do: empty dir là thông tin có ý nghĩa (có thể là placeholder).

#### v014 — File with spaces

- File: `my file.txt`.
- **Expected**: hash ổn định; canonical line dùng tab separator, không space.

#### v015 — Unicode filename

- File: `日本語.txt`.
- **Expected**: hash ổn định; UTF-8 NFC.

#### v016 — Case collision

- Trên case-insensitive FS: hai file `Foo.ts` và `foo.ts` không cùng tồn tại.
- Trên case-sensitive FS: có thể cùng tồn tại.
- **Expected**: nếu OS case-insensitive, hash reject khi tạo (không cho phép).
- Nếu OS case-sensitive, hash bao gồm cả hai, phân biệt case.

#### v017 — Large file

- File: 100 MB binary.
- **Expected**: hash streaming, không OOM.

#### v018 — Many files

- 10,000 file nhỏ.
- **Expected**: hash trong < 10s.

#### v019 — Permissions

- File có mode `0755` vs `0644`.
- **Expected**: hash **giống nhau** (permission không thuộc canonical form v1).
- Ghi chú: nếu sau này cần track permission, bump `canonicalFormVersion` lên `v2`.

#### v020 — Special chars

- File: `foo\nbar.txt` (newline trong filename — chỉ POSIX).
- File: `foo\tbar.txt` (tab trong filename).
- **Expected**: canonical line escape `\n`, `\t`, `\0` trong relpath.
- Escape scheme: `\n` → `\\n`, `\t` → `\\t`, `\0` → `\\0`, `\\` → `\\\\`.

---

## 8. Workspace Lock

### 8.1 Mục tiêu

Đảm bảo **1 active session / workspace** (SS-001).

### 8.2 Lock record

```typescript
interface WorkspaceLock {
  lockId: string;              // ULID
  workspaceId: string;         // hash of canonical root
  workspaceRoot: string;
  sessionId: string;
  processId: number;
  hostname: string;
  runtimeVersion: string;
  createdAt: string;
  heartbeatAt: string;         // updated every N seconds
  heartbeatIntervalMs: number; // default 5000
}
```

### 8.3 Storage

- Lock được lưu tại `~/.ollama-coding-agent/locks/<workspaceId>.lock`.
- Atomic write: `write temp file → rename`.
- Lock chứa JSON record.

### 8.4 Acquire

```
1. Read lock file nếu tồn tại.
2. Nếu không tồn tại → tạo mới, return OK.
3. Nếu tồn tại:
   a. Check heartbeat: nếu heartbeatAt < now - 3 * interval → stale.
   b. Nếu stale → validate process (PID, hostname) → recover.
   c. Nếu không stale → reject với SESSION_LOCKED.
4. Nếu acquire thành công → start heartbeat loop.
```

### 8.5 Heartbeat

- Update mỗi `heartbeatIntervalMs`.
- Heartbeat write là atomic.
- Nếu không update được trong `3 * interval` → coi là stale.

### 8.6 Release

- Xóa lock file khi session COMPLETED/ABORTED.
- Best-effort; nếu fail, lock sẽ stale và được recover sau.

### 8.7 Stale recovery

```
1. Read lock.
2. Check hostname: nếu khác hostname hiện tại → không thể validate process → 
   dùng heuristic: nếu heartbeat quá cũ (> 24h) → force recover.
3. Nếu cùng hostname:
   a. Check PID tồn tại.
   b. Nếu không tồn tại → recover.
   c. Nếu tồn tại → reject (không recover lock của process sống).
4. Recover: ghi event LOCK_RECOVERED, xóa lock, acquire mới.
```

Tham chiếu: `INVARIANTS.md` → **SS-001, SS-005, WS-010**.

---

## 9. Mutation Tracking

### 9.1 Phân loại

| Loại | Định nghĩa | Ví dụ |
|---|---|---|
| **Agent-Owned** | Mutation do agent tạo trong session | tool call write file |
| **User-Existing** | Mutation có trước session | user có uncommitted change |
| **Verification** | Mutation do verification tool tạo | test cache |
| **External** | Mutation không rõ nguồn | user edit giữa session |

### 9.2 Tracking mechanism

Trước session:

```
1. Snapshot workspace → revisionId R0.
2. Ghi `baselineFiles` = { relpath → contentHash }.
```

Trong session:

- Mỗi tool call ghi `ChangeRecord`:
  ```typescript
  interface ChangeRecord {
    changeId: string;
    sessionId: string;
    taskRunId?: string;
    toolCallId?: string;
    kind: "create" | "modify" | "delete" | "rename";
    relpath: string;
    beforeHash?: string;
    afterHash?: string;
    ownedBy: "agent" | "verification";
    at: string;
  }
  ```

Sau session:

- Recompute workspace → revisionId R1.
- Diff R0 vs R1 → `unownedChanges`.

### 9.3 Conflict detection

- Nếu agent muốn ghi file mà file đó có **user-existing change** (diff so với baseline) → policy required.
- Policy mặc định: **ask user** (approval).
- Policy có thể cấu hình: `allow_overwrite`, `preserve_user_change`, `abort_on_conflict`.

Tham chiếu: `INVARIANTS.md` → **WS-006, WS-008**.

---

## 10. Checkpoints

### 10.1 Định nghĩa

Checkpoint là **consistency boundary** giữa graph, workspace, execution, và budget.

### 10.2 Schema

```typescript
interface Checkpoint {
  checkpointId: string;
  sessionId: string;
  createdAt: string;

  graphVersion: number;
  workspaceRevision: WorkspaceRevision;
  agentChangeSet: ChangeRecord[];

  sessionState: SessionState;
  taskStates: Record<string, TaskState>;
  budgetState: BudgetState;

  lastEventId: string;
  schemaVersion: number;
}
```

### 10.3 Atomic write

- Checkpoint phải được ghi trong **một transaction** (CP-002).
- Nếu bất kỳ field nào không ghi được → rollback toàn bộ.
- Không có "partial checkpoint".

### 10.4 Trigger

- Session start.
- Trước mỗi TaskRun.
- Sau mỗi verification.
- Khi budget threshold (ví dụ 90%) đạt.
- Khi user yêu cầu (manual).
- Định kỳ (nếu policy).

### 10.5 Recovery

- Khi crash, load checkpoint gần nhất.
- Reconcile workspace với checkpoint.workspaceRevision.
- Nếu workspace hiện tại khác revision → mark INTERRUPTED, recovery policy quyết định.

Tham chiếu: `INVARIANTS.md` → **CP-002, CP-003, CP-009**.

---

## 11. Reconciliation

### 11.1 Khi nào

- Sau crash.
- Sau cancel.
- Khi process tree không cleanup được.

### 11.2 Process reconciliation

```
1. Đọc danh sách PID đã spawn trong session.
2. Với mỗi PID:
   a. Check process còn sống không.
   b. Nếu sống và thuộc session → kill (SIGTERM, sau N giây SIGKILL).
   c. Nếu không sống → mark dead.
3. Verify process tree: không có child nào còn sót.
```

### 11.3 Workspace reconciliation

```
1. Compute current revision Rc.
2. Load checkpoint revision Rp.
3. Nếu Rc == Rp → không cần reconcile.
4. Nếu Rc != Rp:
   a. Diff → danh sách path thay đổi.
   b. Phân loại: trong scratch / ngoài scratch.
   c. Nếu thay đổi ngoài scratch không do agent tạo → EXTERNAL_MUTATION.
   d. Ghi event, mark session/task là INTERRUPTED.
```

### 11.4 Cancellation semantics

- **STOP ≠ ROLLBACK**.
- Khi user stop:
  1. Kill process tree.
  2. Reconcile workspace.
  3. Ghi checkpoint.
  4. Report partial changes.
- **Không** tự động rollback nếu policy không yêu cầu.

Tham chiếu: `INVARIANTS.md` → **CP-004, CP-005, CP-006, EX-006**.

---

## 12. Security

### 12.1 Path traversal

- Reject mọi path có `..` escape.
- Reject absolute path ngoài root.
- Reject UNC path trên Windows nếu ngoài policy.
- Reject `\\?\` prefix trên Windows (long path escape) nếu ngoài policy.

### 12.2 Symlink escape

- `realpath` resolve trước mọi operation.
- Reject nếu target ngoài root.
- Detect symlink loop.

### 12.3 Environment

- Environment allowlist: chỉ pass biến môi trường được whitelist cho tool.
- Redact secret trước khi ghi log/artifact.
- Không pass `.env` content vào LLM context trừ khi policy cho phép.

### 12.4 Secret redaction

Các pattern phải được redact:

- API keys (regex theo pattern phổ biến).
- JWT, Bearer tokens.
- Private keys (`-----BEGIN ... PRIVATE KEY-----`).
- Passwords trong connection strings.
- `.env` values cho keys khớp `*_KEY`, `*_SECRET`, `*_TOKEN`, `*_PASSWORD`.

### 12.5 Filesystem permissions

- Không tự ý `chmod` file.
- Không tự ý `chown`.
- Không tự ý tạo setuid/setgid file.

Tham chiếu: `INVARIANTS.md` → **WS-003, WS-004, SE-004, SE-005**.

---

## 13. Workspace Revision — Freshness

### 13.1 Freshness rule

```
valid(report, currentRevision) =
  report.targetWorkspaceRevision.hash == currentRevision.hash
  AND report.targetWorkspaceRevision.canonicalFormVersion
      == currentRevision.canonicalFormVersion
```

Nếu không valid → evidence stale.

### 13.2 Stale evidence handling

- Stale evidence **không được** complete task (VR-002).
- Nếu task đã PASSED với stale evidence → **không** revert tự động; ghi event, đánh dấu task cần re-verify.
- Nếu task đang VERIFYING với stale evidence → reject transition sang PASSED.

### 13.3 Freshness trong multi-step verification

- Mỗi verification check có thể dùng revision riêng.
- **Final** verification phải dùng revision khớp với revision hiện tại tại thời điểm complete.

Tham chiếu: `INVARIANTS.md` → **VR-001, VR-002, VR-007, VR-011**.

---

## 14. WorkspaceManager API

### 14.1 Interface (TypeScript)

```typescript
interface WorkspaceManager {
  // Lifecycle
  open(root: string, policy: WorkspacePolicy): Promise<WorkspaceHandle>;
  close(handle: WorkspaceHandle): Promise<void>;

  // Lock
  acquireLock(handle: WorkspaceHandle, sessionId: string): Promise<WorkspaceLock>;
  releaseLock(lock: WorkspaceLock): Promise<void>;
  recoverLock(workspaceRoot: string): Promise<WorkspaceLock | null>;

  // Revision
  computeRevision(
    handle: WorkspaceHandle,
    reason: WorkspaceRevision['createdBy']['reason'],
  ): Promise<WorkspaceRevision>;

  // Mutation
  readFile(handle, relpath): Promise<Buffer>;
  writeFile(handle, relpath, content, opts): Promise<ChangeRecord>;
  deleteFile(handle, relpath, opts): Promise<ChangeRecord>;
  rename(handle, from, to, opts): Promise<ChangeRecord>;

  // Scratch
  declareScratchZone(handle, zone: ScratchZone): Promise<void>;
  listScratchZones(handle): Promise<ScratchZone[]>;

  // Checkpoint
  createCheckpoint(handle, state: CheckpointState): Promise<Checkpoint>;
  loadCheckpoint(handle, checkpointId: string): Promise<Checkpoint>;

  // Reconciliation
  reconcile(handle, checkpoint: Checkpoint): Promise<ReconciliationReport>;
}
```

### 14.2 Error classes

| Error | Khi nào |
|---|---|
| `WORKSPACE_NOT_FOUND` | Root không tồn tại |
| `WORKSPACE_LOCKED` | Lock đang giữ |
| `PATH_ESCAPE` | Path ngoài root |
| `SYMLINK_ESCAPE` | Symlink target ngoài root |
| `SYMLINK_LOOP` | Symlink loop |
| `SCRATCH_VIOLATION` | Mutation ngoài scratch trong verify |
| `STALE_REVISION` | Revision không khớp |
| `USER_CHANGE_CONFLICT` | Overwrite user-existing change |
| `CHECKPOINT_INCOMPLETE` | Checkpoint thiếu field |
| `RECONCILE_FAILED` | Reconciliation fail |

---

## 15. Invariant Mapping

| Invariant | Enforcement trong Workspace Spec |
|---|---|
| WS-001 | §6 Canonical Hash |
| WS-002 | §6.2 + §7.2 (test vectors) |
| WS-003 | §2.2 + §12.1 |
| WS-004 | §3.4 + §12.2 |
| WS-005 | §2.2 + §3.5 |
| WS-006 | §9.3 |
| WS-007 | §4 |
| WS-008 | §9 |
| WS-009 | §5.3 |
| WS-010 | §8.7 |
| VR-001 | §5, §13 |
| VR-002 | §13.2 |
| VR-003 | §4.3 |
| VR-007 | §13.1 |
| VR-008 | §4.3 |
| VR-011 | §13.1 |
| CP-002 | §10.3 |
| CP-003 | §10.5 |
| CP-004 | §11.1 |
| CP-005 | §11.2 |
| CP-006 | §11.4 |
| CP-009 | §10.3 |
| SE-004 | §12.3 |
| SE-005 | §12.4 |
| SS-001 | §8 |
| SS-005 | §8.7 |

---

## 16. Test Plan

### 16.1 Unit tests

| Test | Coverage |
|---|---|
| `canonicalize-path` | `..`, `.`, redundant separators, absolute/relative |
| `resolve-symlink` | Internal, external, loop |
| `case-sensitivity` | Windows/macOS/Linux policy |
| `scratch-zone-prefix` | Prefix match, không glob |
| `hash-line-format` | Escape special chars |
| `unicode-nfc` | NFC vs NFD |
| `line-endings` | CRLF vs LF vs mixed |

### 16.2 Integration tests

| Test | Coverage |
|---|---|
| `lock-acquire-release` | Single session |
| `lock-stale-recovery` | PID không tồn tại |
| `lock-conflict` | Hai session cùng workspace |
| `revision-compute` | Determinism |
| `revision-diff` | Detect changes |
| `checkpoint-atomic` | Rollback on partial |
| `reconcile-after-crash` | Unfinished run |
| `cancel-no-rollback` | Stop ≠ rollback |
| `user-change-conflict` | Overwrite detection |

### 16.3 Cross-platform tests

| Test | Runner |
|---|---|
| `hash-v001..v020` | ubuntu, macos, windows |
| `path-normalization` | ubuntu, macos, windows |
| `case-collision` | ubuntu, macos, windows |

### 16.4 Adversarial tests

| Test | Target |
|---|---|
| `path-traversal-..%2F` | WS-003 |
| `symlink-to-/etc` | WS-004 |
| `symlink-loop` | WS-004 |
| `write-outside-root` | WS-005 |
| `scratch-zone-escape` | VR-003 |
| `stale-revision` | VR-002 |
| `unicode-lookalike` | WS-001 |
| `null-byte-in-path` | WS-003 |

---

## 17. Migration & Versioning

### 17.1 Canonical Form Version

- `v1` — current.
- Thay đổi format hash → bump `canonicalFormVersion`.
- Revision cũ với `canonicalFormVersion: v1` vẫn queryable.
- Verification phải check `canonicalFormVersion` khớp.

### 17.2 Schema Version

- `WorkspaceRevision` schema có `schemaVersion`.
- Migration phải versioned (xem `MIGRATION_SPEC.md`).
- Không xóa revision cũ; chỉ đánh dấu `legacy`.

---

## 18. Open Questions (Phase 0)

Các câu hỏi cần chốt trước Phase 1:

1. **Permission tracking**: có cần track file mode trong hash không? Hiện tại: không. Nếu cần → bump `v2`.
2. **File mtime**: có dùng để fast-path hash không? Hiện tại: dùng cho cache invalidation, không dùng cho hash.
3. **Large workspace**: threshold nào thì chuyển sang incremental hash? Hiện tại: chưa.
4. **Symlink target trong hash**: record target như string hay resolve? Hiện tại: record target string, không follow.
5. **Scratch zone declaration**: user config hay agent tự đề xuất? Hiện tại: user config + agent đề xuất qua approval.
6. **Cross-device rename**: reject hay emulate? Hiện tại: emulate (copy + delete).

---

## 19. North Star

> **Workspace is the source of truth for what the agent has actually done, not what the model claims to have done.**

Mọi revision, mọi mutation, mọi checkpoint tồn tại để trả lời câu hỏi đó — và để verification có thể gắn chặt vào một revision cụ thể.

---