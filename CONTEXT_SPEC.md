# CONTEXT_SPEC_v1.0.md

**Ollama Coding Agent — Context Plane, Retrieval, Trust Boundary & Token Budget**

Version: 1.0
Status: Architecture Baseline
Owner: Intelligence Plane / ContextBuilder
Scope: v1 (single user, single workspace, sequential, local)
Related specs:
`INVARIANTS.md` (CX-*, SE-*, PR-*, VR-*), `DOMAIN_CONTRACTS.md`,
`WORKSPACE_SPEC_v1.0`, `VERIFICATION_PROTOCOL.md`, `SECURITY_MODEL.md`,
`STATE_MACHINE_SPEC.md`, `GRAPH_PROTOCOL.md`

---

## 0. Mục đích

Context Plane là **subsystem độc lập** chịu trách nhiệm cung cấp **đúng thông tin, đúng lượng, đúng nguồn** cho LLM tại mỗi bước.

Nguyên tắc trung tâm:

> **Context không phải là utility phụ. Context là evidence có provenance.**

Và:

> **Không cố làm LLM thông minh bằng cách nhồi prompt. Thay vào đó: LLM intelligence + deterministic runtime + good context + good verification + bounded recovery.**

File này định nghĩa:

- Context model (snapshot, item, provenance);
- Context pipeline;
- Retriever / FileSelector / Compactor / TokenBudgeter;
- Trust boundary và prompt injection marking;
- Provenance tracking;
- Snapshot versioning;
- Persistence schema;
- API;
- Invariant mapping;
- Test matrix;
- Adversarial cases.

Tham chiếu: `INVARIANTS.md` → **CX-001..CX-006, SE-001, SE-002, PR-001..PR-004, VR-001**.

---

## 1. Nguyên tắc nền tảng

### 1.1 Context là evidence, không phải authority

- Context cung cấp thông tin cho LLM.
- Context **không** quyết định action.
- Context **không** thay thế policy.
- Context **không** là runtime state.

### 1.2 Mọi context item có provenance

- Mỗi item phải biết nguồn gốc: file nào, revision nào, đọc vì lý do gì.
- Không có "anonymous context".
- Provenance append-only.

### 1.3 Trust marking bắt buộc

- Mọi content từ workspace/external phải được đánh dấu `trust: 'untrusted'`.
- Content từ system/policy/task đánh dấu `trust: 'trusted'`.
- Không có item nào không có trust level.

### 1.4 Snapshot immutable và versioned

- Mỗi lần build context tạo một `ContextSnapshot` mới.
- Snapshot immutable sau commit.
- Snapshot bind với `workspaceRevision`.

### 1.5 Token budget là hard limit

- Không vượt token budget.
- Không silent truncate.
- Nếu không đủ budget → giảm item hoặc fail rõ ràng.

### 1.6 Determinism

- Cùng input → cùng snapshot (về mặt logical content).
- Không random.
- Không phụ thuộc wall-clock (trừ timestamp metadata).

Tham chiếu: `INVARIANTS.md` → **CX-001..CX-006, SE-001, PR-001, PR-002**.

---

## 2. Context Model

### 2.1 ContextSnapshot

```typescript
interface ContextSnapshot {
  snapshotId: string;           // ULID
  sessionId: string;
  taskId?: string;
  taskRunId?: string;

  workspaceRevision: WorkspaceRevision;
  canonicalFormVersion: string;

  items: ContextItem[];

  tokenBudget: number;
  tokenUsed: number;

  builtBy: ContextBuilderKind;
  builtAt: string;

  buildReason: BuildReason;
  policyVersion: number;

  schemaVersion: number;
}

type ContextBuilderKind =
  | 'planner'
  | 'critic'
  | 'replanner'
  | 'executor'
  | 'analyzer'
  | 'verifier_assist';

type BuildReason =
  | 'initial_plan'
  | 'replan'
  | 'task_execution'
  | 'failure_analysis'
  | 'verification_assist'
  | 'user_request';
```

### 2.2 ContextItem

```typescript
interface ContextItem {
  itemId: string;               // ULID
  kind: ContextItemKind;

  source: ContextSource;

  content: string;
  tokenCount: number;

  trust: TrustLevel;
  reason: string;

  provenance: Provenance;

  priority: number;             // for eviction
  pinned: boolean;              // không bị evict

  truncated: boolean;
  truncationNote?: string;
}

type ContextItemKind =
  | 'file_snippet'
  | 'file_full'
  | 'symbol_definition'
  | 'symbol_usage'
  | 'diff_hunk'
  | 'test_result'
  | 'log_snippet'
  | 'task_definition'
  | 'acceptance_criteria'
  | 'constraint'
  | 'failure_evidence'
  | 'verification_report'
  | 'user_note'
  | 'memory'
  | 'plan_summary'
  | 'graph_summary'
  | 'policy_excerpt';

type TrustLevel = 'trusted' | 'untrusted';
```

### 2.3 ContextSource

```typescript
interface ContextSource {
  kind: SourceKind;

  path?: string;                // relative to workspace root
  range?: { start: number; end: number };

  revisionId?: string;          // workspace revision
  artifactId?: string;          // for logs, test results

  externalUrl?: string;         // for future

  symbolName?: string;          // for symbol items
}

type SourceKind =
  | 'workspace_file'
  | 'workspace_symbol'
  | 'artifact'
  | 'task'
  | 'goal'
  | 'policy'
  | 'memory'
  | 'graph'
  | 'session';
```

### 2.4 Local invariants

| ID | Statement |
|---|---|
| CX-L1 | `snapshotId` immutable. |
| CX-L2 | `items` không rỗng. |
| CX-L3 | `tokenUsed` ≤ `tokenBudget`. |
| CX-L4 | Mỗi item có `provenance`. |
| CX-L5 | Mỗi item có `trust` level rõ ràng. |
| CX-L6 | Snapshot bind với `workspaceRevision`. |
| CX-L7 | Snapshot không chứa secret chưa redact. |

Tham chiếu: `INVARIANTS.md` → **CX-001, CX-002, CX-003, CX-004, CX-006, PR-004**.

---

## 3. Context Pipeline

### 3.1 Pipeline overview

```
Task / Goal / Failure
        │
        ▼
   BuildPlan  ──────────  (deterministic)
        │
        ▼
   Retriever  ──────────  (candidate items)
        │
        ▼
   FileSelector  ───────  (choose files/symbols)
        │
        ▼
   Filter  ─────────────  (policy, trust, relevance)
        │
        ▼
   Compactor  ──────────  (summarize, dedupe)
        │
        ▼
   TokenBudgeter  ──────  (fit to budget)
        │
        ▼
   TrustMarker  ────────  (mark untrusted)
        │
        ▼
   ProvenanceTracker  ──  (record origin)
        │
        ▼
   ContextSnapshot
        │
        ▼
      ModelGateway
```

### 3.2 Determinism rule

- Retriever deterministic.
- FileSelector deterministic (rule-based, không LLM).
- Compactor có thể dùng LLM nhưng output phải pass validation và được mark trust.
- TokenBudgeter deterministic.
- TrustMarker deterministic.

### 3.3 LLM trong context

LLM **được phép**:

- summarize content (Compactor);
- rank relevance (nếu policy cho phép);
- extract symbols.

LLM **không được phép**:

- quyết định trust level;
- bỏ qua token budget;
- thêm item không có provenance;
- thay thế content gốc mà không đánh dấu.

Tham chiếu: `INVARIANTS.md` → **CX-005, SE-003**.

---

## 4. Retriever

### 4.1 Mục đích

Sinh candidate items từ các nguồn:

- workspace;
- task/goal;
- graph;
- failure evidence;
- verification report;
- memory (Phase 7).

### 4.2 Baseline (Phase 2)

Không có Tree-sitter. Retriever dùng:

| Source | Method |
|---|---|
| Task/goal | Direct inject |
| Graph | Direct inject summary |
| Failure evidence | Direct inject |
| Verification report | Direct inject |
| Workspace files | Diff-based (files changed trong taskRun) |
| Workspace files (khác) | Regex import scan (1 hop) |
| Test files | Path pattern match |

### 4.3 Full (Phase 6)

Khi có Tree-sitter + LSP:

- Symbol graph.
- Reverse dependency.
- Affected files.
- Test mapping.
- Semantic retrieval.

### 4.4 Retriever interface

```typescript
interface Retriever {
  retrieve(request: RetrieveRequest): Promise<ContextItem[]>;
}

interface RetrieveRequest {
  sessionId: string;
  taskId?: string;
  taskRunId?: string;

  workspaceRevision: WorkspaceRevision;
  buildReason: BuildReason;

  hints?: {
    paths?: string[];
    symbols?: string[];
    keywords?: string[];
  };

  limits: {
    maxItems: number;
    maxBytes: number;
  };
}
```

### 4.5 Determinism

- Cùng request → cùng candidate set (logical).
- Ordering theo (priority, path, range).
- Không random sampling.

Tham chiếu: `INVARIANTS.md` → **CX-002, CX-005**.

---

## 5. FileSelector

### 5.1 Mục đích

Chọn file/symbol nào sẽ đưa vào context từ candidate set.

### 5.2 Baseline rules (Phase 2)

| Rule | Priority |
|---|---|
| Task acceptance criteria | 100 (pinned) |
| Task description | 100 (pinned) |
| Goal description | 100 (pinned) |
| Constraint | 100 (pinned) |
| File directly changed in taskRun | 80 |
| Test file cho changed file | 70 |
| File import changed file (1 hop) | 60 |
| File import test file | 50 |
| File in same directory | 40 |
| Failure evidence | 90 |
| Verification report | 90 |
| Graph summary | 85 |

### 5.3 Selection rules

- Không chọn scratch zone files.
- Không chọn file > `maxFileBytes` (trừ khi pinned).
- Không chọn binary file.
- Không chọn file trong denylist (`.env`, secrets).
- Ưu tiên file nhỏ hơn khi cùng priority.

### 5.4 File size handling

| Size | Action |
|---|---|
| < 4 KB | Include full |
| 4–32 KB | Include full nếu pinned; snippet nếu không |
| 32–256 KB | Include snippet (head + tail + relevant ranges) |
| > 256 KB | Include metadata + snippet từ relevant ranges |

### 5.5 Snippet strategy

- Nếu có range hint → snippet quanh range.
- Nếu không → head + tail + symbol boundaries (nếu Phase 6).

### 5.6 Binary detection

- File có null byte trong 1 KB đầu → binary.
- Extension trong denylist (`.png`, `.jpg`, `.pdf`, `.zip`, ...) → binary.
- Binary → không include content, chỉ metadata.

Tham chiếu: `INVARIANTS.md` → **CX-002, CX-004**.

---

## 6. Filter

### 6.1 Mục đích

Loại bỏ item không nên vào context.

### 6.2 Filter rules

| Filter | Reason |
|---|---|
| Secret files (`.env*`, `*.pem`, `id_rsa`) | Security |
| Secret patterns trong content | Security |
| Scratch zone files | Không relevant |
| Binary files | Không useful |
| File > max size (không pinned) | Budget |
| Duplicate content | Dedup |
| File ngoài workspace root | Boundary |
| Symlink escape | Boundary |
| File có `.gitignore` match | Optional, policy |

### 6.3 Dedup

- Hai item cùng `(path, range)` → giữ item priority cao hơn.
- Hai item cùng content hash → giữ item có provenance đầy đủ hơn.

### 6.4 Secret redaction

- Scan content với Redactor patterns.
- Nếu match → redact hoặc drop item theo policy.
- Log event khi redact.

Tham chiếu: `INVARIANTS.md` → **SE-005, PR-004, WS-003, WS-004**.

---

## 7. Compactor

### 7.1 Mục đích

Giảm token count mà giữ information cần thiết.

### 7.2 Strategies

| Strategy | Khi nào |
|---|---|
| `none` | Item nhỏ, budget dư |
| `truncate_head_tail` | File lớn |
| `strip_comments` | Source code |
| `summarize_with_llm` | File lớn, budget tight (policy) |
| `extract_symbols` | Phase 6 |
| `diff_only` | Khi có before/after |

### 7.3 LLM summarization

Nếu policy cho phép:

- Dùng model nhỏ (ví dụ `qwen2.5-coder:1.5b`).
- Output phải pass validation.
- Summary được mark `trust` theo source gốc.
- Summary **không** thay thế content gốc — nó là item riêng với `kind: 'log_snippet'` hoặc note.
- Original item vẫn có thể include nếu budget cho phép.

### 7.4 Determinism

- LLM summarization không deterministic.
- Do đó: nếu dùng LLM → snapshot phải ghi rõ method.
- Cùng input có thể cho snapshot khác (về summary text), nhưng:
  - item set phải giống;
  - token count phải deterministic (hoặc bounded);
  - provenance phải giống.

### 7.5 Không được

- ❌ Silent drop content.
- ❌ Thay content gốc mà không đánh dấu.
- ❌ Thêm content không có trong source.
- ❌ Thay đổi code semantics.

Tham chiếu: `INVARIANTS.md` → **CX-002, CX-005**.

---

## 8. TokenBudgeter

### 8.1 Mục đích

Đảm bảo context fit trong token budget.

### 8.2 Budget structure

```typescript
interface ContextTokenBudget {
  total: number;                // model context window (reserve)
  reservedForOutput: number;    // token cho response
  reservedForSystem: number;    // system prompt
  availableForItems: number;    // còn lại cho items
}
```

### 8.3 Token counting

- Dùng tokenizer của model (nếu có).
- Fallback: heuristic (4 chars ≈ 1 token cho tiếng Anh; 2 chars ≈ 1 token cho tiếng Việt/CJK).
- Token count phải deterministic.

### 8.4 Fitting algorithm

```
1. Sort items by (pinned desc, priority desc).
2. Add pinned items (không tính budget — nếu vượt → fail rõ ràng).
3. Add non-pinned items cho tới khi hết budget.
4. Nếu item vượt budget còn lại:
   a. Nếu policy cho phép truncate → truncate.
   b. Nếu không → drop item.
5. Đảm bảo tokenUsed ≤ availableForItems.
```

### 8.5 Pinned overflow

Nếu pinned items vượt budget:

- Fail rõ ràng: `CONTEXT_BUDGET_EXCEEDED`.
- Không silent drop.
- Escalate hoặc replan.

### 8.6 Truncation

- Truncation phải đánh dấu `truncated: true`.
- Note lý do.
- Provenance ghi original size.

### 8.7 Không được

- ❌ Silent truncate.
- ❌ Vượt budget.
- ❌ Drop pinned item.
- ❌ Count token không deterministic.

Tham chiếu: `INVARIANTS.md` → **CX-004**.

---

## 9. Trust Boundary

### 9.1 Trust levels

| Source | Trust |
|---|---|
| System prompt | trusted |
| Policy excerpt | trusted |
| Task description | trusted |
| Acceptance criteria | trusted |
| Constraint | trusted |
| User note | trusted (constrained) |
| Workspace file | **untrusted** |
| Test result | **untrusted** |
| Log snippet | **untrusted** |
| Failure evidence | **untrusted** |
| Verification report | **untrusted** (data, không phải authority) |
| Memory | **untrusted** (Phase 7) |

### 9.2 Marking

Mọi item untrusted phải:

- có `trust: 'untrusted'`;
- được render trong prompt với delimiter rõ ràng;
- không được interpret như instruction.

### 9.3 Prompt rendering

```
[SYSTEM]
<system prompt>

[TRUSTED CONTEXT]
<task description>
<acceptance criteria>

[UNTRUSTED CONTEXT]
<untrusted source="workspace/README.md">
...
</untrusted>

<untrusted source="test_result" artifact="...">
...
</untrusted>
```

### 9.4 Enforcement

- TrustMarker là bước bắt buộc trong pipeline.
- Không có item nào vào prompt mà không qua TrustMarker.
- Model output không được coi là trusted dù nó tự khai.

### 9.5 Prompt injection boundary

- Workspace content là data.
- System prompt là instruction.
- Policy là authority.
- Không được mix.

Tham chiếu: `INVARIANTS.md` → **SE-001, SE-002, CX-003**.

---

## 10. Provenance Tracking

### 10.1 Provenance record cho mỗi item

```typescript
interface ContextProvenance {
  provenanceId: string;
  snapshotId: string;
  itemId: string;

  source: ContextSource;
  retrievedBy: 'retriever' | 'file_selector' | 'compactor' | 'user';

  reason: string;
  at: string;

  originalTokenCount?: number;
  finalTokenCount: number;
  truncated: boolean;
  compactionMethod?: string;
}
```

### 10.2 Append-only

- Provenance append-only.
- Không sửa.
- Không xóa.

### 10.3 Query

- Item nào dùng file nào?
- Snapshot nào dùng revision nào?
- Model output nào dựa trên context nào?

### 10.4 Chain of provenance

```
Model output
   │
   ▼
ContextSnapshot
   │
   ▼
ContextItem
   │
   ▼
Source (file, range, revision)
   │
   ▼
WorkspaceRevision
   │
   ▼
Workspace hash
```

Đây là chain audit từ model output → workspace evidence.

Tham chiếu: `INVARIANTS.md` → **PR-001, PR-002, PR-003, CX-002**.

---

## 11. Snapshot Versioning

### 11.1 Snapshot là immutable

- Sau khi commit, snapshot không đổi.
- Không update items.
- Không update token count.

### 11.2 Snapshot binding

- Snapshot bind với `workspaceRevision`.
- Snapshot bind với `taskRunId` (nếu có).
- Snapshot bind với `policyVersion`.

### 11.3 Snapshot reuse

- Snapshot có thể reuse nếu:
  - cùng `workspaceRevision`;
  - cùng `buildReason`;
  - cùng `policyVersion`;
  - cùng hints.
- Nếu khác → build mới.

### 11.4 Snapshot invalidation

- Revision thay đổi → snapshot stale.
- Policy thay đổi → snapshot stale (nếu policy ảnh hưởng selection).
- Task thay đổi → snapshot stale.

Tham chiếu: `INVARIANTS.md` → **CX-001, CX-006, VR-011**.

---

## 12. Persistence Schema

### 12.1 Tables

```sql
CREATE TABLE context_snapshots (
  snapshot_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  task_id TEXT,
  task_run_id TEXT,

  workspace_revision_id TEXT NOT NULL,
  canonical_form_version TEXT NOT NULL,

  token_budget INTEGER NOT NULL,
  token_used INTEGER NOT NULL,

  built_by TEXT NOT NULL,
  build_reason TEXT NOT NULL,
  policy_version INTEGER NOT NULL,

  built_at TEXT NOT NULL,
  schema_version INTEGER NOT NULL
);

CREATE TABLE context_items (
  item_id TEXT PRIMARY KEY,
  snapshot_id TEXT NOT NULL,
  kind TEXT NOT NULL,

  source_kind TEXT NOT NULL,
  source_path TEXT,
  source_range_start INTEGER,
  source_range_end INTEGER,
  source_revision_id TEXT,
  source_artifact_id TEXT,
  source_symbol_name TEXT,

  content TEXT NOT NULL,
  token_count INTEGER NOT NULL,

  trust TEXT NOT NULL,
  reason TEXT NOT NULL,

  priority INTEGER NOT NULL,
  pinned INTEGER NOT NULL,
  truncated INTEGER NOT NULL,
  truncation_note TEXT,

  FOREIGN KEY (snapshot_id) REFERENCES context_snapshots(snapshot_id)
);

CREATE TABLE context_provenance (
  provenance_id TEXT PRIMARY KEY,
  snapshot_id TEXT NOT NULL,
  item_id TEXT NOT NULL,

  retrieved_by TEXT NOT NULL,
  reason TEXT NOT NULL,
  at TEXT NOT NULL,

  original_token_count INTEGER,
  final_token_count INTEGER NOT NULL,
  truncated INTEGER NOT NULL,
  compaction_method TEXT,

  FOREIGN KEY (snapshot_id) REFERENCES context_snapshots(snapshot_id),
  FOREIGN KEY (item_id) REFERENCES context_items(item_id)
);

CREATE INDEX idx_ctx_snap_session ON context_snapshots(session_id);
CREATE INDEX idx_ctx_snap_task ON context_snapshots(task_id);
CREATE INDEX idx_ctx_snap_revision ON context_snapshots(workspace_revision_id);
CREATE INDEX idx_ctx_items_snapshot ON context_items(snapshot_id);
CREATE INDEX idx_ctx_prov_snapshot ON context_provenance(snapshot_id);
CREATE INDEX idx_ctx_prov_item ON context_provenance(item_id);
```

### 12.2 Append-only

- `context_snapshots` insert only.
- `context_items` insert only.
- `context_provenance` insert only.

### 12.3 Retention

- Snapshots giữ theo policy (default: full session).
- Artifact content (nếu lớn) lưu ở ArtifactStore, không trong DB.

Tham chiếu: `INVARIANTS.md` → **PR-003, CP-001**.

---

## 13. Context API

### 13.1 Interface

```typescript
interface ContextBuilder {
  build(request: BuildContextRequest): Promise<ContextSnapshot>;

  getSnapshot(snapshotId: string): Promise<ContextSnapshot | null>;
  listSnapshots(sessionId: string): Promise<ContextSnapshot[]>;

  invalidate(snapshotId: string, reason: string): Promise<void>;
}

interface BuildContextRequest {
  sessionId: string;
  taskId?: string;
  taskRunId?: string;

  workspaceRevision: WorkspaceRevision;
  buildReason: BuildReason;

  hints?: RetrieveHints;

  policy: ContextPolicy;
}
```

### 13.2 ContextPolicy

```typescript
interface ContextPolicy {
  policyId: string;
  version: number;

  tokenBudget: ContextTokenBudget;

  maxItems: number;
  maxBytes: number;

  maxFileBytes: number;
  snippetHeadLines: number;
  snippetTailLines: number;

  allowLLMSummarize: boolean;
  summarizeModel: string;

  denylistPatterns: string[];
  redactionRules: RedactionRule[];

  includeGitHistory: boolean;
  includeTestResults: boolean;
}
```

### 13.3 Error codes

| Code | Khi nào |
|---|---|
| `CONTEXT_BUDGET_EXCEEDED` | Pinned items vượt budget |
| `CONTEXT_SOURCE_MISSING` | File/artifact không tồn tại |
| `CONTEXT_REVISION_STALE` | Revision không khớp |
| `CONTEXT_PROVENANCE_MISSING` | Item không có provenance |
| `CONTEXT_TRUST_UNMARKED` | Item không có trust level |

---

## 14. Integration với ModelGateway

### 14.1 Request

```typescript
interface ModelRequest {
  purpose: ModelPurpose;

  contextSnapshotId: string;

  systemPrompt: string;
  taskPrompt: string;

  responseSchema: JSONSchema;

  maxOutputTokens: number;
  temperature: number;

  provenance: Provenance;
}

type ModelPurpose =
  | 'plan'
  | 'critique'
  | 'replan'
  | 'execute'
  | 'analyze_failure'
  | 'summarize';
```

### 14.2 Prompt construction

- System prompt từ T0/T2.
- Task prompt từ T1.
- Untrusted content delimited.
- Snapshot id ghi vào provenance.
- Không nhúng raw workspace content vào system prompt.

### 14.3 Response

- Structured output validation.
- Model identity ghi vào provenance.
- Response không tự động trở thành action.

Tham chiếu: `INVARIANTS.md` → **MG-001..MG-006, SE-010**.

---

## 15. Invariant Mapping

| Invariant | Enforcement |
|---|---|
| CX-001 | §11 snapshot immutable + versioned |
| CX-002 | §2.4 CX-L4 + §10 provenance |
| CX-003 | §9 trust marking |
| CX-004 | §8 token budget |
| CX-005 | §1.1 context không authority |
| CX-006 | §2.1 workspaceRevision binding |
| SE-001 | §9 untrusted marking |
| SE-002 | §9.5 prompt injection boundary |
| SE-003 | §3.3 LLM constraints |
| SE-005 | §6.4 redaction |
| PR-001 | §10 provenance per item |
| PR-002 | §10.4 chain |
| PR-003 | §12.2 append-only |
| PR-004 | §6.4 + §12 no secret |
| MG-001 | §14 all calls via gateway |
| MG-002 | §14.3 structured validation |
| VR-001 | §2.1 revision binding |
| VR-011 | §11.4 staleness |

---

## 16. Test Matrix

### 16.1 Snapshot tests

| Test | Target |
|---|---|
| `snapshot-immutable` | no update after commit |
| `snapshot-binding-revision` | revision recorded |
| `snapshot-binding-policy` | policy version recorded |
| `snapshot-reuse-same-input` | reuse or rebuild |
| `snapshot-stale-on-revision-change` | stale detected |

### 16.2 Retriever tests

| Test | Target |
|---|---|
| `retrieve-direct-diff` | diff-based files |
| `retrieve-import-hop` | 1-hop import |
| `retrieve-test-files` | test file match |
| `retrieve-deterministic` | same input same set |
| `retrieve-excludes-scratch` | scratch excluded |

### 16.3 FileSelector tests

| Test | Target |
|---|---|
| `select-priority-order` | priority respected |
| `select-pinned-always` | pinned included |
| `select-max-size` | large files skipped |
| `select-binary-skip` | binary skipped |
| `select-snippet-large-file` | snippet used |

### 16.4 Filter tests

| Test | Target |
|---|---|
| `filter-secret-file` | dropped |
| `filter-secret-content` | redacted |
| `filter-dedup` | duplicates removed |
| `filter-outside-root` | dropped |
| `filter-symlink-escape` | dropped |

### 16.5 Compactor tests

| Test | Target |
|---|---|
| `compact-none-small` | unchanged |
| `compact-truncate-head-tail` | truncation marked |
| `compact-llm-summarize` | summary marked |
| `compact-no-silent-drop` | content preserved hoặc marked |

### 16.6 TokenBudgeter tests

| Test | Target |
|---|---|
| `budget-within-limit` | tokenUsed ≤ budget |
| `budget-pinned-overflow` | fail rõ ràng |
| `budget-truncate-non-pinned` | truncation marked |
| `budget-deterministic` | same count |

### 16.7 Trust tests

| Test | Target |
|---|---|
| `trust-workspace-untrusted` | marked |
| `trust-task-trusted` | marked |
| `trust-no-unmarked` | all items marked |
| `trust-prompt-delimiter` | rendered correctly |

### 16.8 Provenance tests

| Test | Target |
|---|---|
| `provenance-per-item` | each item has record |
| `provenance-append-only` | no update |
| `provenance-chain` | model → context → revision |
| `provenance-no-secret` | redacted |

### 16.9 Persistence tests

| Test | Target |
|---|---|
| `persist-snapshot` | stored |
| `persist-items` | stored |
| `persist-provenance` | stored |
| `query-by-session` | works |
| `query-by-revision` | works |

### 16.10 Integration tests

| Test | Target |
|---|---|
| `model-receives-context` | snapshot id passed |
| `model-provenance-linked` | chain intact |
| `context-stale-blocked` | model not called with stale |

---

## 17. Adversarial Tests

| Adversary | Attempt | Expected |
|---|---|---|
| PromptInjectionContent | README có "IGNORE" | marked untrusted |
| PromptInjectionContent | Code comment có instruction | marked untrusted |
| SecretExposure | `.env` trong context | redacted |
| SecretExposure | `.pem` file | dropped |
| BudgetAttack | Huge file | skipped/snippet |
| ProvenanceForge | Item without source | reject |
| TrustForge | Untrusted marked trusted | reject |
| RevisionMismatch | Stale revision | reject |
| DeduplicationBypass | Duplicate content | dedup |

---

## 18. Open Questions (Phase 0)

1. **Token counting**: dùng tokenizer của model nào?
2. **Summarization model**: có dùng model khác không?
3. **Snapshot retention**: giữ bao lâu?
4. **Memory integration**: Phase 7 sẽ thêm gì?
5. **Semantic retrieval**: Phase 6 sẽ dùng embedding không?
6. **Multi-language**: làm sao detect language?
7. **Git history**: có include vào context không?

---

## 19. North Star

> **Context is evidence with provenance. Trust is marked. Budget is hard. Snapshot is immutable.**

Mọi snapshot, mọi item, mọi provenance record tồn tại để trả lời:

- **Model nhìn thấy gì**?
- **Nó đến từ đâu**?
- **Nó có trusted không**?
- **Nó fit trong budget không**?
- **Nó bind với revision nào**?

Và câu hỏi cuối cùng:

> **LLM không được thông minh bằng cách nhồi prompt. LLM được hỗ trợ bằng context tốt, có provenance, có trust, có budget.**

---
