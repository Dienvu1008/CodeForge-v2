# Phase 0 trên Windows-only: Giải pháp thực tế

**Phase 0 vẫn hoàn thành được, nhưng cần điều chỉnh acceptance criteria một cách trung thực.**

Tôi sẽ không nói "cứ làm đi, không sao" — vì cross-platform là một phần giá trị thật của Phase 0. Nhưng cũng không cần vì thế mà bỏ Phase 0.

---

## 1. Vấn đề thực sự là gì?

### 1.1. Bạn KHÔNG THỂ test macOS locally

- Apple **cấm** virtualize macOS trên non-Apple hardware (vi phạm EULA).
- Hackintosh = vi phạm pháp lý + không ổn định.
- macOS chỉ chạy trên Apple hardware.

### 1.2. Bạn CÓ THỂ test Linux locally

- **WSL2** trên Windows 10/11 → Linux thật (kernel thật).
- **Docker Desktop** → Linux container.
- **VM** (VirtualBox, Hyper-V, VMware) → Linux VM.

### 1.3. Bạn CÓ THỂ test cả 3 OS qua CI

- **GitHub Actions** cho runner Ubuntu, macOS, Windows — **miễn phí** cho public repo, có quota cho private.
- **GitLab CI**, **CircleCI**, **Azure Pipelines** — tương tự.

---

## 2. Bốn lựa chọn thực tế

### Option A: GitHub Actions (khuyến nghị)

**Ưu điểm:**
- Miễn phí (public repo: unlimited; private: 2000 phút/tháng).
- Có sẵn `ubuntu-latest`, `macos-latest`, `windows-latest`.
- Không cần cài gì.
- Chính là cách các dự án lớn làm.

**Nhược điểm:**
- Cần internet.
- Queue time.
- Debug khó hơn local.

**Cách dùng:**

```yaml
# .github/workflows/phase0.yml
name: Phase 0
on: [push, pull_request]

jobs:
  cross-platform:
    strategy:
      matrix:
        os: [ubuntu-latest, macos-latest, windows-latest]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - run: npm ci
      - run: npm run test:workspace-vectors
      - run: npm run test:invariants
```

**Chi phí thực tế:**
- Public repo: **$0**.
- Private repo: ~2000 phút/tháng free, đủ cho Phase 0.

### Option B: WSL2 + GitHub Actions

**Ý tưởng:**
- **Linux** = WSL2 local (nhanh, debug dễ).
- **Windows** = local (native).
- **macOS** = GitHub Actions (chỉ chạy khi cần).

**Ưu điểm:**
- Debug Linux nhanh.
- Không phụ thuộc CI cho 2/3 OS.

**Nhược điểm:**
- Vẫn cần GitHub Actions cho macOS.
- WSL2 không hoàn toàn giống Linux server (kernel tweaked).

### Option C: Docker + Cloud macOS

**Ý tưởng:**
- Linux = Docker container.
- Windows = local.
- macOS = thuê cloud (MacStadium, AWS EC2 Mac, Scaleway).

**Nhược điểm:**
- macOS cloud **đắt**: ~$0.5-2/giờ.
- Setup phức tạp.

**Chỉ dùng nếu:** Phase 0 cần chạy macOS hàng trăm lần.

### Option D: Điều chỉnh Phase 0

**Ý tưởng:**
- Chấp nhận Phase 0 chỉ test Windows + Linux.
- macOS để Phase 1 hoặc Phase 4.
- Ghi rõ trong acceptance criteria.

**Ưu điểm:**
- Không cần CI phức tạp.
- Vẫn đạt 90% giá trị.

**Nhược điểm:**
- macOS-specific bug phát hiện muộn.
- Phase 0 không "complete" theo nghĩa strict.

---

## 3. Khuyến nghị của tôi

### 3.1. Ngắn hạn: **GitHub Actions + WSL2**

```
Windows native   →  local dev + test
WSL2 (Ubuntu)    →  local test Linux
GitHub Actions   →  macOS verification
```

- Viết code trên Windows.
- Chạy test nhanh trên WSL2.
- Push lên GitHub → CI chạy macOS.
- macOS fail → fix → push lại.

**Chi phí:** $0 (nếu public repo hoặc < 2000 phút/tháng).

### 3.2. Trung hạn: **Điều chỉnh acceptance**

Nếu không muốn phụ thuộc CI:

**Phase 0A (Windows + Linux):**
- Tất cả invariant tests.
- Canonical hash vectors.
- Adversarial harness.
- Cross-platform Windows/Linux.

**Phase 0B (macOS):**
- Chạy sau, khi có điều kiện.
- Không block Phase 1.
- Chỉ block Phase 4 (first vertical slice).

### 3.3. Dài hạn: **CI là bắt buộc**

Khi project lớn hơn:
- CI 3 OS là chuẩn.
- Không thể tránh.
- Nên setup sớm.

---

## 4. Điều chỉnh PHASE_0_ACCEPTANCE.md

Tôi đề xuất sửa một số criteria:

### 4.1. Thay đổi XP-2, XP-3

**Trước:**
```
[ ] XP-2: Toàn bộ vector CH-1..CH-20 pass trên macOS
[ ] XP-3: Toàn bộ vector CH-1..CH-20 pass trên Windows
```

**Sau:**
```
[ ] XP-1: Toàn bộ vector CH-1..CH-20 pass trên Windows (local)
[ ] XP-2: Toàn bộ vector CH-1..CH-20 pass trên Linux (WSL2)
[ ] XP-3: Toàn bộ vector CH-1..CH-20 pass trên macOS (CI)
       HOẶC defer với ghi chú rõ ràng
```

### 4.2. Thêm section "Platform Coverage Tiers"

```markdown
## Platform Coverage Tiers

### Tier 1 (bắt buộc Phase 0)
- Windows 11 (primary dev)
- Ubuntu 22.04 (WSL2)

### Tier 2 (khuyến nghị Phase 0)
- macOS 14 (GitHub Actions)

### Tier 3 (defer)
- Windows 10
- Ubuntu 20.04
- macOS 13

### Tier 4 (future)
- Other Linux distros
```

### 4.3. Ghi rõ lý do defer

```markdown
## Deferred Items

### macOS Testing (Phase 0 → Phase 1)
Lý do: developer không có Apple hardware.
Giải pháp: GitHub Actions runner `macos-latest`.
Điều kiện bắt đầu: trước Phase 4 (first vertical slice).

### Risk
- macOS-specific hash bug có thể phát hiện muộn.
- Mitigation: code cẩn thận với case sensitivity, CRLF, symlink.
- Fallback: CI check khi push.
```

---

## 5. Câu trả lời thẳng

### 5.1. Phase 0 có hoàn thành được không?

**Có**, nếu:

1. Bạn chấp nhận **Windows + Linux (WSL2)** là đủ cho Phase 0 chính.
2. macOS để **GitHub Actions** hoặc **defer** sang Phase 1.
3. Ghi rõ trong acceptance criteria.

### 5.2. Có nên bỏ Phase 0 vì thiếu macOS không?

**Không.** 90% giá trị Phase 0 đến từ:

- Contract rõ ràng.
- Invariant có test.
- Canonical hash deterministic (Windows + Linux đã cover nhiều case).
- Adversarial harness.
- Dependency direction.

macOS chỉ là **10% cuối** — quan trọng nhưng không critical.

### 5.3. Rủi ro lớn nhất khi thiếu macOS?

| Rủi ro | Xác suất | Tác động | Mitigation |
|---|---|---|---|
| Case-insensitive FS bug | Trung bình | Cao | Code cẩn thận + CI khi push |
| CRLF handling bug | Thấp | Trung bình | Test vector CRLF trên Windows |
| Symlink bug | Thấp | Thấp | Không dùng symlink trên macOS |
| APFS-specific bug | Rất thấp | Thấp | Không có |

**Rủi ro lớn nhất:** case-insensitive FS. Nhưng Windows cũng case-insensitive → đã cover phần lớn.

---

## 6. Lộ trình thực tế cho bạn

### Tuần 1-2: Setup

- [ ] Cài WSL2 (Ubuntu 22.04).
- [ ] Setup Node.js trên cả Windows + WSL2.
- [ ] Setup GitHub repo.
- [ ] Setup GitHub Actions với 3 OS runner.

### Tuần 3-6: Phase 0 chính

- [ ] Viết spec (đã xong).
- [ ] Sinh `invariants.yaml`.
- [ ] Sinh domain types.
- [ ] Sinh canonical hash impl.
- [ ] Sinh 20 workspace vectors.
- [ ] Test trên Windows + WSL2.

### Tuần 7: macOS verification

- [ ] Push lên GitHub.
- [ ] CI chạy macOS runner.
- [ ] Fix nếu fail.
- [ ] Ghi kết quả vào sign-off.

### Tuần 8: Sign-off

- [ ] Tất cả criteria pass (hoặc defer có ghi chú).
- [ ] Sign-off document.
- [ ] Bắt đầu Phase 1.

---

## 7. So sánh chi phí

| Option | Chi phí | Thời gian setup | Độ tin cậy |
|---|---|---|---|
| GitHub Actions (public) | $0 | 1 giờ | Cao |
| GitHub Actions (private) | $0-20/tháng | 1 giờ | Cao |
| WSL2 + GitHub Actions | $0 | 2 giờ | Cao |
| macOS cloud | $50-200/tháng | 4 giờ | Cao |
| Mua Mac Mini | $600+ | 1 ngày | Rất cao |
| Defer macOS | $0 | 0 | Trung bình |

**Khuyến nghị:** WSL2 + GitHub Actions. Chi phí $0, độ tin cậy cao.

---

## 8. Ghi chú về tính trung thực

Tôi không muốn nói dối bạn rằng "Windows-only là đủ". Nó **không đủ** cho Phase 0 strict.

Nhưng:

1. **Windows + Linux đã cover 80% cross-platform risk.**
2. **macOS có thể cover qua CI miễn phí.**
3. **Defer macOS có ghi chú là hợp lệ** — miễn là honest.
4. **Phase 0 không phải all-or-nothing.**

Điều **không** hợp lệ:

- ❌ Nói "Phase 0 complete" khi chưa test macOS.
- ❌ Bỏ macOS mà không ghi chú.
- ❌ Giả vờ cross-platform đã verified.

Điều **hợp lệ**:

- ✅ Windows + Linux verified locally.
- ✅ macOS verified qua CI HOẶC defer có ghi chú.
- ✅ Risk assessment rõ ràng.
- ✅ Mitigation plan.

---

## 9. North Star (thực tế)

> **Phase 0 không đòi hỏi bạn có 3 máy. Phase 0 đòi hỏi bạn trung thực về cái bạn đã test và cái bạn chưa test.**

Nếu bạn có Windows + WSL2 + GitHub Actions:
- Bạn test được 3 OS.
- Chi phí $0.
- Độ tin cậy cao.

Nếu bạn chỉ có Windows:
- Bạn test được Windows.
- Linux qua WSL2 (nếu cài).
- macOS defer có ghi chú.
- Vẫn hoàn thành Phase 0 **với scope điều chỉnh**.

Câu hỏi không phải "làm sao có 3 máy", mà là:

> **"Tôi đã test cái gì, chưa test cái gì, và rủi ro là gì?"**

Trả lời trung thực → Phase 0 vẫn có giá trị.

---

## 10. Đề xuất cụ thể

Tôi đề xuất bạn chọn một trong hai:

### Option 1: Full cross-platform (khuyến nghị)

- Setup WSL2.
- Setup GitHub Actions 3 OS.
- Phase 0 theo spec gốc.

**Thời gian thêm:** ~1 tuần.
**Chi phí:** $0.

### Option 2: Windows + Linux, macOS deferred

- Setup WSL2.
- Sửa acceptance criteria.
- macOS defer sang Phase 1.

**Thời gian thêm:** ~2 ngày.
**Chi phí:** $0.
**Rủi ro:** macOS bug phát hiện muộn.

Bạn muốn tôi:

1. **Viết `PHASE_0_ACCEPTANCE_v1.1.md`** với platform tiers điều chỉnh?
2. **Viết hướng dẫn setup WSL2 + GitHub Actions** cụ thể?
3. **Viết risk assessment** cho macOS defer?
4. **Giữ nguyên spec gốc** và bạn tự quyết định?


# Windows + WSL2 cho toàn bộ Roadmap: Phân tích thực tế

Câu hỏi hay. Câu trả lời ngắn: **Windows + WSL2 đủ cho 90% roadmap, nhưng có một số phase cần điều chỉnh chiến lược.** Tôi sẽ đi từng phase, chỉ rõ cái gì ổn, cái gì cần chú ý, cái gì phải defer.

---

## 1. Windows + WSL2 thực chất là gì?

Trước khi đi vào phase, cần hiểu rõ setup này cho bạn **hai môi trường**:

```
┌─────────────────────────────────────────────┐
│           Windows 11 (host)                 │
│                                             │
│  ┌───────────────────────────────────────┐  │
│  │  WSL2 (Ubuntu)                        │  │
│  │  - Linux kernel thật                  │  │
│  │  - ext4 filesystem                    │  │
│  │  - POSIX processes                    │  │
│  │  - Full symlinks                      │  │
│  └───────────────────────────────────────┘  │
│                                             │
│  Windows-native:                            │
│  - NTFS                                     │
│  - Win32 processes                          │
│  - Limited symlinks                         │
│  - CRLF default                             │
└─────────────────────────────────────────────┘
```

**Đây là 2 platform thật**, không phải 1.5. WSL2 chạy Linux kernel thật → test được hầu hết Linux behaviors.

**Cái thiếu:** macOS (APFS case-insensitive, Darwin-specific symlink, Mach-O binaries).

---

## 2. Phân tích từng Phase

### Phase 0 — Executable Architecture Contract

**Trạng thái:** ✅ Hoàn thành được (với điều chỉnh đã bàn)

| Task | Windows | WSL2 | macOS | Status |
|---|---|---|---|---|
| Invariants | ✅ | ✅ | ❌ | 2/3 OK |
| Canonical hash vectors | ✅ | ✅ | ❌ | 2/3 OK |
| Path canonicalization | ✅ | ✅ | ❌ | 2/3 OK |
| Adversarial harness | ✅ | ✅ | ✅ | OK |
| Dependency direction | ✅ | ✅ | ✅ | OK |
| Domain types | ✅ | ✅ | ✅ | OK |

**Điều chỉnh:** macOS defer với ghi chú. Risk assessment rõ ràng.

**Kết luận:** Phase 0 complete với platform tier 1 (Windows + Linux).

---

### Phase 1 — Runtime Kernel

**Trạng thái:** ✅ Hoàn thành tốt

Runtime Kernel bao gồm:
- Goal, Session, Task, TaskExecution, TaskRun
- TaskGraph, GraphMutation
- StateMachine, Scheduler
- Budget, Checkpoint
- SQLite, EventLog

**Vấn đề platform:**

| Component | Windows | WSL2 | Risk |
|---|---|---|---|
| SQLite | ✅ | ✅ | Không |
| File lock | ✅ | ✅ | Windows lock khác Linux |
| Process ID | ✅ | ✅ | PID semantics khác |
| File path | ⚠️ | ✅ | Windows `\` vs Linux `/` |
| Timestamp | ✅ | ✅ | Cả hai dùng UTC |

**Điểm cần chú ý:**

1. **File lock**: Windows `LockFileEx` khác Linux `flock`. Workspace lock cần test kỹ trên cả hai.
2. **Process ID**: Windows PID có thể reuse nhanh hơn Linux. Orphan detection cần cẩn thận.
3. **Path separator**: Domain dùng `/` internally, adapter convert theo OS.

**Khuyến nghị:**
- Develop chính trên WSL2 (giống Linux server hơn).
- Test cross-check trên Windows native ít nhất 1 lần/tuần.
- Không cần macOS cho Phase 1.

**Kết luận:** ✅ Complete với Windows + WSL2.

---

### Phase 1.5 — Adversarial & Crash Evaluation

**Trạng thái:** ✅ Hoàn thành tốt

Test:
- Malicious model variants.
- Invalid JSON, schema.
- Tool bypass, prompt injection.
- Budget abuse, graph corruption.
- Crash, restart, cancel, orphan process.
- Stale verification, workspace mutation.

**Vấn đề platform:**

| Test | Windows | WSL2 | Risk |
|---|---|---|---|
| Process crash | ✅ | ✅ | Signal khác (SIGTERM vs TerminateProcess) |
| Orphan process | ⚠️ | ✅ | Windows job objects cần cấu hình |
| File lock crash | ⚠️ | ✅ | Windows lock release khi process chết |
| SQLite crash | ✅ | ✅ | WAL recovery giống nhau |
| Signal handling | ⚠️ | ✅ | POSIX signals khác Windows |

**Điểm cần chú ý:**

1. **Orphan process trên Windows**: Cần dùng **Job Objects** để đảm bảo process tree chết khi parent chết. WSL2 dùng process group.
2. **Signal handling**: Windows không có SIGTERM thật → dùng `TerminateProcess`. Adapter phải abstract.
3. **Crash recovery**: Test crash injection phải có Windows-specific implementation.

**Khuyến nghị:**
- Process adapter phải có Windows + Linux implementation riêng.
- Test orphan cleanup trên cả hai.
- Không cần macOS.

**Kết luận:** ✅ Complete nhưng cần platform-specific adapter cho process.

---

### Phase 2 — Planning

**Trạng thái:** ✅ Hoàn thành tốt

Planning bao gồm:
- Planner, Plan, PlanValidator, PlanCritic
- GraphCommit, Replanner, GraphMutation

**Vấn đề platform:** **Gần như không có.**

Planning là pure logic + LLM call. Không touch filesystem, không spawn process.

| Component | Windows | WSL2 | macOS |
|---|---|---|---|
| Planner | ✅ | ✅ | ✅ |
| Validator | ✅ | ✅ | ✅ |
| Critic | ✅ | ✅ | ✅ |
| GraphCommit | ✅ | ✅ | ✅ |

**Khuyến nghị:**
- Develop trên WSL2 cho consistency.
- Không cần macOS.

**Kết luận:** ✅ Complete với bất kỳ platform nào.

---

### Phase 3 — Model + Tool + Code Intelligence

**Trạng thái:** ⚠️ Cần chú ý

Phase 3 bao gồm:
- ModelGateway, OllamaAdapter
- ToolGateway, ToolRegistry, ToolPolicy
- Filesystem tools, Git tools, Shell tools
- Basic code intelligence

**Vấn đề platform:**

| Component | Windows | WSL2 | Risk |
|---|---|---|---|
| Ollama | ✅ | ✅ | Ollama chạy trên cả hai |
| Filesystem tools | ⚠️ | ✅ | Path, permission khác |
| Git tools | ✅ | ✅ | Git chạy trên cả hai |
| Shell tools | ❌ | ✅ | **Đây là vấn đề lớn** |
| Tree-sitter | ✅ | ✅ | Cross-platform |

**Vấn đề lớn nhất: Shell tools**

- Windows: `cmd.exe`, `PowerShell`, `pwsh`.
- WSL2: `bash`, `sh`, `zsh`.
- Commands khác nhau: `ls` vs `dir`, `rm` vs `del`, `grep` vs `findstr`.
- Paths khác nhau: `C:\Users\...` vs `/home/...`.

**Ba chiến lược:**

**Chiến lược A: WSL2-first**
- Agent chạy trên WSL2.
- Shell tools dùng bash.
- Windows chỉ là host cho VS Code.
- **Ưu:** Đơn giản, giống Linux.
- **Nhược:** Không support Windows-native workflows.

**Chiến lược B: Dual shell**
- Windows → PowerShell.
- WSL2 → bash.
- Adapter chọn theo platform.
- **Ưu:** Support cả hai.
- **Nhược:** Phức tạp gấp đôi, nhiều bug.

**Chiến lược C: Windows-only tools**
- Chỉ support Windows-native.
- Không dùng WSL2 cho execution.
- **Ưu:** Đơn giản.
- **Nhược:** Mất Linux compatibility.

**Khuyến nghị: Chiến lược A (WSL2-first)**

Lý do:
- Ollama coding agent thường target code repos → Linux-native workflows phổ biến hơn.
- WSL2 gần giống Linux server → dễ test, dễ deploy.
- Windows-native support có thể thêm ở Phase 8.

**Kết luận:** ⚠️ Phase 3 cần chọn chiến lược shell. Khuyến nghị WSL2-first.

---

### Phase 4 — First Autonomous Vertical Slice

**Trạng thái:** ⚠️ Phụ thuộc Phase 3

Đây là milestone cực kỳ quan trọng. Agent phải:
- Nhận goal.
- Plan.
- Execute.
- Modify code.
- Run test.
- Verify.
- Pass.

**Vấn đề platform:**

| Target project | Windows | WSL2 | macOS |
|---|---|---|---|
| Flutter (Windows target) | ⚠️ | ❌ | ❌ |
| Flutter (Linux target) | ❌ | ✅ | ❌ |
| Flutter (macOS target) | ❌ | ❌ | ✅ |
| Node.js (Windows) | ✅ | ⚠️ | ✅ |
| Node.js (Linux) | ❌ | ✅ | ✅ |
| TypeScript | ✅ | ✅ | ✅ |

**Vấn đề lớn:** Bạn không test được macOS target. Nếu user muốn agent build macOS app → không được.

**Khuyến nghị:**

1. **Chọn target cụ thể:**
   - TypeScript/Node.js project (cross-platform).
   - Chạy trên WSL2.
   - Test trên cả Windows + WSL2.

2. **Flutter:**
   - Chọn Linux target (WSL2).
   - Hoặc Windows target (native).
   - Không test macOS target.

3. **Ghi rõ trong docs:**
   - "v1 supports Windows and Linux targets. macOS target deferred."

**Kết luận:** ⚠️ Complete với target cụ thể. Không support macOS target.

---

### Phase 5 — Recovery & Autonomy

**Trạng thái:** ✅ Hoàn thành tốt

Recovery bao gồm:
- FailureAnalyzer, RecoveryPolicy, RecoveryEngine
- NoProgressDetector
- Retry, Fix, Split, Replace, Rollback, Replan, Escalate

**Vấn đề platform:** **Gần như không có.**

Recovery là pure logic. Không touch filesystem, không spawn process trực tiếp.

**Kết luận:** ✅ Complete với bất kỳ platform nào.

---

### Phase 6 — Advanced Code Intelligence

**Trạng thái:** ✅ Hoàn thành tốt

Phase 6 bao gồm:
- Tree-sitter, LSP
- Symbol graph, dependency analysis
- Affected-file detection, affected-test detection
- Semantic context retrieval

**Vấn đề platform:**

| Component | Windows | WSL2 | macOS |
|---|---|---|---|
| Tree-sitter | ✅ | ✅ | ✅ |
| TypeScript LSP | ✅ | ✅ | ✅ |
| Dart LSP | ✅ | ✅ | ✅ |
| Python LSP | ✅ | ✅ | ✅ |

**Điểm cần chú ý:**

1. **LSP server paths**: Windows path vs Linux path.
2. **LSP process spawn**: Qua ProcessSupervisor.
3. **Cache paths**: Platform-specific.

**Khuyến nghị:**
- Tree-sitter + LSP đều cross-platform.
- Abstract qua adapter.
- Không cần macOS.

**Kết luận:** ✅ Complete với Windows + WSL2.

---

### Phase 7 — Memory / RAG

**Trạng thái:** ✅ Hoàn thành tốt

Phase 7 bao gồm:
- Project memory, user preferences, architecture memory
- Past task outcomes, failure patterns
- GitHub repository retrieval, docs retrieval
- Semantic index

**Vấn đề platform:**

| Component | Windows | WSL2 | macOS |
|---|---|---|---|
| Vector DB (SQLite) | ✅ | ✅ | ✅ |
| Embedding model | ✅ | ✅ | ✅ |
| Git history | ✅ | ✅ | ✅ |
| Docs retrieval | ✅ | ✅ | ✅ |

**Kết luận:** ✅ Complete với bất kỳ platform nào.

---

### Phase 8 — Advanced Autonomy

**Trạng thái:** ⚠️ Phụ thuộc target

Phase 8 bao gồm:
- Multi-agent, parallel tasks
- Browser, computer use, vision
- GUI interaction, remote workers
- Cloud models, self-improvement

**Vấn đề platform:**

| Feature | Windows | WSL2 | macOS |
|---|---|---|---|
| Multi-agent | ✅ | ✅ | ✅ |
| Parallel tasks | ✅ | ✅ | ✅ |
| Browser automation | ✅ | ⚠️ | ✅ |
| Computer use | ✅ | ❌ | ❌ |
| GUI interaction | ✅ | ❌ | ✅ |
| Vision | ✅ | ✅ | ✅ |
| Remote workers | ✅ | ✅ | ✅ |

**Điểm cần chú ý:**

1. **Computer use**: Chỉ Windows-native (không WSL2).
2. **GUI interaction**: Cần host OS (Windows hoặc macOS).
3. **Browser automation**: WSL2 có thể dùng headless.

**Kết luận:** ⚠️ Một số feature cần native OS. Defer hoặc platform-specific.

---

## 3. Tổng hợp Roadmap

| Phase | Windows | WSL2 | macOS | Status |
|---|---|---|---|---|
| 0 | ✅ | ✅ | ❌ | Complete (defer macOS) |
| 1 | ✅ | ✅ | ✅ | Complete |
| 1.5 | ⚠️ | ✅ | ✅ | Complete với platform adapter |
| 2 | ✅ | ✅ | ✅ | Complete |
| 3 | ⚠️ | ✅ | ⚠️ | WSL2-first |
| 4 | ⚠️ | ✅ | ❌ | Target-specific |
| 5 | ✅ | ✅ | ✅ | Complete |
| 6 | ✅ | ✅ | ✅ | Complete |
| 7 | ✅ | ✅ | ✅ | Complete |
| 8 | ⚠️ | ⚠️ | ⚠️ | Feature-specific |

---

## 4. Chiến lược tổng thể

### 4.1. WSL2 là primary development environment

**Lý do:**
- Giống Linux server → dễ deploy.
- Ollama coding agent target code repos → Linux workflows phổ biến.
- Shell tools dùng bash.
- Git, npm, dart đều chạy tốt.

**Cách setup:**
- VS Code với Remote WSL extension.
- Code trong `/home/user/project`, không trong `/mnt/c/`.
- Lý do: `/mnt/c/` chậm, permission issues.

### 4.2. Windows native là secondary

**Dùng cho:**
- Test cross-platform.
- Computer use (Phase 8).
- GUI interaction (Phase 8).

**Không dùng cho:**
- Primary development.
- Shell execution.

### 4.3. macOS là deferred

**Không support trong v1.**

**Lý do:**
- Không có Apple hardware.
- Không thể test.
- Không thể verify.

**Có thể thêm ở v2:**
- Khi có Mac Mini hoặc macOS cloud.
- Khi có nhu cầu thực tế.

---

## 5. Rủi ro và Mitigation

| Rủi ro | Xác suất | Tác động | Mitigation |
|---|---|---|---|
| macOS-specific hash bug | Trung bình | Cao | Code cẩn thận, defer test |
| Windows process orphan | Trung bình | Trung bình | Job Objects |
| Shell tool incompatibility | Cao | Cao | WSL2-first |
| Path separator bug | Trung bình | Thấp | Adapter pattern |
| CRLF handling | Thấp | Trung bình | Test vector |
| Case sensitivity | Thấp | Thấp | Windows cũng insensitive |

**Rủi ro lớn nhất:** macOS defer. Nhưng chấp nhận được nếu docs rõ ràng.

---

## 6. Điều chỉnh cần thiết

### 6.1. Trong specs

Cần thêm **Platform Support Matrix** trong mỗi spec:

```markdown
## Platform Support

| Platform | v1 Status | Notes |
|---|---|---|
| Windows 11 | Supported | Primary host |
| Ubuntu (WSL2) | Supported | Primary dev |
| macOS | Deferred | v2 |
```

### 6.2. Trong code

Cần **PlatformAdapter** interface:

```typescript
interface PlatformAdapter {
  platform(): 'win32' | 'linux' | 'darwin';
  isWsl(): boolean;
  pathSeparator(): '/' | '\\';
  processModel(): 'posix' | 'win32';
  shell(): 'bash' | 'powershell' | 'cmd';
}
```

Mọi platform-specific code đi qua adapter.

### 6.3. Trong CI

```yaml
# .github/workflows/phase.yml
jobs:
  test:
    strategy:
      matrix:
        os: [windows-latest, ubuntu-latest]
        # macOS deferred
    runs-on: ${{ matrix.os }}
```

Không có `macos-latest` cho đến khi cần.

### 6.4. Trong docs

Cần file **PLATFORM_SUPPORT.md**:

```markdown
# Platform Support

## v1 Supported
- Windows 11 (native)
- Ubuntu 22.04 (WSL2)

## v1 Deferred
- macOS (v2)
- Windows 10 (unsupported)

## Rationale
- Developer only has Windows hardware.
- WSL2 provides Linux compatibility.
- macOS requires Apple hardware.
```

---

## 7. Câu trả lời thẳng

### 7.1. Có hoàn thành được roadmap không?

**Có**, nếu:

1. Chấp nhận **Windows + WSL2** là 2 platform chính.
2. **macOS defer** với ghi chú rõ ràng.
3. **WSL2-first** cho development và execution.
4. **Windows native** cho computer use, GUI.
5. **Platform adapter** cho mọi platform-specific code.

### 7.2. Phase nào bị ảnh hưởng nhiều nhất?

| Phase | Mức độ ảnh hưởng |
|---|---|
| Phase 3 (Tool) | Cao — shell tools |
| Phase 4 (Vertical Slice) | Cao — target-specific |
| Phase 8 (Advanced) | Trung bình — computer use |
| Phase 1.5 (Adversarial) | Trung bình — process |
| Các phase khác | Thấp |

### 7.3. Có nên mua Mac Mini không?

**Nếu:**
- Bạn muốn support macOS trong v1.
- Bạn có $600+.
- Bạn có nhu cầu thực tế.

**Không nếu:**
- macOS không phải target user.
- Bạn muốn focus v1 vào Windows + Linux.
- Bạn có thể defer.

**Khuyến nghị:** Không mua ngay. Defer macOS. Đánh giá lại sau Phase 4.

### 7.4. Có nên dùng GitHub Actions cho macOS?

**Có**, nếu:
- Bạn muốn verify macOS compatibility.
- Bạn OK với CI time.
- Bạn không cần debug local.

**Cách:**
- Push lên GitHub.
- CI chạy `macos-latest`.
- Fix nếu fail.

**Chi phí:** $0 cho public repo.

---

## 8. Lộ trình cụ thể

### Giai đoạn 1: Setup (Tuần 1-2)

- [ ] Cài WSL2 (Ubuntu 22.04).
- [ ] Setup VS Code + Remote WSL.
- [ ] Setup Node.js trên WSL2 + Windows.
- [ ] Setup GitHub repo.
- [ ] Setup GitHub Actions (windows + ubuntu).
- [ ] Setup `.gitattributes` cho line endings.
- [ ] Setup `.editorconfig`.

### Giai đoạn 2: Phase 0 (Tuần 3-8)

- [ ] Viết specs (đã xong).
- [ ] Sinh invariants.yaml.
- [ ] Sinh domain types.
- [ ] Sinh canonical hash impl.
- [ ] Sinh workspace vectors.
- [ ] Test trên Windows + WSL2.
- [ ] macOS defer với ghi chú.
- [ ] Sign-off.

### Giai đoạn 3: Phase 1-2 (Tuần 9-16)

- [ ] Runtime Kernel.
- [ ] Planning.
- [ ] Test trên WSL2.
- [ ] Cross-check Windows.

### Giai đoạn 4: Phase 3-4 (Tuần 17-24)

- [ ] Chọn shell strategy (WSL2-first).
- [ ] Model Gateway + Ollama.
- [ ] Tool Gateway.
- [ ] First vertical slice.
- [ ] Target: TypeScript + Node.js trên WSL2.

### Giai đoạn 5: Phase 5-8 (Tuần 25+)

- [ ] Recovery.
- [ ] Code Intelligence.
- [ ] Memory/RAG.
- [ ] Advanced Autonomy.

### Đánh giá lại macOS

Sau Phase 4:
- Nếu có nhu cầu macOS → setup GitHub Actions.
- Nếu không → tiếp tục defer.

---

## 9. North Star

> **Không phải platform nào cũng cần support trong v1. Nhưng phải trung thực về cái gì supported và cái gì không.**

Windows + WSL2 là setup hợp lệ cho v1:

- **Windows** = host OS.
- **WSL2** = Linux environment.
- **macOS** = deferred.

Điều quan trọng:

1. **Không nói dối** user rằng "cross-platform" khi chưa test macOS.
2. **Ghi rõ** trong docs.
3. **Có kế hoạch** cho macOS.
4. **Không bị block** bởi thiếu macOS.

Và câu hỏi cuối cùng:

> **Bạn build cho user nào? Nếu user của bạn dùng Windows + Linux, thì macOS defer là hợp lý.**

Nếu user của bạn dùng macOS → cần giải pháp khác.

---

Bạn muốn tôi:

1. **Viết `PLATFORM_SUPPORT.md`** với matrix chi tiết?
2. **Viết `PLATFORM_ADAPTER_SPEC.md`** cho abstraction layer?
3. **Sinh skeleton PlatformAdapter** cho Windows + WSL2?
4. **Sinh CI workflow** cho Windows + Ubuntu?
5. **Viết risk assessment** cho macOS defer?