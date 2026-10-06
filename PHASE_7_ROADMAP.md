# PHASE_7_ROADMAP.md

**Ollama Coding Agent — Kế hoạch Phase 7 (Memory / RAG)**

Version: 1.0
Status: Working plan
Owner: Intelligence Plane / Memory Layer
Scope: Long-term memory (project / preferences / outcomes / failure patterns) +
       retrieval-augmented generation (docs / repository) feeding the context
       Retriever as **untrusted evidence** — never runtime authority.
Related:
`PHASE_6_SIGNOFF.md`, `Coding Agent Architecture Target §57`,
`EVALUATION_MODEL §11.9`, `CONTEXT_SPEC §4/§9`, `INFRASTRUCTURE_SPEC §3`,
`DOMAIN_CONTRACTS §14`, `MIGRATION_SPEC.md`

---

## 0. Nguyên tắc Phase 7

> **Phase 6 làm agent hiểu code. Phase 7 làm agent nhớ — nhưng trí nhớ chỉ là
> bằng chứng, không bao giờ là quyền lực.**

Bốn luật:

1. **Memory là evidence, không phải authority** (Architecture Target §57, CX-005).
   Memory/RAG chỉ bơm context cho model. Quyết định runtime vẫn do kernel
   deterministic (Policy / ToolGateway / Verification / WorkspaceRevision). Không
   một bản ghi memory nào được tự động thay đổi hành vi runtime.
2. **Memory là untrusted** (CX-003). Mọi item memory/RAG mang `trust: 'untrusted'`,
   wrap trong delimiter untrusted, giống nội dung workspace. Nội dung từ repo/docs
   bên ngoài là dữ liệu không tin cậy, không phải chỉ thị.
3. **Determinism trước, embedding sau.** Lớp lõi Phase 7 dùng retrieval **tất định**
   (keyword / symbol / structural / recency) để giữ VR-010-style reproducibility và
   cross-platform. Semantic embedding là **optional/deferred** (xem §7, §8) vì kéo
   theo mô hình embedding + vector store, khó đảm bảo xác định và headless-CI.
4. **Write-path có provenance + bounded.** Mọi ghi memory tạo một bản ghi có
   provenance + reason + timestamp (PR-002/PR-003 spirit), append-only, có retention
   bound. Memory không phình vô hạn.

North Star: *Khi agent gặp một task giống task đã làm, nó truy xuất được outcome và
failure pattern liên quan như context untrusted, và khi cần tài liệu/API ngoài, nó
truy xuất doc/repo như context untrusted — tất cả không bao giờ ghi đè quyết định của
kernel.*

---

## 1. Con số Phase 7

Hiện tại `invariants.yaml` **chưa có** invariant nào cho phase 7 (grep `phase: 7`
= 0, chưa có `MEM-*`). Phase 7 cần **thêm mới** một nhóm invariant Memory và khai báo
vào `invariants.yaml` như một task đầu phase (P7-INV).

Nhóm invariant đề xuất (ID chốt lại khi thêm vào `invariants.yaml`):

| ID (đề xuất) | Statement | Severity |
|---|---|---|
| MEM-001 | Memory item không bao giờ là runtime authority — chỉ là context evidence. | CRITICAL |
| MEM-002 | Mọi memory item mang `trust: 'untrusted'` trong ContextSnapshot. | CRITICAL |
| MEM-003 | Mọi memory write có provenance + reason + timestamp; append-only. | CRITICAL |
| MEM-004 | Memory retrieval deterministic trên cùng (query, store state). | HIGH |
| MEM-005 | RAG content ngoài (docs/repo) được đánh dấu untrusted + ghi nguồn. | CRITICAL |
| MEM-006 | Memory store có retention bound; không ghi không giới hạn. | HIGH |
| MEM-007 | Memory/RAG không bao giờ bypass Policy/ToolGateway để lấy dữ liệu. | CRITICAL |

Các invariant đã có được Phase 7 làm giàu (không thêm mới):
- **CX-002** (provenance mọi context item) — memory item cũng phải có.
- **CX-003** (untrusted marking) — memory/RAG đánh dấu untrusted.
- **CX-005** (context không phải authority) — nền tảng của MEM-001.
- **RC-003** (NoProgressDetector deterministic) — tín hiệu `relevantFilesChanged`
  (deferred từ Phase 6) được nối ở đây.

---

## 2. Scope Phase 7

### 2.1 In-scope

| Component | Mục tiêu | Enforces |
|---|---|---|
| `MemoryStore` | Lưu/truy vấn memory records (SQLite, schema mới) | MEM-003, MEM-006 |
| `MemoryWriter` | Ghi outcome/failure-pattern/note có provenance, bounded | MEM-003, MEM-006 |
| `MemoryRetriever` | Truy xuất memory tất định (keyword/symbol/recency) | MEM-002, MEM-004 |
| `DocRetriever` (RAG) | Truy xuất tài liệu cục bộ (project docs) làm context | MEM-005 |
| `RepoRetriever` (RAG) | Truy xuất đoạn repo liên quan (dùng Code Intelligence P6) | MEM-005 |
| `Retriever` wiring | Bơm memory + RAG items vào ContextSnapshot (nối CR1) | CX-002, CX-003 |
| `NoProgressDetector` upgrade | Nối tín hiệu `relevantFilesChanged` (deferred P6) | RC-003 |
| P6-LX1 `LspAdapter` | Deferred từ Phase 6 — thực hiện ở đây (optional, CI-safe) | — |
| P7-INV | Thêm nhóm MEM-* vào `invariants.yaml` + test invariant | MEM-* |
| P7-I1 Integration E2E | Task lặp lại → truy xuất outcome/failure + RAG doc như untrusted | tất cả Phase-7 |

### 2.2 Out-of-scope (Phase 7)

- Semantic embedding / vector store (optional — xem §8; cân nhắc Phase 7.5).
- Fine-tuning / self-improvement (Phase 8+).
- Multi-agent shared memory (Phase 8+).
- Network fetch tới GitHub/web ngoài **nếu** vi phạm NetworkPolicy — chỉ làm khi
  đi qua ToolGateway + Policy (MEM-007); RAG v1 ưu tiên nguồn cục bộ.
- Cloud memory / remote sync (Phase 8+).

---

## 3. Kiến trúc những gì đã có

### 3.1 Đã có — dùng ngay

| Thứ | Location | Status |
|---|---|---|
| `ContextItemKind: 'memory'` | `agent-core/src/domain/context.ts` | ✅ domain sẵn |
| `ContextSourceKind: 'memory'` | `agent-core/src/domain/context.ts` | ✅ domain sẵn |
| `assignTrust('memory') → untrusted` | `agent-core/src/context/trust-marker.ts` | ✅ CX-003 |
| `Retriever` + `RetrievedSymbol` + import graph plumbing | `agent-core/src/context/retriever.ts` | ✅ Phase 6 (CR1) |
| SQLite + migration engine | `infrastructure/src/sqlite/*` | ✅ Phase 1 |
| `ProvenanceTracker` | `agent-core/src/context/provenance-tracker.ts` | ✅ Phase 2 |
| Code Intelligence (TS1/SX1/IG1/AS1/CR1) | `infrastructure` + `agent-core` | ✅ Phase 6 |
| `NoProgressDetector` | `agent-core/src/recovery/*` | ✅ Phase 5 (chờ tín hiệu P6) |

### 3.2 Cần tạo mới (Phase 7)

| Component | Package | Phần cốt lõi |
|---|---|---|
| `MemoryStore` + schema v(next) | infrastructure | SQLite table(s) + repository |
| `MemoryWriter` | agent-core (logic) + infra (persist) | ghi record bounded + provenance |
| `MemoryRetriever` | agent-core | truy xuất tất định, trả plain data |
| `DocRetriever` / `RepoRetriever` | infrastructure | nguồn RAG cục bộ |
| Retriever memory/RAG wiring | agent-core | thêm field request (plain data) |
| `LspAdapter` (P6-LX1) | infrastructure | TypeScript LSP, CI-safe skip |
| MEM-* invariants | invariants.yaml + tests | nhóm invariant mới |

Nguyên tắc decoupling (giữ như Phase 6): `agent-core` **không** phụ thuộc
`infrastructure`. `MemoryRetriever` nhận records dưới dạng dữ liệu thuần; caller
chạy `MemoryStore`/RAG rồi feed vào — y hệt cách CR1 nhận symbols/graph.

---

## 4. Component breakdown

### 4.1 P7-INV — Memory invariants

Thêm nhóm MEM-001..007 (§1) vào `invariants.yaml` với `phase: 7`, kèm test
`tests/invariants/memory/*.spec.ts`. Làm **đầu tiên** để các component sau có
ràng buộc rõ ràng (đúng thứ tự Architecture Target §59: Invariants trước code).

### 4.2 P7-MS1 — MemoryStore

```
infrastructure/src/memory/
  memory-store.ts        ← CRUD + query (SQLite)
  schema (migration)     ← bảng memory_records
```

```typescript
interface MemoryRecord {
  memoryId:   string;      // ULID
  kind:       'task_outcome' | 'failure_pattern' | 'project_note' | 'user_preference'
            | 'architecture_note';
  scope:      'project' | 'session' | 'global';
  content:    string;
  tags:       readonly string[];
  provenance: Provenance;  // reason + at + source
  createdAt:  string;
  // retention: TTL hoặc max-count enforced bởi MemoryWriter (MEM-006)
}
```

### 4.3 P7-MW1 — MemoryWriter

Ghi record có provenance, enforce retention bound (MEM-003/006). Nguồn ghi:
TaskRun outcome (SUCCEEDED/FAILED), FailureClassifier output (failure pattern),
user note. Append-only; không sửa record cũ.

### 4.4 P7-MR1 — MemoryRetriever

```typescript
interface MemoryRetriever {
  retrieve(query: {
    tags?: readonly string[];
    kinds?: readonly MemoryRecord['kind'][];
    limit: number;
  }, records: readonly MemoryRecord[]): readonly MemoryRecord[];
}
```

Tất định (MEM-004): xếp hạng theo (tag match desc, recency desc, id asc). Trả plain
data để `Retriever` map thành ContextItem `kind: 'memory'`, `trust: 'untrusted'`.

### 4.5 P7-RAG1 — DocRetriever / RepoRetriever

- `DocRetriever`: index tài liệu cục bộ (`*.md` trong workspace) → trả đoạn liên quan.
- `RepoRetriever`: dùng Code Intelligence (SX1/IG1) để trả đoạn code liên quan theo
  symbol/import distance (tái dùng CR1 ranking).
- Cả hai đánh dấu untrusted + ghi nguồn (MEM-005). RAG v1 ưu tiên nguồn **cục bộ**;
  fetch mạng (nếu có) phải qua ToolGateway + NetworkPolicy (MEM-007).

### 4.6 P7-CR2 — Retriever memory/RAG wiring

Mở rộng `RetrieveRequest` + `BuildContextRequest` (như CR1): thêm
`memoryRecords?` và `ragItems?` (plain data). Bơm thành ContextItem untrusted,
priority dưới task/goal/graph/changed-files, có provenance (CX-002).

### 4.7 P7-LX1 — LspAdapter (deferred từ Phase 6)

Theo definition-of-done đã ghi trong `PHASE_6_SIGNOFF.md`:
`start/stop/definition/references/symbols` qua LSP stdio (TypeScript trước),
reuse session, CI-safe skip khi không có binary. Feed cùng interface retriever —
không sửa CR1.

### 4.8 P7-NPD2 — NoProgressDetector `relevantFilesChanged` (deferred từ Phase 6)

Nối import graph (IG1) vào NoProgressDetector: nếu các lần thử liên tiếp không làm
thay đổi tập file liên quan (affected set), đó là tín hiệu no-progress bổ sung
(RC-003 — tín hiệu optional, deterministic, unknown-safe).

### 4.9 P7-I1 — Integration E2E

```
tests/integration/memory-rag-e2e.spec.ts
```

Scenarios:
1. Ghi task outcome + failure pattern → truy xuất lại ở task tương tự (untrusted).
2. DocRetriever trả đoạn doc cục bộ liên quan → vào ContextSnapshot untrusted.
3. RepoRetriever trả đoạn code liên quan theo symbol/import distance.
4. Memory item không bao giờ xuất hiện như authority (MEM-001) — chỉ là context data.

---

## 5. Timeline (4-5 tuần)

```
Tuần 1 — Invariants + Store
  P7-INV   MEM-* vào invariants.yaml + test                      [1 ngày]
  P7-MS1   MemoryStore + schema migration                        [2 ngày]
  P7-MW1   MemoryWriter (bounded + provenance)                   [2 ngày]

Tuần 2 — Retrieval
  P7-MR1   MemoryRetriever (deterministic)                       [2 ngày]
  P7-CR2   Retriever memory wiring                               [2 ngày]
  —        Tests                                                 [1 ngày]

Tuần 3 — RAG
  P7-RAG1  DocRetriever + RepoRetriever (local)                  [3 ngày]
  —        Tests + ranking reuse từ CR1                          [2 ngày]

Tuần 4 — Deferred P6 + Integration
  P7-LX1   LspAdapter (optional, CI-safe)                        [2 ngày]
  P7-NPD2  relevantFilesChanged signal                          [1 ngày]
  P7-I1    Integration E2E                                       [2 ngày]

Tuần 5 — Sign-off + buffer
  —        PHASE_7_SIGNOFF.md                                    [1 ngày]
  —        Buffer                                                [phần còn lại]
```

---

## 6. Exit criteria Phase 7

Map theo `EVALUATION_MODEL §11.9` (Phase 7 gate) + nguyên tắc §0.

1. MEM-001..007 khai báo trong `invariants.yaml` + test `tests/invariants/memory/`.
2. **MEM-001**: không có đường nào để memory trở thành runtime authority (test chứng minh).
3. **MEM-002/CX-003**: mọi memory item untrusted trong ContextSnapshot.
4. **MEM-003**: mọi memory write có provenance + append-only.
5. **MEM-004**: MemoryRetriever deterministic (same query+store → same result).
6. **MEM-005**: RAG content untrusted + ghi nguồn.
7. **MEM-006**: retention bound enforced (test ghi quá hạn → bị cắt).
8. **MEM-007**: memory/RAG không bypass Policy/ToolGateway (depcruise + test).
9. RAG integration E2E pass (`tests/integration/memory/` — P7-I1).
10. P7-LX1 LspAdapter: hoặc hoàn thành (CI-safe), hoặc nếu vẫn bất khả thi headless
    thì ghi tiếp Deferred với lý do cập nhật (không âm thầm bỏ).
11. P7-NPD2 `relevantFilesChanged` nối vào NoProgressDetector (RC-003, optional).
12. Không TypeScript error / ESLint error / dependency-cruiser violation.
13. `agent-core` vẫn không phụ thuộc `infrastructure` (depcruise).
14. CI green trên 2 OS (Windows + WSL Ubuntu).
15. `PHASE_7_SIGNOFF.md` được tạo.

---

## 7. Rủi ro

| Rủi ro | Xác suất | Tác động | Mitigation |
|---|---|---|---|
| Memory biến thành authority (vi phạm MEM-001) | Thấp | Cao | Thiết kế read-only vào context; test adversarial MEM-001 |
| Embedding kéo phụ thuộc nặng + phi xác định | Cao | Trung bình | Lõi dùng retrieval tất định; embedding deferred (§8) |
| RAG fetch mạng vi phạm NetworkPolicy | Trung bình | Cao | RAG v1 chỉ nguồn cục bộ; fetch mạng phải qua ToolGateway (MEM-007) |
| Memory phình vô hạn | Trung bình | Trung bình | Retention bound (MEM-006) enforced ở MemoryWriter |
| LSP startup headless/CI (lặp lại rủi ro P6) | Cao | Trung bình | CI-safe skip; vẫn optional, có thể deferred tiếp |
| `agent-core` lỡ phụ thuộc infra | Thấp | Cao | Giữ pattern plain-data như CR1; depcruise canh |

---

## 8. Những gì Phase 7 KHÔNG làm (và vì sao)

- **Semantic embedding / vector store** — deferred (cân nhắc Phase 7.5). Lý do:
  mô hình embedding + vector index khó đảm bảo determinism (MEM-004) và headless-CI
  cross-platform; lõi tất định đủ cho v1. Khi làm, nó cắm vào **cùng interface
  MemoryRetriever** (plain data) nên không phải sửa P7-CR2.
- **Self-improvement / fine-tuning** — Phase 8+.
- **Multi-agent shared memory** — Phase 8+.
- **Cloud / remote memory sync** — Phase 8+.
- **Network RAG (GitHub/web)** như mặc định — chỉ qua ToolGateway + NetworkPolicy.

---

## Phụ lục A — Quyết định cần chốt trước khi code

1. **Embedding v1 hay deferred?** Khuyến nghị: deferred (lõi tất định trước).
2. **Schema memory**: một bảng `memory_records` đa-kind, hay tách bảng theo kind?
   Khuyến nghị: một bảng + cột `kind` (đơn giản, migration nhẹ).
3. **Retention policy mặc định**: theo max-count per scope hay theo TTL? Khuyến nghị:
   max-count per (scope, kind) cho v1 (dễ test tất định hơn TTL theo wall-clock).
4. **LX1 làm trong Phase 7 hay deferred tiếp?** Quyết định sau khi thử CI-safe skip.
