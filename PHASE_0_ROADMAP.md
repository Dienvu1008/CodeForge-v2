# PHASE_0_ROADMAP.md

**Ollama Coding Agent — Kế hoạch hoàn thành Phase 0 (Executable Architecture Contract)**

Version: 1.0
Status: Working plan
Owner: Runtime / Architecture
Scope: Biến contract (docs) thành thứ chạy được (code + test + CI)
Related:
`PHASE_0_ACCEPTANCE.md` (tiêu chí nghiệm thu — nguồn chuẩn),
`PLATFORM_SUPPORT.md` (Windows 11 + Ubuntu WSL2),
`INFRASTRUCTURE_SPEC.md`, `WORKSPACE_SPEC_v1.0.md`, `DOMAIN_CONTRACTS.md`,
`STATE_MACHINE_SPEC.md`, `GRAPH_PROTOCOL.md`, `invariants.yaml`

---

## 0. Nguyên tắc của roadmap này

> **Phase 0 làm cho kiến trúc *checkable*, không phải *correct*.** Đích đến: một người mới có
> thể `git clone`, chạy test, và biết contract đúng hay sai — trên cả Windows 11 và Ubuntu WSL2.

Ba luật khi thực thi roadmap:

1. **Implement trước, test sau.** Không viết 144 test rỗng rồi mới code (xem Cạm bẫy §7).
2. **Critical path là canonical hash.** Nếu hash sai hoặc không cross-platform → toàn bộ
   verification freshness sụp → phải viết lại ở Phase 4. Làm đúng từ đầu.
3. **Binary fixtures, không Git checkout.** Git autocrlf làm test flaky (WORKSPACE_SPEC §6.4).

---

## 1. Trạng thái hiện tại (đánh giá trung thực)

### 1.1 Đã xong — lớp "contract" (checkable-on-paper)

| Nhóm | Deliverable | Ghi chú |
|---|---|---|
| Docs | 14 spec/doc (.md) | Đã vá nhất quán chéo qua các nhóm A/B/C/D trước đó |
| Machine | `invariants.yaml` | 144 invariant, validate pass (unique, đủ trường, đúng pattern) |
| Machine | `invariants.schema.json` | draft-07, dùng với ajv |

Lớp này **không phải 30% hình thức** — nó là phần "contract không mâu thuẫn" đã được kiểm tra
kỹ. Nhưng nó **chưa chạy được**: chưa có dòng code nào, chưa có test nào thực thi, chưa CI.

### 1.2 Chưa xong — lớp "executable" (0%)

- **Machine artifacts còn thiếu:** `workspace_vectors/manifest.json` (A3), `scenarios.yaml` (A4),
  `phase_0_checklist.yaml` (A5).
- **Reference code (C1–C10):** canonical hash, WorkspaceRevision, path canonicalizer, domain
  types, state-machine types, graph types, repository interfaces, AdversarialModel, FakeModel,
  test harness.
- **Tests (T1–T7):** invariant tests, workspace vectors, cross-platform, adversarial,
  state-machine, graph, contracts.
- **CI (CI1–CI5):** 5 workflow GitHub Actions.

Đây là ~70% khối lượng và là phần khó nhất.

### 1.3 Hai điểm lệch trong spec cần chốt trước khi bắt đầu

| # | Lệch | Quyết định roadmap |
|---|---|---|
| L1 | `PHASE_0_ACCEPTANCE.md` (§5.1, §7.3, exit) yêu cầu **3 OS gồm macOS**; `PLATFORM_SUPPORT.md` tuyên bố **chỉ Windows 11 + WSL2, loại macOS** | **✅ Đã xử lý (A0).** `PHASE_0_ACCEPTANCE.md` v1.1: CI/cross-platform còn **2 OS** (windows-latest + ubuntu-latest); macOS (XP-2, IT-4, CI-2) đánh dấu DEFERRED v2. |
| L2 | `MA-6` yêu cầu "CRITICAL ≥ 100" | **Đã thoả mãn.** Đếm thực tế trong `invariants.yaml`: **113 CRITICAL, 31 HIGH, 0 MEDIUM** (tổng 144). Không cần sửa MA-6; chỉ ghi lại con số làm baseline. |

---

## 2. Stack & quy ước (chốt trước khi code)

| Hạng mục | Lựa chọn | Lý do |
|---|---|---|
| Runtime | Node.js 20 LTS | `PLATFORM_SUPPORT.md §11.3` |
| Ngôn ngữ | TypeScript (strict, ESM) | `DOMAIN_CONTRACTS.md`, dependency-cruiser |
| Monorepo | npm workspaces | `INFRASTRUCTURE_SPEC.md §` dùng `npm ci`; không cần pnpm cho v1 |
| Test runner | **Vitest** | TS-native, ESM, nhanh, deterministic; chạy tốt trên Windows + WSL2 |
| Hash chính | Blake3 qua `@noble/hashes` (thuần JS, cross-platform) | tránh native addon lệch nền tảng; `WORKSPACE_SPEC §5.2` default blake3 |
| Hash file | SHA-256 qua `node:crypto` | `WORKSPACE_SPEC §6.5` |
| ID | ULID (`ulidx` hoặc tự impl) | `DOMAIN_CONTRACTS §1.2` |
| Dep check | dependency-cruiser | `INFRASTRUCTURE_SPEC §`, DC-001..005 |
| Lint | ESLint + typescript-eslint | CI-6, CI-7 |

Package layout (theo `PHASE_0_ACCEPTANCE §10.2`):

```
packages/
  agent-core/         # domain types, state-machine types, graph types, repo interfaces (C4-C7)
  infrastructure/     # workspace-hash (C1), workspace-revision (C2), path (C3)
  testing/            # fake-model (C9), adversarial (C8), harness (C10)
tests/
  invariants/ workspace/ cross-platform/ adversarial/ state-machine/ graph/ contracts/ _harness/
.github/workflows/    # CI1-CI5
```

> Lưu ý: Node/TS/CI phải chạy **trong WSL2 filesystem** (`/home/...`), không phải `/mnt/c/`
> (`PLATFORM_SUPPORT §3.3`). Trên Windows native chạy qua PowerShell 7.

---

## 3. Hai mốc: Minimum Viable vs Full

### 3.1 Minimum Viable Phase 0 (đủ để bắt đầu Phase 1 an toàn)

Mục tiêu: **hash cross-platform ổn định + path canonicalization ổn + có thể test không cần LLM.**

| Ref | Deliverable | Bắt buộc |
|---|---|---|
| A0 | ✅ **DONE** — L1 đã sửa (PHASE_0_ACCEPTANCE v1.1, 2 OS). L2 xác nhận (113 CRITICAL ≥ 100). | ✅ |
| Setup | ✅ **DONE** — Monorepo (npm workspaces), tsconfig strict ESM + project refs, Vitest, ESLint flat, dependency-cruiser, CI workflows. typecheck/test/lint/depcruise đều xanh. | ✅ |
| C1 | ✅ **DONE** — `packages/infrastructure/src/workspace-hash` (walk + canonical-line + blake3/sha256). 17 test pass (empty/single/nested, CRLF≠LF, NFC=NFD, scratch exclude, empty-dir, no-false-negative, symlink). Full 20 binary vectors = A3 (kế tiếp). | ✅ |
| C3 | ✅ **DONE** — `packages/infrastructure/src/path` (canonicalize lexical + realpath + case-sensitivity). 29 test (PC-1..PC-10) pass. | ✅ |
| C2 | ✅ **DONE** — domain type `WorkspaceRevision` + `isFresh` (agent-core), factory `computeWorkspaceRevision` (infrastructure, bind C1), ULID primitive (injectable time/random). 20 test (WR-1..WR-10 + ULID) pass. | ✅ |
| C9 | FakeModel | ✅ |
| A3 | ✅ **DONE + cross-platform PROVEN** — 20 vector + builder + generator; `manifest.json` + **20/20 `expected.json`** (17 Windows + 3 linux-only v016/v019/v020 sinh trong WSL2 Ubuntu-24.04). **Hash khớp byte-cho-byte Windows↔Linux** cho toàn bộ vector chung (verify thực tế trong WSL: 96 test pass, ws-001 "matches committed expected.json" pass trên ext4 case-sensitive). Phát hiện + sửa 1 bug thực (symlink absolute target không reproducible → relative). | ✅ |
| T2 | Hash/revision tests (CH-1..CH-20) | ✅ |
| T3 | Cross-platform run (Windows + WSL2) | ✅ |
| T-WS | ✅ **DONE** — `tests/invariants/workspace/ws-001,002,007,009.spec.ts` (16 test), header `@invariant`, path khớp `invariants.yaml`. Tất cả pass. | ✅ |
| CI1, CI2 | `invariants.yml` + `workspace-vectors.yml` trên 2 OS | ✅ |

**Định nghĩa hoàn thành:** CI xanh trên windows-latest + ubuntu-latest; 20 vector cho cùng hash
trên cả hai; WS-001/002/007/009 pass; không test flaky.

### 3.2 Full Phase 0 (đủ để freeze architecture + sign-off)

Minimum + phần còn lại:

| Ref | Deliverable |
|---|---|
| C4–C7 | Domain types (20 entity), state-machine types (10), graph types, repository interfaces (6) |
| C8 | AdversarialModel interface + 7 variants |
| C10 | Test harness runner (`Phase0Harness`) + crash-injector interface |
| A4 | `scenarios.yaml` (≥ 5 scenario) |
| A5 | `phase_0_checklist.yaml` |
| T1 | Invariant tests cho toàn bộ CRITICAL Phase ≤ 0..1.5 khả thi không cần runtime thật |
| T4 | Adversarial tests (7 variant × scenario) |
| T5, T6 | State-machine + graph tests (skeleton conformance) |
| T7 | Contract/type-conformance tests (DT-1..DT-20, RI, SM, GR) |
| CI3–CI5 | `adversarial.yml`, `contracts.yml`, `dependency-direction.yml` |
| Sign-off | `PHASE_0_SIGNOFF.md` theo `PHASE_0_ACCEPTANCE §9.2` |

---

## 4. Lịch trình (tuần)

Ước lượng cho 1 người làm chính. Song song hoá nếu có nhiều người.

```
Tuần 1 — Nền tảng + critical path
  A0   Chốt L1 (sửa PHASE_0_ACCEPTANCE về 2 OS)                   [0.5 ngày]
  SETUP Monorepo, tsconfig strict, vitest, eslint, dep-cruiser    [1 ngày]
  C3   Path canonicalizer (+ unit test PC-1..PC-10)               [1.5 ngày]
  C1   Canonical hash impl (theo WORKSPACE_SPEC §6.2)             [2 ngày]

Tuần 2 — Vectors + cross-platform + revision
  A3   20 binary workspace vectors + manifest.json + expected.json[2 ngày]
  T2   CH-1..CH-20 tests, chạy local Windows + WSL2               [1.5 ngày]
  C2   WorkspaceRevision impl + WR-1..WR-10                       [1 ngày]
  T-WS WS-001/002/007/009 invariant tests                        [0.5 ngày]

Tuần 3 — FakeModel + CI + Minimum sign-off
  C9   FakeModel deterministic (FM-1..FM-8)                       [1.5 ngày]
  CI1  invariants.yml (2 OS)                                      [0.5 ngày]
  CI2  workspace-vectors.yml (2 OS)                               [0.5 ngày]
  BUG  Sửa lệch Windows vs WSL2 phát hiện qua CI                  [1.5 ngày]
  ───────── Minimum Viable Phase 0 COMPLETE ─────────

Tuần 4+ — Phase 1 (Runtime Kernel) BẮT ĐẦU, song song Full Phase 0
  C4-C7 Domain/state-machine/graph types + repo interfaces        [3-5 ngày]
  C8   AdversarialModel + 7 variants                              [2 ngày]
  C10  Test harness runner + crash-injector interface             [2 ngày]
  A4   scenarios.yaml   A5 phase_0_checklist.yaml                 [1 ngày]
  T1   Invariant tests còn lại (theo phase khả thi)               [1-2 tuần]
  T4-T7 Adversarial + state-machine + graph + contract tests      [1-2 tuần]
  CI3-CI5                                                          [2-3 ngày]
  Sign-off PHASE_0_SIGNOFF.md                                     [0.5 ngày]
```

**Minimum Viable: ~3 tuần. Full: ~6–8 tuần** (một phần chạy song song Phase 1).

**Critical path:** `C3 → C1 → A3(vectors) → T2 → CI`. Nếu C1 sai, mọi thứ sau sai.

---

## 5. Chi tiết từng deliverable cốt lõi

### 5.1 C1 — Canonical hash (`packages/infrastructure/src/workspace-hash`)

Nguồn chuẩn: `WORKSPACE_SPEC §6`.

Yêu cầu bắt buộc:
- Walk root, canonical relpath `/`-separated, UTF-8 **NFC** normalized.
- Loại `excludedScratchPaths` (prefix match trên canonical path, không glob).
- Canonical line: `<type>\t<relpath>\t<payload>\n`; FILE payload = `<size>\0<sha256-content>`;
  SYMLINK = target string (không follow); DIR = empty (empty dir vẫn tính).
- Escape trong relpath: `\n→\\n`, `\t→\\t`, `\0→\\0`, `\\→\\\\`.
- **Không** normalize line ending trong content hash (EOL là thay đổi thật).
- File mode **không** vào hash (v1) — cross-platform (Windows không có POSIX mode).
- Symlink ngoài root → SKIP + WARN (không đưa content vào hash).
- Streaming SHA-256 cho file (không load > 16 MB vào RAM).
- Hash tổng dùng blake3 (default) trên chuỗi canonical lines.

Enforce invariant: **WS-001** (canonical, cross-platform), **WS-002** (no false negative),
**WS-009** (không phụ thuộc Git).

Rủi ro cao nhất: **NFC normalization** và **path separator** phải giống nhau trên Windows/WSL2.
→ bắt buộc test bằng binary fixtures ngay từ đầu.

### 5.2 C3 — Path canonicalizer (`packages/infrastructure/src/path`)

Nguồn chuẩn: `WORKSPACE_SPEC §3`, `PLATFORM_SUPPORT §5`.

- `canonical = realpath(normalize(absolutize(path, root)))`.
- Reject: `..` escape, absolute ngoài root, symlink target ngoài root, symlink loop
  (`MAX_SYMLINK_DEPTH`), null byte.
- Windows: reject UNC `\\server\share`, long-path prefix `\\?\`, reserved names
  (`CON/PRN/AUX/NUL/COM1-9/LPT1-9`).
- Separator: input `\` hoặc `/` → canonical `/`.
- Case sensitivity: **detect tại runtime** (`detectCaseSensitivity`), không hardcode; case
  collision trên FS case-insensitive → reject.

Enforce: **WS-003, WS-004**, PC-1..PC-10.

### 5.3 C2 — WorkspaceRevision (`packages/infrastructure/src/workspace-revision`)

Nguồn: `WORKSPACE_SPEC §5`, `DOMAIN_CONTRACTS §` (WorkspaceRevision). Bind C1.
- `revisionId` ULID immutable; `hash` từ C1; `gitMetadata` optional (informational only).
- `isFresh(report, current)` = so hash + canonicalFormVersion (khớp `VERIFICATION_PROTOCOL §5.1(a)`).

### 5.4 C9 — FakeModel (`packages/testing/src/fake-model`)

Nguồn: `EVALUATION_MODEL §5`, `PHASE_0_ACCEPTANCE §3.12`.
- Implements interface `ModelGateway` (dạng contract, chưa cần gateway thật).
- `setResponse/setSequence/setError/setDelay`, `callCount`, `history`.
- **Deterministic**: không random, không wall-clock. Không gọi Ollama.

### 5.5 A3 — 20 workspace vectors (`tests/workspace/vectors/`)

Nguồn: `WORKSPACE_SPEC §7`. Mỗi vector là **binary fixture** (tarball hoặc base64), kèm
`expected.json` (`expectedHash`, `expectedFileCount`, `expectedBytes`, notes). 20 vector
v001..v020 gồm: empty, single-file, nested, CRLF, LF, mixed EOL, NFC, NFD, symlink internal,
symlink external, scratch zone, empty dir, spaces, unicode name, case collision, large file,
many files, permissions, special chars.

`manifest.json` liệt kê toàn bộ vector cho harness/CI.

---

## 6. Cross-platform & CI

CI matrix (theo `PLATFORM_SUPPORT §11.1` — **2 OS, không macOS**):

```yaml
strategy:
  fail-fast: false
  matrix:
    include:
      - os: windows-latest   # NTFS, CRLF, case-insensitive
        shell: pwsh
      - os: ubuntu-latest    # ext4, LF, case-sensitive (đại diện WSL2)
        shell: bash
```

- **CI1 `invariants.yml`**: chạy invariant tests (2 OS).
- **CI2 `workspace-vectors.yml`**: chạy 20 vector, assert cùng hash cả 2 OS (2 OS).
- **CI3 `adversarial.yml`**: harness adversarial (ubuntu).
- **CI4 `contracts.yml`**: `tsc --noEmit` + type-conformance (ubuntu).
- **CI5 `dependency-direction.yml`**: dependency-cruiser DC-001..005 (ubuntu).

Yêu cầu: CI < 10 phút; không TS error; không ESLint error; không dep-cruiser warning
(`PHASE_0_ACCEPTANCE §3.15`).

---

## 7. Cạm bẫy (bắt buộc tránh)

1. **Viết test rỗng trước implementation.** Đúng: impl C1/C3 → test C1/C3 → pass → sang invariant
   khác. Sai: sinh 144 file test rỗng rồi mới code.
2. **Cố làm Full Phase 0 trước khi có Phase 1.** Làm Minimum trước, Phase 1 sẽ lộ design issue →
   cần sửa spec → tránh làm lại Full vô ích.
3. **Bỏ qua một OS.** Test cả Windows + WSL2 **từ đầu**, không để một OS "làm sau".
4. **Dùng Git checkout cho fixtures.** Autocrlf làm hash flaky → dùng binary fixtures.
5. **Native hash addon.** blake3 native addon có thể lệch build giữa Windows/WSL2 → dùng thuần JS
   (`@noble/hashes`) trừ khi đã đo và pin.
6. **Project trong `/mnt/c/`.** Chậm + case-insensitive kế thừa Windows → đặt trong `/home/`.

---

## 8. Ánh xạ tới tiêu chí nghiệm thu

| Roadmap task | PHASE_0_ACCEPTANCE criteria |
|---|---|
| C1 + T2 | CH-1..CH-20, WR-3 |
| C1 cross-platform | XP-1, XP-3, XP-4 (2 OS sau khi sửa L1) |
| C3 | PC-1..PC-10, XP-5, XP-6 |
| C2 | WR-1..WR-10 |
| C4–C7 | DT-1..DT-20, SM-1..SM-8, GR-1..GR-5, RI-1..RI-8 |
| C8 | AM-1..AM-10 |
| C9 | FM-1..FM-8 |
| T1 + T-WS | IT-1..IT-8 |
| CI5 | DD-1..DD-6 |
| CI1-2 | XP-1..XP-6, CI-1..CI-7 |

---

## 9. Bước kế tiếp đề xuất

Bắt đầu ngay theo critical path:

1. **A0** — chốt L1: sửa `PHASE_0_ACCEPTANCE.md` về 2 OS (bỏ macOS). (L2 đã xác nhận: 113 CRITICAL.)
2. **SETUP** — monorepo skeleton (npm workspaces, tsconfig strict ESM, vitest, eslint, dep-cruiser).
3. **C3** — path canonicalizer + unit test.
4. **C1** — canonical hash, kèm 3–4 vector đầu tiên để kiểm chứng ngay.

Sau khi C1 chạy đúng trên cả Windows + WSL2 với vài vector → mở rộng đủ 20 vector → CI → chốt
Minimum Viable → bắt đầu Phase 1.

---

## 10. North Star

> **Phase 0 xong khi một người mới clone repo, chạy `npm test` trên Windows và WSL2, và test tự
> nói cho họ biết contract đúng hay sai — mà không cần chạy LLM, tool, hay agent loop nào.**
