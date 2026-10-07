# PHASE_11_ROADMAP.md

**Ollama Coding Agent — Kế hoạch Phase 11 (Intelligence Plane / Self-Model / Learning)**

Version: 1.0
Status: Working plan (draft for review)
Owner: Intelligence Plane / Learning Layer
Scope: Một lớp **self-model + learning** quan sát lịch sử chạy (EventLog, failures,
       recoveries, verification outcomes, metrics, memory) và sinh ra **đề xuất advisory**
       (gợi ý recovery, re-rank context, cảnh báo no-progress sớm, điều chỉnh prompt/scope)
       — **không bao giờ** là authority. Kernel deterministic vẫn quyết định mọi thứ.
Related:
`PHASE_10_SIGNOFF.md`, `PHASE_7_ROADMAP.md` (Memory/RAG + `ME-*`),
`Coding Agent Architecture Target §4` (Intelligence Plane), `§57` (Memory), `§58`
(self-improvement), `EVALUATION_MODEL §10/§11`, `INVARIANTS.md` (`CX-005`, `MG-006`,
`SM-006`, `RC-*`, `ME-*`, `TI-007`, `SC-*`), `invariants.yaml`, `invariants.schema.json`

---

## 0. Nguyên tắc Phase 11

> **Phase 7 cho agent trí nhớ. Phase 11 cho agent khả năng tự quan sát và học từ
> lịch sử của chính mình — nhưng việc học chỉ tạo ra đề xuất, không bao giờ tạo ra
> quyền quyết định.**

Đây là lời hứa cốt lõi của toàn dự án đặt vào thử thách lớn nhất: *«LLM proposes.
Deterministic runtime decides and enforces.»* Một lớp learning dễ dàng trở thành cửa
sau phá vỡ nguyên tắc đó, nếu nó được phép tự thay đổi hành vi runtime. Phase 11 phải
chứng minh rằng ta có thể thêm trí thông minh thích nghi **mà không** nhượng bộ bất kỳ
quyền quyết định nào.

Năm luật của Phase 11:

1. **Learning là advisory, không phải authority** (mở rộng `CX-005`, `MG-006`,
   `TI-007`). Bất kỳ output nào của lớp learning — gợi ý recovery, điểm re-rank, cảnh báo —
   chỉ là *input có trọng số* cho một quyết định deterministic đã tồn tại (RecoveryPolicy,
   Retriever ranking, NoProgressPolicy). Không một bản ghi learning nào được tự động thực
   thi một action, chuyển một state, mutate graph, hay bỏ qua một check.

2. **Self-model là projection chỉ-đọc, tất định, tái lập được** (tinh thần `OB-*`,
   `EVALUATION_MODEL §1.5`). SelfModel được tính như một **total function** của EventLog
   (đã redact) + metrics đã có. Cùng input → cùng self-model. Nó không giữ state đáng tin
   độc lập với EventLog; nếu xoá nó, nó tái dựng lại được từ event history.

3. **Mọi đề xuất learning phải đi qua một "advice gate" deterministic.** Giống
   `ToolGateway`/`CompletionGate`, không component nào được tiêu thụ trực tiếp output
   learning. Một `AdviceGate` nhận đề xuất, kẹp nó vào biên deterministic (clamp, allowlist,
   bound), ghi provenance, rồi mới trả về cho policy. Policy luôn có quyền phủ quyết và luôn
   có một **default an toàn khi không có advice** (fail-safe = hành vi Phase 10 hiện tại).

4. **Determinism của runtime không được phụ thuộc vào learning.** Tắt toàn bộ lớp learning
   (feature flag off) → runtime hành xử **y hệt** Phase 10. Learning chỉ có thể thay đổi
   *thứ tự thử* trong một allowed-set đã có, *điểm xếp hạng* trong một ranking đã tất định,
   hay *thời điểm cảnh báo* — không bao giờ mở rộng tập action hợp lệ, không bao giờ nới
   budget, không bao giờ tạo quyền mới. Cơ chế "flag off" không cần phát minh mới: nó dùng
   đúng **mẫu optional-dependency** đã phổ biến trong kernel — `TaskExecutor` đã fallback an
   toàn khi `contextProvider` / `loopControl` / `idempotencyEngine` / `approvalCoordinator`
   / `completionGate` không được wire (`if (this.deps.X !== undefined)`). AdviceGate + các
   advisor là optional deps y hệt; không wire = Phase 10.

5. **Learning store có provenance + bounded + append-only** (kế thừa `ME-003`, `ME-006`).
   Mỗi "lesson" học được là một bản ghi có nguồn (những session/run nào sinh ra nó), lý do,
   timestamp, và nằm trong retention bound. Learning không phình vô hạn và luôn truy nguyên
   được về evidence gốc.

North Star: *Agent gặp một failure giống một failure đã gặp 20 lần trước; lớp learning
đề xuất "class này, trong repo này, FIX hầu như luôn thất bại — thử REPLAN sớm hơn" như
một gợi ý có trọng số; RecoveryPolicy vẫn là bên quyết định, vẫn trong allowed-set, vẫn
bounded, và nếu lớp learning bị tắt thì agent lui về đúng ma trận tĩnh Phase 5.*

---

## 1. Con số Phase 11

Phase 11 **thêm mới** một nhóm invariant Learning và khai báo vào `invariants.yaml`
(bump version registry). Theo ràng buộc `invariants.schema.json`
(`id: ^[A-Z]{2}-[0-9]{3}$`, test: `tests/invariants/<domain>/<xx>-NNN.spec.ts`), prefix
domain phải đúng **2 chữ cái**. Chọn **`LE`** (Learning / Intelligence Plane); domain
folder test = `tests/invariants/learning/`.

Nhóm invariant mới (đề xuất — chốt khi review):

| ID | Statement | Enforcement | Severity |
|---|---|---|---|
| LE-001 | Output của lớp learning (advice/score/signal) không bao giờ là runtime authority — chỉ là input có trọng số cho một quyết định deterministic đã tồn tại. | AdviceGate + PolicyEngine | CRITICAL |
| LE-002 | Tắt lớp learning (flag off) phải cho hành vi runtime y hệt khi không có learning (fail-safe = default Phase 10). | AdviceGate (null-advice path) | CRITICAL |
| LE-003 | Learning advice chỉ được **sắp xếp lại / chấm điểm trong** một allowed-set/ranking đã tất định; không được thêm action, nới budget, hay tạo quyền mới. | AdviceGate (clamp/allowlist) | CRITICAL |
| LE-004 | SelfModel là total function của EventLog (đã redact) + metrics; cùng input → cùng self-model (tái lập được). | SelfModelBuilder | CRITICAL |
| LE-005 | Mọi lesson/advice có provenance (session/run nguồn) + reason + timestamp; append-only. | LearningStore + Writer | CRITICAL |
| LE-006 | Learning store có retention bound; không ghi không giới hạn. | LearningStore | HIGH |
| LE-007 | Lớp learning không bao giờ bypass Policy/ToolGateway/ModelGateway để lấy dữ liệu hay thực thi action. | AdviceGate | CRITICAL |
| LE-008 | SelfModel/learning chỉ đọc dữ liệu đã redact (không PII/secret rò rỉ từ event sang advice). | Redactor + SelfModelBuilder | CRITICAL |

Các invariant đã có được Phase 11 làm giàu (không thêm mới):
- **CX-005** (context không phải authority) — nền tảng của LE-001; advice re-rank context
  vẫn chỉ là context.
- **MG-006** (model output không phải authority) — self-model có thể gọi model để *diễn
  giải* lịch sử, nhưng diễn giải đó vẫn untrusted → LE-001 clamp lại.
- **TI-007** (priority là proposal, không authority) — mẫu hình chuẩn: learning cũng vậy.
- **RC-001/RC-002/RC-008** (recovery trong allowed-set, bounded, không vượt budget) —
  LE-003 nói rõ advice không được phá các bound này.
- **SM-006** (không transition nào phụ thuộc LLM output thô) — mở rộng: không transition
  nào phụ thuộc learning output thô.
- **ME-003/ME-006** (memory có provenance + bounded) — LearningStore kế thừa khuôn.
- **SE-005** (redact secrets) — LE-008 áp cho đường self-model.

---

## 2. Scope Phase 11

### 2.1 In-scope

| Component | Mục tiêu | Enforces |
|---|---|---|
| `SelfModelBuilder` | Tính một SelfModel chỉ-đọc, tất định từ EventLog + DogfoodMetrics (per-session và cumulative). | LE-004, LE-008 |
| `LearningStore` | Lưu "lesson" (failure→outcome patterns, strategy outcomes, context-hit stats) có provenance, bounded, append-only (SQLite, schema mới). | LE-005, LE-006 |
| `LessonWriter` | Chưng cất lesson từ các run đã kết thúc (deterministic distillation), ghi qua provenance. | LE-005, LE-006 |
| `AdviceGate` | Biên deterministic giữa learning và policy: nhận đề xuất, clamp/allowlist/bound, ghi provenance, trả advice đã-an-toàn (hoặc null). | LE-001, LE-002, LE-003, LE-007 |
| `RecoveryAdvisor` | Đề xuất **thứ tự ưu tiên trong allowed-set** của RecoveryPolicy dựa trên lesson (vd class X trong repo Y: FIX hay fail → thử REPLAN sớm). | LE-001, LE-003 |
| `ContextReranker` | Đề xuất điểm re-rank cho candidate files/symbols của Retriever dựa trên "file nào thực sự được sửa khi task tương tự PASSED". | LE-001, CX-005 |
| `NoProgressAdvisor` | Cảnh báo no-progress **sớm hơn** dựa trên pattern lịch sử — vẫn chỉ bơm một tín hiệu advisory vào NoProgressPolicy. | LE-001, RC-003 |
| P11-INV | Thêm nhóm `LE-*` vào `invariants.yaml` + viết test invariant. | LE-* |
| P11-ADV | Adversarial harness: MaliciousAdvisor (advice đòi action ngoài allowed-set / nới budget / bypass gate) phải bị AdviceGate chặn. | LE-001..LE-003, LE-007 |
| P11-I1 | Integration E2E: hai task tương tự liên tiếp → lesson được chưng cất, advice được sinh, PASSED vẫn do kernel, và flag-off cho hành vi y hệt. | tất cả Phase-11 |

### 2.2 Out-of-scope (Phase 11)

- **Online weight update / fine-tuning của model** — không. Learning ở đây là
  symbolic/statistical over history, không chạm trọng số model (để Phase 12+ nếu từng làm).
- **Thay đổi bất kỳ ma trận policy tất định một cách tự động** — RecoveryPolicy /
  VerificationPolicy / scheduling vẫn do con người đổi + bump version. Learning chỉ *gợi ý
  trong* chúng.
- **Semantic embedding / vector self-model** — giữ deterministic trước; embedding là
  deferred (giống quyết định của Phase 7).
- **Cross-workspace / cloud learning sync** — single-workspace, local (phạm vi v1). Chia sẻ
  lesson giữa workspace là Phase 12+.
- **Multi-agent shared self-model** — Phase 8/`AU-*` territory.
- **Để learning tự submit goal / tự khởi tạo task** — vi phạm `GL-*`; không.

---

## 3. Kiến trúc những gì đã có (đã xác minh trong code)

### 3.1 Đã có — dùng ngay làm nền learning

| Thứ | Location | Vai trò cho Phase 11 |
|---|---|---|
| `computeSessionMetrics` + `SessionMetrics` (pure, từ EventLog) | `agent-core/src/observability/dogfood-metrics.ts` | Nguồn tín hiệu chính cho SelfModel; đã total/deterministic. |
| `EventLog.query({ sessionId, fromSequence })` + domain events (tool/verification/recovery/intervention) | `agent-core/src/repositories/index.ts` (interface) | Nguồn chân lý chỉ-đọc để chưng cất lesson (LE-004); đọc đúng như observability-service đang làm. |
| `FailureRepository.getBySession` / `getByTask` (bảng `failures`) + RecoveryAction records | `agent-core/src/repositories/index.ts`, `infrastructure/src/repositories/recovery-repository.ts` | Nguồn trực tiếp cho failure→recovery outcome stats của SelfModel. |
| `DEFAULT_RECOVERY_POLICY` + `decide()` (ma trận TĨNH, versioned) | `agent-core/src/recovery/recovery-policy.ts` | Điểm cắm `RecoveryAdvisor`: advice chỉ sắp xếp trong `rule.actions`. |
| `Retriever.rankOtherFiles` + import-distance (heuristic TĨNH) | `agent-core/src/context/retriever.ts` | Điểm cắm `ContextReranker`: advice chỉ điều chỉnh điểm, giữ tie-break tất định. |
| `NoProgressDetector` | `agent-core/src/recovery/no-progress-detector.ts` | Điểm cắm `NoProgressAdvisor` (tín hiệu advisory). |
| `MemoryWriter`/`MemoryRetriever` + `RetentionPolicy` + `ME-*` | `agent-core/src/memory/*` | Khuôn mẫu provenance + bounded + append-only cho `LearningStore`. |
| `ProvenanceTracker` + `Provenance` | `agent-core/src/context/provenance-tracker.ts`, `domain/provenance.ts` | Mọi lesson/advice gắn provenance (LE-005). |
| Redactor (SE-005) | security layer | LE-008: self-model chỉ đọc dữ liệu đã redact. |
| SQLite + migration engine | `infrastructure/src/sqlite/*` | Schema mới cho `learning_lessons`. |

### 3.2 Cần tạo mới (Phase 11)

- `domain/self-model.ts` — type `SelfModel`, `Lesson`, `Advice`, `AdviceKind`.
- `learning/self-model-builder.ts` — `SelfModelBuilder` (pure).
- `learning/lesson-writer.ts` — chưng cất + ghi lesson (bounded, provenance).
- `learning/advice-gate.ts` — `AdviceGate` (clamp/allowlist/bound, null-safe).
- `learning/recovery-advisor.ts`, `learning/context-reranker.ts`,
  `learning/no-progress-advisor.ts` — các advisor cụ thể.
- `infrastructure/.../learning-store.ts` — adapter SQLite cho `LearningStore` interface.
- Migration mới **additive-only** (bảng `learning_lessons`, bump schema version kế tiếp,
  không chạm migration cũ) — theo đúng khuôn migration `0005-memory-tables.ts` (`memory_records`)
  của Phase 7. Reversible rollback `DROP TABLE IF EXISTS learning_lessons;`.
- `tests/invariants/learning/le-00N.spec.ts` — 8 invariant test.
- `tests/adversarial/malicious-advisor.spec.ts` — P11-ADV.

---

## 4. Sub-phases (thứ tự thực hiện)

Mỗi sub-phase độc lập kiểm thử được; không bắt đầu sub-phase sau khi sub-phase trước
chưa xanh. Thứ tự đi từ "quan sát (an toàn tuyệt đối)" → "cổng chặn" → "advisor nhỏ nhất"
→ "advisor còn lại", để quyền-lực-số-0 được chứng minh trước khi có bất kỳ advice nào
chạm policy.

### P11.1 — SelfModel (chỉ-đọc, zero authority)
- `SelfModelBuilder` tính SelfModel từ EventLog + `computeSessionMetrics`.
- SelfModel gồm: per-class failure→recovery outcome stats, strategy success-rate, context
  hit-rate (file được sửa vs file được đưa vào context), convergence stats (decisions-to-done).
- **Chưa có advisor, chưa chạm policy.** Chỉ là projection + (optional) endpoint `/self-model`.
- Exit: LE-004 (determinism/reproducibility) + LE-008 (redaction) xanh; snapshot test.

### P11.2 — LearningStore + LessonWriter (bounded, provenance)
- Schema `learning_lessons` + migration. `LearningStore` interface trong agent-core,
  adapter trong infrastructure (giữ DC-* dependency direction).
- `LessonWriter` chưng cất lesson tất định từ run đã finalize; retention bound (kế thừa
  khuôn `ME-006`).
- Exit: LE-005, LE-006 xanh; append-only + eviction test.

### P11.3 — AdviceGate (cổng chặn — trái tim của Phase 11)
- `AdviceGate.sanitize(rawAdvice, deterministicContext) → SafeAdvice | null`.
- Clamp: advice recovery phải là hoán vị **con** của `rule.actions` hiện tại (không phần
  tử lạ); advice re-rank là ánh xạ điểm bị bound; advice no-progress chỉ là boolean sớm/muộn.
- Null-advice path = default Phase 10 (LE-002).
- **Viết test đối kháng NGAY tại đây** (P11-ADV, một phần): MaliciousAdvisor thử chèn action
  ngoài allowed-set / nới budget → gate strip về null hoặc clamp.
- Exit: LE-001, LE-002, LE-003, LE-007 xanh.

### P11.4 — RecoveryAdvisor (advisor đầu tiên, nhỏ nhất)
- Dựa trên lesson, đề xuất **thứ tự** trong `rule.actions`. `decide()` nhận advice *đã qua
  AdviceGate* như một tie-break/ordering hint, vẫn bound bởi `maxAttempts` + budget.
- Fail-safe: không có advice → `decide()` hành xử đúng Phase 5/10.
- Exit: integration test cho thấy order đổi nhưng allowed-set/bound không đổi; flag-off = cũ.

### P11.5 — ContextReranker + NoProgressAdvisor (các advisor còn lại)
- `ContextReranker`: điều chỉnh điểm candidate của Retriever; giữ tie-break
  `localeCompare` tất định; CX-005 nguyên vẹn (vẫn chỉ là context).
- `NoProgressAdvisor`: bơm một tín hiệu "likely-no-progress sớm" vào NoProgressPolicy; RC-003
  vẫn deterministic trên tập tín hiệu.
- Exit: integration; flag-off parity.

### P11.6 — Full adversarial + E2E + sign-off
- Hoàn tất P11-ADV (MaliciousAdvisor đủ biến thể) + P11-I1 (hai task tương tự → lesson →
  advice → PASSED do kernel → flag-off parity).
- Win + WSL full suite xanh; cập nhật `invariants.yaml`; viết `PHASE_11_SIGNOFF.md`.

---

## 5. Phase gate (exit criteria)

Theo khuôn `EVALUATION_MODEL §11`. Phase 11 chỉ "done" khi **tất cả**:

1. 8 invariant `LE-*` có test và xanh 100% (CRITICAL = pass tuyệt đối).
2. **Flag-off parity**: chạy một fixture với learning OFF và ON-nhưng-store-rỗng cho **cùng**
   kết quả runtime (LE-002) — bằng chứng zero-authority.
3. Adversarial: `MaliciousAdvisor` (advice đòi action ngoài allowed-set, nới budget, bypass
   gate, inject qua lesson content) → **0 violation**, mọi advice bị clamp/null tại AdviceGate.
4. Self-model reproducibility: cùng EventLog → cùng SelfModel byte-for-byte (LE-004).
5. Redaction: không secret/PII rò từ event sang lesson/advice (LE-008).
6. Determinism tổng: toàn bộ test cũ (1327) vẫn xanh; không invariant nào từ Phase 0-10
   regress.
7. Cross-platform: Win + WSL (Linux) full suite xanh.
8. Dependency direction: `learning/` trong agent-core thuần; adapter store trong
   infrastructure; depcruise 0 vi phạm (DC-*).

---

## 6. Rủi ro & cách kiểm soát

| Rủi ro | Kiểm soát |
|---|---|
| Learning lặng lẽ trở thành authority (lỗi lớn nhất của loại hệ thống này) | AdviceGate là điểm nghẽn duy nhất; LE-001/LE-003 test chặn; flag-off parity (LE-002) chứng minh runtime không phụ thuộc. |
| Advice phá determinism/reproducibility | SelfModel + lesson distillation là pure function của EventLog (LE-004); advice chỉ đổi *thứ tự trong* tập tất định, tie-break tất định giữ nguyên. |
| Prompt injection qua lesson content (lesson chứa text từ workspace) | Lesson content được redact + đánh dấu untrusted; advice là *dữ liệu có cấu trúc đã clamp*, không phải text tự do nhét vào prompt điều khiển. LE-007/LE-008. |
| Store phình vô hạn | Retention bound kế thừa `ME-006` (LE-006). |
| "Học sai" làm agent tệ đi | Advice chỉ re-order trong allowed-set đã an toàn; worst case = thứ tự xấu trong tập hợp lệ, vẫn bounded; con người có thể tắt flag tức thì về Phase 10. |
| Phức tạp hoá kernel | Learning sống hoàn toàn ngoài kernel; kernel chỉ thấy `SafeAdvice | null` qua một interface hẹp. Xoá lớp learning không chạm kernel. |

---

## 7. Vì sao Phase 11 bây giờ (và điều kiện tiên quyết)

Phase 10 đã cho một substrate chạy end-to-end và một lớp đo (`DogfoodMetrics`) — tức là
**đã có dữ liệu để học**. Dogfood gần đây cho thấy đòn bẩy rẻ là *ràng buộc hành vi*
(prompt, thứ tự thử), đúng loại thứ một lớp learning advisory có thể tối ưu một cách an
toàn. Phase 11 biến các quan sát thủ công đó (vd "FIX trước REPLAN cho SYNTAX") thành
tín hiệu học được — nhưng vẫn trong khuôn deterministic.

Điều kiện tiên quyết (đã thoả): EventLog + metrics tất định (P9/P10), Memory layer +
`ME-*` (P7), RecoveryPolicy versioned (P5), context ranking tất định (P6), provenance
+ redaction (P1/P2 + SE-005). Không hạng mục nào bị thiếu để bắt đầu P11.1.

---

## 8. Lưu ý triết lý (để không lạc hướng)

Giá trị của Phase 11 **không** phải là "agent tự thông minh hơn". Giá trị là chứng minh
một mệnh đề mạnh của kiến trúc: *ta có thể thêm một lớp học thích nghi mà không nhượng
một gram quyền quyết định nào cho nó.* Nếu bất kỳ lúc nào một đề xuất learning có thể
thực thi mà không qua một quyết định deterministic đã tồn tại, Phase 11 đã thất bại —
bất kể agent "thông minh" đến đâu.

> **Smart model. Strict runtime. Verifiable outcome. — và giờ: Learning advises, kernel
> still decides.**
