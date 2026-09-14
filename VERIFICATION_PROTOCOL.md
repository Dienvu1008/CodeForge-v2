# VERIFICATION_PROTOCOL.md

**Ollama Coding Agent — Verification Scope, Freshness, Evidence & Completion**

Version: 1.0
Status: Architecture Baseline
Owner: Verification Plane / VerificationEngine
Scope: v1 (single user, single workspace, sequential, local)
Related specs:
`INVARIANTS.md` (VR-*, TI-*, WS-*, CP-*), `DOMAIN_CONTRACTS.md`,
`WORKSPACE_SPEC_v1.0`, `STATE_MACHINE_SPEC.md`, `GRAPH_PROTOCOL.md`,
`MIGRATION_SPEC.md`

---

## 0. Mục đích

Verification là **authority duy nhất** quyết định một Task có đạt acceptance criteria hay không.

Nguyên tắc:

> **Completion means verified outcome, not model confidence.**

File này định nghĩa:

- Verification model;
- Scope lattice;
- Deterministic affected set;
- Freshness binding với WorkspaceRevision;
- VerificationReport format;
- Scratch zone interactions;
- Human override;
- Completion gate;
- Invariant mapping;
- Test matrix;
- Adversarial cases.

LLM có thể **propose** verification strategy. LLM **không được** quyết định:

- scope;
- freshness;
- completion;
- report status.

Tham chiếu: `INVARIANTS.md` → **VR-001..VR-011, TI-005, TI-006, SE-002**.

---

## 1. Nguyên tắc nền tảng

### 1.1 Verification là evidence, không phải opinion

- Verification output là **VerificationReport** với status rõ ràng.
- Không có "probably pass", "looks correct", "should be fine".
- Report gắn với revision cụ thể.

### 1.2 Binding với WorkspaceRevision

- Mọi verification phải bind với một `WorkspaceRevision`.
- Report không bind với revision → invalid.
- Revision không khớp hiện tại → stale.

### 1.3 Determinism

- Scope computation deterministic.
- Check execution deterministic (với cùng input).
- Không phụ thuộc LLM.

### 1.4 Immutability

- VerificationReport append-only.
- Không sửa report sau commit.
- Human override tạo record mới, không sửa report.

### 1.5 LLM không phải verifier

LLM có thể:

- suggest checks;
- interpret failure output;
- propose additional tests.

LLM **không** được:

- nói "PASS";
- skip check;
- chọn scope;
- đánh dấu completion.

### 1.6 Verification không mutate source

- Verification chỉ được mutate **declared scratch zones**.
- Mutation ngoài scratch → report INVALID.

Tham chiếu: `INVARIANTS.md` → **VR-001, VR-003, VR-005, VR-006, VR-007, VR-008, VR-010, VR-011**.

---

## 2. Verification Model

### 2.1 VerificationReport

```typescript
interface VerificationReport {
  verificationId: string;       // ULID
  sessionId: string;
  taskId: string;
  taskRunId: string;

  targetWorkspaceRevision: WorkspaceRevision;
  canonicalFormVersion: string;

  scope: VerificationScope;
  checks: VerificationCheck[];

  status: VerificationStatus;

  startedAt: string;
  endedAt: string;

  toolVersions: Record<string, string>;
  artifacts: string[];          // artifactIds

  scratchZones: ScratchZone[];  // declared at start

  invariantsChecked: InvariantCheck[];

  schemaVersion: number;
  canonicalFormVersion: string;
}

type VerificationStatus =
  | 'PASS'
  | 'FAIL'
  | 'INVALID'      // scratch violation, revision mismatch
  | 'ERROR';       // infrastructure error
```

### 2.2 VerificationCheck

```typescript
interface VerificationCheck {
  checkId: string;              // ULID
  kind: CheckKind;
  name: string;

  command: string;
  args: string[];

  scope: VerificationScope;     // scope áp dụng cho check này

  exitCode: number;
  durationMs: number;

  status: CheckStatus;

  outputArtifactId?: string;
  stderrArtifactId?: string;

  affectedPaths?: string[];

  executedBy: 'deterministic' | 'user_approved';
}

type CheckKind =
  | 'test'
  | 'lint'
  | 'typecheck'
  | 'build'
  | 'format'
  | 'custom';

type CheckStatus =
  | 'PASS'
  | 'FAIL'
  | 'SKIP'
  | 'ERROR';
```

### 2.3 VerificationScope

```typescript
type VerificationScope =
  | 'FULL'
  | 'AFFECTED_CLOSURE'
  | 'AFFECTED_DIRECT'
  | 'SMOKE';

const SCOPE_LATTICE: Record<VerificationScope, number> = {
  FULL: 4,
  AFFECTED_CLOSURE: 3,
  AFFECTED_DIRECT: 2,
  SMOKE: 1,
};
```

Thứ tự lattice: `FULL > AFFECTED_CLOSURE > AFFECTED_DIRECT > SMOKE`.

### 2.4 InvariantCheck

```typescript
interface InvariantCheck {
  invariantId: string;          // e.g., "VR-001"
  satisfied: boolean;
  evidence?: string;
}
```

Report phải self-check các invariant liên quan để audit.

---

## 3. Verification Scope Lattice

### 3.1 Định nghĩa

| Scope | Bao gồm |
|---|---|
| **FULL** | Toàn bộ test suite của workspace |
| **AFFECTED_CLOSURE** | Transitive closure của affected set + tests phụ thuộc |
| **AFFECTED_DIRECT** | Tests trực tiếp của file thay đổi |
| **SMOKE** | Chỉ build + smoke test tối thiểu |

### 3.2 Lattice relations

```
FULL
 │ ⊇
AFFECTED_CLOSURE
 │ ⊇
AFFECTED_DIRECT
 │ ⊇
SMOKE
```

- Scope cao hơn bao gồm scope thấp hơn.
- Không được mix scope một cách tùy tiện.
- Verification report có 1 scope duy nhất.

### 3.3 Khi nào dùng scope nào

| Context | Minimum scope |
|---|---|
| Task level verification (mỗi task) | AFFECTED_DIRECT |
| Final graph verification | AFFECTED_CLOSURE |
| Release / user yêu cầu | FULL |
| Smoke test cho task nhỏ | SMOKE (nếu policy cho phép) |

Tham chiếu: `INVARIANTS.md` → **VR-004, VR-010**.

### 3.4 Scope promotion

Scope có thể được **promote** (SMOKE → AFFECTED_DIRECT → AFFECTED_CLOSURE → FULL) khi:

- AFFECTED set > threshold (ví dụ > 50% workspace);
- Policy yêu cầu;
- User yêu cầu.

Scope **không** được demote.

#### Phạm vi của quy tắc "no demotion"

"No demotion" áp dụng **trong một chu trình verification của một task tại một revision**: một khi
scope đã được xác định/promote cho lần verify đó, không được hạ xuống thấp hơn để "lách" completion.

Nó **không** phải quy tắc toàn cục cấm các task khác nhau có required scope khác nhau:

- Mỗi task có `requiredScope` riêng theo §10.2 (task nhỏ có thể SMOKE, task thường AFFECTED_DIRECT).
- Khi **replanning gộp/tách task**, task mới có identity mới (SUPERSEDE, xem GRAPH_PROTOCOL §6)
  và `requiredScope` được **tính lại** từ đầu bằng `computeScope` cho task mới. Đây **không** phải
  demotion của cùng một task — nó là scope của một task khác.
- Ràng buộc an toàn vẫn giữ: **final graph verification** luôn ≥ AFFECTED_CLOSURE (VR-004), bất kể
  các task con dùng scope nào. Việc một task con dùng scope thấp không làm giảm scope của final
  verification.

### 3.5 Scope computation

```
computeScope(task, workspace, policy) -> VerificationScope
```

Deterministic. Không có LLM.

Xem §4 cho affected set.

---

## 4. Affected Set Computation

### 4.1 Mục tiêu

Xác định **deterministic** các file/symbol bị ảnh hưởng bởi một thay đổi.

### 4.2 Input

- `taskRun.workspaceRevisionAtStart`;
- `taskRun.workspaceRevisionAtEnd`;
- `task.strategy`;
- `policy`.

### 4.3 Baseline (Phase 1.5)

Khi chưa có Tree-sitter/LSP (Phase 6):

Affected set = **direct diff** giữa `atStart` và `atEnd`:

```
affectedDirect = { path | path ∈ diff(atStart, atEnd) }
```

- Chỉ tính file trong protected set (không scratch).
- Không follow import graph.
- Đây là **AFFECTED_DIRECT**.

### 4.4 AFFECTED_CLOSURE (Phase 1.5 fallback)

Fallback khi chưa có symbol graph:

```
affectedClosure = affectedDirect
                ∪ { path | path là test file match affectedDirect }
                ∪ { path | path là file được affectedDirect import (1 hop) }
```

Import 1 hop lấy từ heuristic (regex import statements) nếu chưa có AST.

### 4.5 AFFECTED_CLOSURE (Phase 6, full)

Khi có Tree-sitter + LSP:

```
affectedClosure = transitive closure của import graph
                  ∪ test files map tới affected symbols
```

- Build symbol graph từ workspace.
- Compute reverse dependency.
- Map symbol → test.

### 4.6 Determinism rule

- Cùng input → cùng affected set.
- Không dùng LLM để chọn affected set.
- Không dùng heuristic không xác định (ví dụ random sample).

### 4.7 Threshold

Nếu `|affectedClosure| / |testable paths| > threshold`:

- Promote scope lên FULL.
- Threshold mặc định: 0.5.
- Policy có thể override.

Tham chiếu: `INVARIANTS.md` → **VR-010**.

---

## 5. Freshness

### 5.1 Freshness rule

Tách rõ **hai** khái niệm để tránh nhầm lẫn (trước đây `isFresh` và `valid()` định nghĩa
khác nhau giữa các spec):

**(a) `isFresh` — chỉ về revision binding.** Đây là định nghĩa dùng chung với
`WORKSPACE_SPEC §13.1` (cùng semantics, cùng tên gọi):

```
isFresh(report, currentRevision) =
     report.targetWorkspaceRevision.hash
       == currentRevision.hash
  ∧ report.targetWorkspaceRevision.canonicalFormVersion
       == currentRevision.canonicalFormVersion
```

Nếu fail → **stale** (revision đã đổi). `isFresh` **không** xét status.

**(b) `isUsableForCompletion` — fresh ∧ có kết luận.** Điều kiện để evidence dùng cho
completion gate:

```
isUsableForCompletion(report, currentRevision) =
     isFresh(report, currentRevision)
  ∧ report.status ∈ { PASS, FAIL }
```

Report `INVALID`/`ERROR` là fresh (nếu revision khớp) nhưng **không** usable để complete.

Quy tắc: dùng `isFresh` cho câu hỏi "evidence còn gắn đúng revision không?"; dùng
`isUsableForCompletion` (và cụ thể `status == PASS`) trong Completion Gate (§10).

### 5.2 Freshness check

VerificationEngine phải check freshness **tại thời điểm**:

- report commit;
- task completion;
- graph completion;
- checkpoint.

### 5.3 Stale evidence

- Stale evidence **không được** dùng để complete task (VR-002).
- Nếu task đã PASSED với stale evidence → không tự revert; emit event `EVIDENCE_STALE`, đánh dấu cần re-verify.
- Nếu task đang VERIFYING với stale evidence → reject transition sang PASSED.

### 5.4 Freshness window

- Freshness không có TTL. Chỉ phụ thuộc revision.
- Revision thay đổi → stale ngay lập tức.
- Revision không đổi → fresh vô thời hạn.

### 5.5 Revision computation timing

- Revision computed **trước** verification start.
- Revision computed **sau** verification end (để detect scratch violation).
- Nếu revision trước ≠ revision sau (ngoài scratch) → INVALID.

Tham chiếu: `INVARIANTS.md` → **VR-001, VR-002, VR-007, VR-011**.

---

## 6. Verification Pipeline

### 6.1 Pipeline

```
Task
 │
 ▼
VerificationPolicy (deterministic)
 │
 ▼
Compute Scope
 │
 ▼
Compute Affected Set
 │
 ▼
Declare Scratch Zones
 │
 ▼
Capture Revision R_before
 │
 ▼
Execute Checks
 │
 ▼
Capture Revision R_after
 │
 ▼
Validate:
   - R_before == R_after (non-scratch)
   - No mutation outside scratch
   - Checks executed as planned
 │
 ▼
Build VerificationReport
 │
 ▼
Commit (append-only)
```

### 6.2 Policy computation

`VerificationPolicy` quyết định:

- scope minimum;
- checks cần chạy;
- tool versions;
- timeout;
- fail-fast hay continue-on-fail.

Deterministic. Không có LLM.

### 6.3 Check execution

- Check chạy trong subprocess qua ProcessSupervisor.
- Environment theo allowlist.
- Timeout per check.
- stdout/stderr ghi artifact.

### 6.4 Fail-fast vs continue

- **Fail-fast**: dừng khi check đầu tiên fail (mặc định cho scope nhỏ).
- **Continue-on-fail**: chạy hết để có full picture (mặc định cho FULL).

Policy quyết định.

### 6.5 Report construction

Report bao gồm:

- tất cả checks đã chạy;
- checks bị SKIP (với lý do);
- revision before/after;
- scratch zones declared;
- artifacts;
- tool versions;
- invariant checks.

### 6.6 Report validation

Trước khi commit:

- Schema valid.
- Revision before == revision after (non-scratch).
- Không có check nào missing.
- Không có mutation ngoài scratch.
- Nếu fail → INVALID.

Tham chiếu: `INVARIANTS.md` → **VR-003, VR-008, VR-009**.

---

## 7. Scratch Zone Interaction

### 7.1 Declaration

Trước verification start:

- Declare scratch zones.
- Scratch zones không được thay đổi giữa verification.
- Nếu cần thay đổi → verification INVALID.

### 7.2 Enforcement

- Mọi mutation trong verification phải nằm trong scratch.
- Mutation ngoài scratch → verification INVALID.
- Track qua ChangeRecord với `ownedBy: 'verification'`.

### 7.3 Post-verification check

Sau verification end:

- Compute revision R_after.
- So sánh với R_before.
- Nếu khác (ngoài scratch) → INVALID.

### 7.4 Cleanup

- Scratch cleanup theo lifecycle (§4.4 WORKSPACE_SPEC).
- Cleanup không tạo revision mới.

Tham chiếu: `INVARIANTS.md` → **VR-003, VR-008, WS-007**.

---

## 8. Verification Check Types

### 8.1 test

- Chạy test framework.
- Exit code 0 = PASS.
- Exit code ≠ 0 = FAIL.
- Timeout = ERROR.

### 8.2 lint

- Chạy linter.
- Exit code 0 = PASS.
- Warning có thể PASS hoặc FAIL theo policy.
- Error = FAIL.

### 8.3 typecheck

- Chạy typechecker.
- Exit code 0 = PASS.
- Type error = FAIL.

### 8.4 build

- Chạy build.
- Exit code 0 = PASS.
- Build error = FAIL.

### 8.5 format

- Chạy formatter check.
- Exit code 0 = PASS.
- Không tự format (formatting mutation phải qua tool call riêng).

### 8.6 custom

- Check do policy định nghĩa.
- Phải có schema rõ ràng.
- Phải deterministic.

---

## 9. Verification Policy

### 9.1 Policy structure

```typescript
interface VerificationPolicy {
  policyId: string;
  version: number;

  scopeRules: ScopeRule[];

  checks: CheckDefinition[];

  failFast: boolean;
  timeoutMs: number;

  scratchZones: ScratchZone[];

  affectedClosureThreshold: number;   // default 0.5

  allowSmokeForSmallTasks: boolean;
  smokeThresholdLines: number;        // default 20

  requiredTools: string[];
  toolVersionPolicy: 'allow_any' | 'pin' | 'minimum';

  language?: string;                  // 'typescript' | 'dart' | ...
}
```

### 9.2 Policy resolution

```
resolvePolicy(task, workspace, session) -> VerificationPolicy
```

Deterministic. Policy có thể phụ thuộc:

- language detection;
- task.strategy.kind;
- session config;
- user config.

Không phụ thuộc LLM.

### 9.3 Policy change

- Policy có version.
- Nếu policy thay đổi giữa task runs → task mới cần re-verify.
- Policy change phải ghi event.

Tham chiếu: `INVARIANTS.md` → **VR-004, VR-009, VR-010**.

---

## 10. Completion Gate

### 10.1 Completion rule

```
complete(task) =
     task.acceptanceCriteria satisfied
  ∧ report.status == PASS
  ∧ isFresh(report, currentRevision)
  ∧ report.scope >= requiredScope(task)
  ∧ allMandatoryInvariantsSatisfied(report)
  ∧ policy_satisfied(task)
  ∧ budget_ok
```

Nếu bất kỳ điều kiện nào fail → không complete.

### 10.2 Required scope per task

- Task thường: AFFECTED_DIRECT.
- Task final trong graph: AFFECTED_CLOSURE.
- Task ảnh hưởng nhiều: FULL.
- Task nhỏ (≤ threshold lines): SMOKE (nếu policy cho phép).

Policy quyết định.

### 10.3 Re-verification

Nếu workspace revision thay đổi sau verify:

- Report stale.
- Task cần re-verify.
- Nếu task đã PASSED → đánh dấu `NEEDS_REVERIFY` (không tự revert).
- Nếu task đang VERIFYING → reject PASSED.

### 10.4 Completion events

- `TASK_STATE_CHANGED` từ VERIFYING → PASSED.
- `EVIDENCE_STALE` nếu revision thay đổi sau PASSED.
- `TASK_REVERIFY_REQUIRED` nếu cần re-verify.

Tham chiếu: `INVARIANTS.md` → **VR-002, VR-004, VR-005, VR-011, TI-005**.

---

## 11. Human Override

### 11.1 HUMAN_OVERRIDE_COMPLETED

Khi user override completion:

```typescript
interface HumanOverride {
  overrideId: string;
  taskId: string;
  verificationId: string;       // reference, không sửa

  reason: string;
  decidedBy: 'user';
  decidedAt: string;

  // Marker, không thay đổi report
  kind: 'HUMAN_OVERRIDE_COMPLETED';
}
```

### 11.2 Rules

- Override **không** sửa VerificationReport.
- Override tạo record mới, link tới report.
- Task chuyển PASSED với marker `overridden: true`.
- Report gốc vẫn queryable.
- Audit trail bảo toàn.

### 11.3 Override visibility

- UI phải hiển thị rõ task đã override.
- Event `HUMAN_OVERRIDE_COMPLETED` phải được emit.
- Không được ẩn.

Tham chiếu: `INVARIANTS.md` → **VR-005, HI-003, HI-004**.

---

## 12. Verification và Graph

### 12.1 Final graph verification

Sau khi mọi task PASSED:

- Final verification với scope ≥ AFFECTED_CLOSURE.
- Bind với revision hiện tại.
- Nếu fail → graph không complete.

### 12.2 Re-verification sau graph mutation

- Graph mutation không invalidate task verification.
- Nhưng nếu mutation thay đổi revision → report stale.
- Task cần re-verify.

### 12.3 Verification trong replanning

- Replanner có thể yêu cầu verify lại.
- Verification mới bind với revision mới.
- Không reuse report cũ.

Tham chiếu: `INVARIANTS.md` → **VR-004, VR-011, GI-002**.

---

## 13. Verification và Scheduler

### 13.1 Verification không block scheduler

- Scheduler vẫn schedule task khác khi task này VERIFYING.
- Không có global lock.

### 13.2 Verification timeout

- Nếu verification vượt budget → ERROR.
- Task chuyển FAILED với failure class TIMEOUT.
- Recovery policy quyết định.

### 13.3 Verification failure

- Report FAIL → Task FAILED.
- Task chuyển FAILURE_ANALYZED.
- Recovery policy.

Tham chiếu: `INVARIANTS.md` → **BU-001, RC-001**.

---

## 14. Verification và Budget

### 14.1 Budget allocation

- Verification có budget riêng.
- Budget không vượt parent remaining.
- Budget bao gồm: wall-clock, tool calls.

### 14.2 Budget exhaustion

- Nếu verification vượt budget → ERROR.
- Không tự động retry vô hạn.
- Recovery policy.

### 14.3 Reporting

- Report ghi `durationMs`.
- Budget consumption ghi vào session budget.

Tham chiếu: `INVARIANTS.md` → **BU-001, BU-005**.

---

## 15. Verification Persistence

### 15.1 Schema

```sql
CREATE TABLE verification_reports (
  verification_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  task_run_id TEXT NOT NULL,

  target_revision_id TEXT NOT NULL,
  target_revision_hash TEXT NOT NULL,
  canonical_form_version TEXT NOT NULL,

  scope TEXT NOT NULL,
  status TEXT NOT NULL,

  started_at TEXT NOT NULL,
  ended_at TEXT NOT NULL,

  report_json TEXT NOT NULL,
  schema_version INTEGER NOT NULL
);

CREATE TABLE verification_checks (
  check_id TEXT PRIMARY KEY,
  verification_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  command TEXT NOT NULL,
  status TEXT NOT NULL,
  exit_code INTEGER,
  duration_ms INTEGER,
  output_artifact_id TEXT,
  FOREIGN KEY (verification_id) REFERENCES verification_reports(verification_id)
);

CREATE INDEX idx_verif_task ON verification_reports(task_id);
CREATE INDEX idx_verif_revision ON verification_reports(target_revision_id);
CREATE INDEX idx_verif_status ON verification_reports(status);
```

### 15.2 Append-only

- Report insert only.
- Không update.
- Không delete.

### 15.3 Query

- Latest report cho task.
- Latest report cho revision.
- Report history cho task.

Tham chiếu: `INVARIANTS.md` → **VR-006, PR-003**.

---

## 16. Verification Engine API

### 16.1 Interface

```typescript
interface VerificationEngine {
  verify(request: VerifyRequest): Promise<VerificationReport>;

  isFresh(report: VerificationReport, current: WorkspaceRevision): boolean;

  canComplete(taskId: string): Promise<CompletionCheck>;

  getReport(verificationId: string): Promise<VerificationReport | null>;

  listReports(taskId: string): Promise<VerificationReport[]>;
}

interface VerifyRequest {
  sessionId: string;
  taskId: string;
  taskRunId: string;

  targetRevision: WorkspaceRevision;
  policy: VerificationPolicy;

  reason: 'task_completion' | 'graph_final' | 'reverify' | 'user_request';
}

interface CompletionCheck {
  canComplete: boolean;
  reason?: string;
  requiredScope: VerificationScope;
  report?: VerificationReport;
}
```

### 16.2 Error codes

| Error | Khi nào |
|---|---|
| `REVISION_MISMATCH` | Revision không khớp |
| `SCRATCH_VIOLATION` | Mutation ngoài scratch |
| `POLICY_VIOLATION` | Policy không cho phép |
| `CHECK_TIMEOUT` | Check vượt timeout |
| `CHECK_ERROR` | Infrastructure error |
| `STALE_EVIDENCE` | Report stale |
| `SCOPE_INSUFFICIENT` | Scope < required |

---

## 17. Invariant Mapping

| Invariant | Enforcement |
|---|---|
| VR-001 | §1.2, §2.1 `targetWorkspaceRevision` |
| VR-002 | §5.3, §10.1 |
| VR-003 | §7 |
| VR-004 | §3.3, §10.2 |
| VR-005 | §11 |
| VR-006 | §15.2 |
| VR-007 | §6.1 pipeline |
| VR-008 | §7.3 |
| VR-009 | §2.1 toolVersions, artifacts |
| VR-010 | §3.5, §4.6 |
| VR-011 | §5.1 |
| TI-005 | §10.1 |
| TI-006 | §10.1 |
| SE-002 | §1.5 |
| BU-001 | §14.1 |
| BU-005 | §14.2 |
| WS-007 | §7 |
| HI-003 | §11.1 |
| HI-004 | §11.2 |
| CP-001 | §15 |

---

## 18. Test Matrix

### 18.1 Scope tests

| Test | Target |
|---|---|
| `scope-full` | FULL selected |
| `scope-affected-closure` | closure computed |
| `scope-affected-direct` | direct computed |
| `scope-smoke` | smoke selected |
| `scope-lattice-order` | FULL > CLOSURE > DIRECT > SMOKE |
| `scope-promotion-threshold` | auto-promote to FULL |
| `scope-no-demotion` | reject demotion |

### 18.2 Affected set tests

| Test | Target |
|---|---|
| `affected-direct` | diff-based |
| `affected-closure-imports` | closure with imports |
| `affected-closure-tests` | test files included |
| `affected-deterministic` | same input same output |
| `affected-excludes-scratch` | scratch excluded |
| `affected-threshold` | promote on large set |

### 18.3 Freshness tests

| Test | Target |
|---|---|
| `fresh-same-revision` | fresh |
| `stale-different-revision` | stale |
| `stale-canonical-version` | stale |
| `fresh-ignore-scratch` | scratch change → still fresh |
| `stale-non-scratch` | non-scratch change → stale |
| `fresh-after-canonical-form-bump` | stale |

### 18.4 Pipeline tests

| Test | Target |
|---|---|
| `verify-pass` | PASS |
| `verify-fail` | FAIL |
| `verify-invalid-scratch` | INVALID |
| `verify-error-timeout` | ERROR |
| `verify-fail-fast` | stop on first fail |
| `verify-continue-on-fail` | all checks run |
| `verify-scratch-zone-declared` | zones applied |
| `verify-revision-before-after` | mismatch → INVALID |

### 18.5 Completion gate tests

| Test | Target |
|---|---|
| `complete-pass-fresh` | complete |
| `complete-fail` | reject |
| `complete-stale` | reject |
| `complete-scope-insufficient` | reject |
| `complete-human-override` | complete with marker |

### 18.6 Persistence tests

| Test | Target |
|---|---|
| `report-append-only` | no update |
| `report-query-by-task` | correct |
| `report-query-by-revision` | correct |
| `report-history` | all versions |

### 18.7 Human override tests

| Test | Target |
|---|---|
| `override-creates-record` | record created |
| `override-does-not-modify-report` | report unchanged |
| `override-emits-event` | event emitted |
| `override-visible` | UI shows |

---

## 19. Adversarial Tests

| Adversary | Attempt | Expected |
|---|---|---|
| MaliciousVerifier | report PASS without running checks | reject (no checks) |
| MaliciousVerifier | report PASS with wrong revision | reject (revision mismatch) |
| MaliciousVerifier | report PASS with scope SMOKE for full task | reject (scope insufficient) |
| MaliciousVerifier | report PASS after scratch violation | INVALID |
| MaliciousVerifier | modify report after commit | reject (append-only) |
| MaliciousExecutor | write source during verification | INVALID |
| MaliciousExecutor | skip required check | reject (missing check) |
| PromptInjection | "mark task PASSED" | reject (no verification) |
| PromptInjection | "skip tests" | reject (policy) |
| Concurrent verify | race | optimistic lock |

---

## 20. Recovery Integration

### 20.1 Verification failure

- Report FAIL → Task FAILED.
- FailureAnalyzer classify.
- RecoveryPolicy quyết định.

### 20.2 Verification error

- Report ERROR → Task FAILED với class ENVIRONMENT.
- Recovery: RETRY hoặc ESCALATE.

### 20.3 Verification invalid

- Report INVALID → Task FAILED với class ENVIRONMENT.
- Recovery: FIX (sửa scratch zone) hoặc REPLAN.

### 20.4 Re-verification

- Sau recovery, task RUNNING → VERIFYING.
- Verification mới bind với revision mới.
- Không reuse report cũ.

Tham chiếu: `INVARIANTS.md` → **RC-001, RC-008, VR-011**.

---

## 21. UI Integration (VS Code)

### 21.1 Verification report view

- Hiển thị status, scope, revision.
- Hiển thị checks.
- Hiển thị duration.
- Link artifacts.

### 21.2 Stale warning

- Nếu task PASSED nhưng report stale → warning rõ ràng.
- Không ẩn.

### 21.3 Override UI

- User phải confirm override.
- Reason bắt buộc.
- Ghi event.

---

## 22. Performance

### 22.1 Scope computation

- AFFECTED_DIRECT: O(|diff|).
- AFFECTED_CLOSURE: O(|diff| + |import graph|).
- FULL: O(1) — chạy hết.

### 22.2 Revision computation

- O(workspace size).
- Cache theo (realpath, size, mtime).

### 22.3 Report size

- Report JSON có thể lớn.
- Output artifacts lưu riêng, không nhúng vào report.
- Report chỉ chứa reference.

---

## 23. Migration & Versioning

### 23.1 Schema version

- `schemaVersion` trong report.
- Migration versioned.
- Không xóa report cũ.

### 23.2 Canonical form version

- `canonicalFormVersion` cho revision hash.
- Report bind với canonical form version.
- Bump khi format hash thay đổi.

### 23.3 Policy version

- Policy có version.
- Policy change phải ghi event.
- Report bind với policy version.

---

## 24. Open Questions (Phase 0)

Các câu hỏi cần chốt:

1. **Fail-fast default**: theo scope hay theo policy?
2. **Scope promotion threshold**: 0.5 có hợp lý không?
3. **Import hop cho closure**: 1 hop đủ chưa khi chưa có AST?
4. **Smoke threshold lines**: 20 có hợp lý không?
5. **Tool version policy**: allow_any, pin, minimum?
6. **Verification timeout**: bao lâu là hợp lý?
7. **Scratch zone declaration**: user config hay agent propose?

---

## 25. North Star

> **Verification is evidence bound to a revision. Completion is a deterministic decision, not a model opinion.**

Mọi report, mọi scope, mọi freshness check tồn tại để trả lời:

- **Workspace nào** đang được verify?
- **Revision nào** là target?
- **Scope nào** đủ để complete?
- **Evidence nào** còn fresh?

---
