# MIGRATION_SPEC.md

**Ollama Coding Agent — Schema Versioning, Migration Flow & Compatibility**

Version: 1.0
Status: Architecture Baseline
Owner: infrastructure / MigrationEngine
Scope: v1 (single user, single workspace, sequential, local)
Related specs:
`INVARIANTS.md` (CP-*, PR-*, DC-*), `DOMAIN_CONTRACTS.md`,
`WORKSPACE_SPEC_v1.0`, `STATE_MACHINE_SPEC.md`, `GRAPH_PROTOCOL.md`,
`VERIFICATION_PROTOCOL.md`, `SECURITY_MODEL.md`

---

## 0. Mục đích

Migration là **cầu nối giữa các version** của runtime mà không phá vỡ:

- state đã persist;
- invariant đã enforce;
- audit trail đã ghi;
- reproducibility của verification;
- canonical form của workspace hash.

Nguyên tắc:

> **Migration không được phá state. Migration không được phá audit. Migration không được phá reproducibility.**

File này định nghĩa:

- versioning philosophy;
- version surfaces;
- migration flow;
- compatibility matrix;
- rollback;
- canonical form migration;
- workspace revision migration;
- event log migration;
- testing;
- invariant mapping;
- test matrix.

Tham chiếu: `INVARIANTS.md` → **CP-007, PR-003, DC-001, VR-001, WS-001**.

---

## 1. Nguyên tắc nền tảng

### 1.1 Ba loại version

| Loại | Scope | Ví dụ |
|---|---|---|
| **Schema Version** | Cấu trúc bảng, cột, entity field | `schemaVersion: 1` |
| **Canonical Form Version** | Format hash của workspace revision | `canonicalFormVersion: "v1"` |
| **Policy Version** | Rules, allowlist, budget | `policyVersion: 1` |

Ba loại độc lập. Bump cái này không bắt buộc bump cái kia.

### 1.2 Nguyên tắc version

- Version **đơn điệu tăng**.
- Version **không tái sử dụng**.
- Version cũ **vẫn queryable**.
- Version cũ **không bị xóa** (trừ policy explicit).
- Version binding **rõ ràng** giữa entity và version.

### 1.3 Nguyên tắc migration

- **Idempotent**: chạy nhiều lần cho cùng kết quả.
- **Resumable**: crash giữa migration → resume được.
- **Reversible**: có rollback plan (trừ khi explicit forward-only).
- **Auditable**: mọi migration ghi event.
- **Testable**: migration có test trên fixture.
- **Deterministic**: cùng input → cùng output.

### 1.4 Nguyên tắc tương thích

- **Backward compatible**: code mới đọc được data cũ.
- **Forward compatible**: code cũ đọc được data mới (nếu có thể).
- **Không silent migrate**: migration phải explicit.
- **Không silent drop**: không xóa field mà không migration.

Tham chiếu: `INVARIANTS.md` → **CP-007, PR-003**.

---

## 2. Version Surfaces

### 2.1 Runtime version

```typescript
interface RuntimeVersion {
  runtimeVersion: string;        // semver: "0.1.0"
  schemaVersion: number;         // integer, monotonic
  canonicalFormVersion: string;  // "v1"
  policyVersion: number;         // integer
}
```

`runtimeVersion` được ghi vào:

- Session metadata.
- Event log.
- Provenance.
- Checkpoint.

### 2.2 Schema version registry

```typescript
interface SchemaVersionRecord {
  schemaVersion: number;
  appliedAt: string;
  runtimeVersion: string;
  migrationId: string;
  description: string;
  forwardOnly: boolean;
  rollbackTo?: number;
}
```

Lưu trong bảng `schema_versions`.

### 2.3 Canonical form version registry

```typescript
interface CanonicalFormVersionRecord {
  canonicalFormVersion: string;  // "v1", "v2", ...
  introducedAt: string;
  runtimeVersion: string;
  hashAlgorithm: 'blake3' | 'sha256';
  formatSpec: string;            // reference to spec section
  deprecated: boolean;
}
```

### 2.4 Policy version registry

```typescript
interface PolicyVersionRecord {
  policyVersion: number;
  policyId: string;
  effectiveFrom: string;
  effectiveTo?: string;
  changesSummary: string;
  breaking: boolean;
}
```

### 2.5 Binding rules

- Mỗi entity record có `schemaVersion`.
- Mỗi `WorkspaceRevision` có `canonicalFormVersion`.
- Mỗi `Approval` bind với `policyVersion`.
- Mỗi `VerificationReport` bind với `canonicalFormVersion` và `policyVersion`.

Tham chiếu: `INVARIANTS.md` → **VR-001, VR-009, HI-001, WS-001**.

---

## 3. Compatibility Matrix

### 3.1 Change classification

| Change | Backward | Forward | Action |
|---|---|---|---|
| Add nullable field | ✅ | ⚠️ | minor bump |
| Add required field | ❌ | ⚠️ | major bump + migration |
| Remove field | ⚠️ | ❌ | major bump + deprecation |
| Rename field | ❌ | ❌ | major bump + migration |
| Change field type | ❌ | ❌ | major bump + migration |
| Add table | ✅ | ✅ | minor bump |
| Add index | ✅ | ✅ | minor bump |
| Change enum values | ⚠️ | ⚠️ | minor bump + migration |
| Change hash format | ❌ | ❌ | canonical form bump |
| Change policy rules | ⚠️ | ⚠️ | policy version bump |

### 3.2 Compatibility rules

- **Backward compatible**: runtime mới đọc được data cũ mà không cần migration.
- **Forward compatible**: runtime cũ đọc được data mới mà không crash (có thể ignore field mới).
- **Breaking**: cần migration bắt buộc trước khi runtime start.

### 3.3 Compatibility check

Runtime start:

```
1. Read schema_versions table.
2. So sánh với runtime.schemaVersion.
3. Nếu equal → OK.
4. Nếu runtime > db:
   a. Nếu có migration path → run migration.
   b. Nếu không → fail fast.
5. Nếu runtime < db:
   a. Nếu forward compatible → OK (read-only mode).
   b. Nếu không → fail fast.
```

Tham chiếu: `INVARIANTS.md` → **CP-007**.

---

## 4. Migration Flow

### 4.1 Migration lifecycle

```
DETECT
   │
   ▼
PLAN
   │
   ▼
BACKUP
   │
   ▼
APPLY
   │
   ▼
VERIFY
   │
   ▼
COMMIT
   │
   ▼
RECORD
```

### 4.2 Stage 1 — Detect

- So sánh `runtime.schemaVersion` với `db.schemaVersion`.
- Xác định danh sách migration cần chạy.
- Kiểm tra migration registry.

### 4.3 Stage 2 — Plan

- Load migration definitions.
- Validate migration chain (không gap, không conflict).
- Estimate thời gian.
- Nếu > threshold → ask user.

### 4.4 Stage 3 — Backup

- Trước migration, tạo backup:
  - SQLite: copy file hoặc `.backup` command.
  - Artifact store: snapshot metadata.
- Backup path: `~/.ollama-coding-agent/backups/<timestamp>/`.
- Backup phải verify đọc được.

### 4.5 Stage 4 — Apply

- Chạy migrations theo thứ tự.
- Mỗi migration trong một transaction.
- Nếu fail → rollback migration đó.
- Nếu rollback fail → mark DB corrupt, không tự recover.

### 4.6 Stage 5 — Verify

- Schema validation: bảng/cột đúng.
- Data validation: invariant check trên sample.
- Không có orphan reference.
- Event log sequence đúng.

### 4.7 Stage 6 — Commit

- Update `schema_versions`.
- Emit `MIGRATION_APPLIED` event.
- Xóa backup (hoặc giữ theo policy).

### 4.8 Stage 7 — Record

- Ghi vào `schema_versions`.
- Ghi vào event log.
- Ghi vào provenance.

Tham chiếu: `INVARIANTS.md` → **CP-007, CP-001**.

---

## 5. Migration Definition

### 5.1 Structure

```typescript
interface Migration {
  migrationId: string;           // "0001_add_task_graph_nodes"
  fromVersion: number;
  toVersion: number;

  forwardOnly: boolean;
  reversible: boolean;

  description: string;
  introducedIn: string;          // runtime version

  apply(db: Database): Promise<void>;
  rollback?(db: Database): Promise<void>;

  validate(db: Database): Promise<ValidationResult>;
}
```

### 5.2 Naming convention

```
<NNNN>_<verb>_<subject>
```

Ví dụ:

- `0001_create_initial_schema`
- `0002_add_task_graph_versions`
- `0003_add_canonical_form_version`
- `0004_add_verification_reports`

### 5.3 Ordering

- Migrations chạy theo `fromVersion` tăng dần.
- Không gap trong chain.
- Không skip.

### 5.4 Registry

```typescript
interface MigrationRegistry {
  list(): Migration[];
  getByVersion(version: number): Migration | null;
  path(from: number, to: number): Migration[];
}
```

Registry load từ code, không từ DB. Lý do: code là source of truth cho migration logic.

Tham chiếu: `INVARIANTS.md` → **CP-007**.

---

## 6. Schema Evolution

### 6.1 Add column

```sql
-- forward
ALTER TABLE tasks ADD COLUMN strategy_kind TEXT;

-- rollback
-- SQLite không drop column dễ dàng; dùng table rebuild
```

### 6.2 Rename column

SQLite không hỗ trợ rename column trực tiếp (trước 3.25). Dùng table rebuild:

```
1. Create new table with new schema.
2. Copy data (map old → new).
3. Drop old table.
4. Rename new table.
```

### 6.3 Change type

- SQLite dynamic typing, nhưng cần migrate data.
- Ví dụ: `priority TEXT` → `priority INTEGER`.
- Migration: parse, validate, convert.

### 6.4 Add table

```sql
CREATE TABLE new_table (...);
CREATE INDEX ...;
```

Rollback: `DROP TABLE new_table`.

### 6.5 Drop table

- Deprecate trước (1 version).
- Không drop ngay.
- Sau khi confirm không dùng → drop trong migration riêng.

### 6.6 Event log migration

- Event log append-only.
- Không rewrite event cũ.
- Nếu schema event thay đổi → versioned event.
- Reader phải handle nhiều event version.

Tham chiếu: `INVARIANTS.md` → **CP-008, OB-L1**.

---

## 7. Canonical Form Migration

### 7.1 Khi nào bump canonical form

- Hash algorithm thay đổi.
- Format canonical line thay đổi.
- Thêm/bớt field trong hash input.
- Đổi cách xử lý symlink, case, EOL.

### 7.2 Migration strategy

Canonical form **không migrate data cũ**. Thay vào đó:

1. Bump `canonicalFormVersion`.
2. Runtime mới tính hash theo format mới.
3. Revision cũ giữ `canonicalFormVersion: "v1"`.
4. Verification mới bind với format mới.
5. Verification cũ vẫn queryable, nhưng không fresh với revision mới.

### 7.3 Freshness across canonical form

```
isFresh(report, current) =
     report.targetWorkspaceRevision.canonicalFormVersion
       == current.canonicalFormVersion
  ∧ report.targetWorkspaceRevision.hash == current.hash
```

Nếu canonical form khác → stale (VR-011).

### 7.4 Re-verification

- Sau canonical form bump, mọi task cần re-verify.
- Task PASSED với format cũ → đánh dấu `NEEDS_REVERIFY`.
- Không tự revert.

### 7.5 Không có "convert hash"

- Không thể convert hash cũ sang hash mới mà không có workspace.
- Nếu workspace không còn → revision cũ không thể re-hash.
- Đây là lý do canonical form bump là **major event**.

Tham chiếu: `INVARIANTS.md` → **WS-001, WS-002, VR-001, VR-011**.

---

## 8. Workspace Revision Migration

### 8.1 Revision không migrate

- WorkspaceRevision là **snapshot bất biến**.
- Không migrate revision cũ.
- Revision cũ giữ nguyên format cũ.

### 8.2 Revision lookup

- Revision lookup theo `revisionId`.
- Không lookup theo hash (hash có thể khác giữa canonical form).
- Report bind với `revisionId`, không chỉ hash.

### 8.3 Revision compatibility

```typescript
function canCompare(r1: WorkspaceRevision, r2: WorkspaceRevision): boolean {
  return r1.canonicalFormVersion === r2.canonicalFormVersion;
}
```

Nếu khác canonical form → không so sánh được. Cần re-hash workspace hiện tại.

### 8.4 Legacy revision

- Revision với canonical form cũ được đánh dấu `legacy: true`.
- Không xóa.
- Vẫn queryable cho audit.

Tham chiếu: `INVARIANTS.md` → **WS-001, WS-002, VR-001**.

---

## 9. Event Log Migration

### 9.1 Append-only

- Event log không rewrite.
- Event cũ giữ nguyên.
- Event mới có `eventVersion`.

### 9.2 Event versioning

```typescript
interface DomainEvent {
  eventId: string;
  eventVersion: number;          // schema version của event này
  type: string;
  payload: unknown;
  // ...
}
```

### 9.3 Reader compatibility

- Reader phải handle nhiều event version.
- Migration on read: `migrateEvent(event) -> DomainEvent_current`.
- Migration function phải pure.

### 9.4 Event replay

- Replay từ event cũ phải cho state đúng.
- Nếu schema state thay đổi → replay phải áp dụng migration.
- Test: replay full history → state == current state.

### 9.5 Không compact event log

- v1: không compact.
- v2: có thể snapshot + truncate.
- Nếu compact → checkpoint là source of truth.

Tham chiếu: `INVARIANTS.md` → **CP-008, OB-L1, OB-L2**.

---

## 10. Rollback

### 10.1 Rollback strategy

| Migration type | Rollback |
|---|---|
| Add column | Drop column (rebuild table) |
| Add table | Drop table |
| Rename column | Rename back |
| Change type | Convert back (nếu reversible) |
| Add index | Drop index |
| Data backfill | Manual hoặc forward-only |
| Canonical form bump | **Không rollback** (forward-only) |

### 10.2 Forward-only migrations

Một số migration là **forward-only**:

- Canonical form bump.
- Event log format change.
- Data backfill không reversible.

Cho forward-only:

- Không có `rollback()`.
- Downgrade runtime → fail fast.
- User phải re-install runtime cũ nếu cần.

### 10.3 Rollback flow

```
1. Detect runtime downgrade.
2. Check migration chain có rollback không.
3. Nếu có:
   a. Backup.
   b. Apply rollback theo thứ tự ngược.
   c. Verify.
   d. Update schema_versions.
4. Nếu không:
   a. Fail fast.
   b. Không start runtime.
```

### 10.4 Rollback failure

- Nếu rollback fail → DB có thể corrupt.
- Không tự recover.
- Restore từ backup.
- Emit `MIGRATION_ROLLBACK_FAILED` event.

Tham chiếu: `INVARIANTS.md` → **CP-007, CP-009**.

---

## 11. Migration Testing

### 11.1 Test requirements

Mọi migration phải có:

1. **Forward test**: apply migration lên fixture → verify.
2. **Rollback test**: apply + rollback → verify state gốc.
3. **Idempotency test**: apply 2 lần → same result (hoặc fail rõ ràng).
4. **Data test**: fixture với data → migrate → verify data đúng.
5. **Invariant test**: sau migration, invariant vẫn hold.
6. **Crash test**: kill giữa migration → resume.

### 11.2 Fixtures

- Fixture là SQLite DB snapshot.
- Fixture phải có data realistic.
- Fixture versioned theo schema version.

```
tests/migrations/fixtures/
  v1_empty.sqlite
  v1_small.sqlite
  v1_realistic.sqlite
  v2_empty.sqlite
  ...
```

### 11.3 Test matrix

| Test | Mục đích |
|---|---|
| `forward-clean` | apply lên empty DB |
| `forward-data` | apply lên DB có data |
| `forward-large` | apply lên DB lớn |
| `rollback-clean` | rollback sạch |
| `rollback-data` | rollback giữ data |
| `idempotent` | apply 2 lần |
| `crash-resume` | kill giữa chừng |
| `invariant-hold` | invariant sau migration |
| `cross-version-read` | đọc data version cũ |

### 11.4 CI integration

- Mọi PR thay đổi schema phải có migration test.
- CI chạy full migration chain từ v1 → current.
- CI chạy rollback chain từ current → v1.

Tham chiếu: `INVARIANTS.md` → **CP-007**.

---

## 12. Migration Audit

### 12.1 Event emission

Mọi migration emit:

- `MIGRATION_DETECTED`
- `MIGRATION_PLANNED`
- `MIGRATION_BACKUP_CREATED`
- `MIGRATION_APPLIED`
- `MIGRATION_VERIFIED`
- `MIGRATION_COMMITTED`
- `MIGRATION_FAILED`
- `MIGRATION_ROLLED_BACK`

### 12.2 Provenance

- Migration có provenance record.
- `source: 'runtime'`.
- `reason: 'schema_migration'`.

### 12.3 Audit log

- Migration record trong `schema_versions`.
- Không xóa migration record.
- Queryable.

Tham chiếu: `INVARIANTS.md` → **PR-001, PR-003**.

---

## 13. Migration Registry (v1)

### 13.1 Initial schema

`0001_create_initial_schema`

Tables:

- sessions
- goals
- tasks
- task_executions
- task_runs
- task_graph_versions
- task_graph_nodes
- task_graph_edges
- graph_mutations
- tool_calls
- approvals
- artifacts
- verification_reports
- verification_checks
- workspace_revisions
- failures
- recoveries
- checkpoints
- budgets
- escalations
- events
- provenance
- schema_versions

### 13.2 Future migrations (planned)

| ID | Description | Forward-only |
|---|---|---|
| `0002_add_canonical_form_version` | Add `canonical_form_version` column | No |
| `0003_add_verification_checks_table` | Split checks table | No |
| `0004_add_context_snapshots` | Add context snapshots table | No |
| `0005_canonical_form_v2` | Bump canonical form | **Yes** |
| `0006_add_recovery_actions` | Add recovery actions table | No |

### 13.3 Reserved ranges

- `0000-0999`: core schema.
- `1000-1999`: feature-specific.
- `9000-9999`: hotfix.

Tham chiếu: `INVARIANTS.md` → **CP-007**.

---

## 14. Policy Migration

### 14.1 Policy version bump

- Policy change → bump `policyVersion`.
- Policy binding trong Approval, VerificationReport.
- Không tự động invalidate state cũ.

### 14.2 Policy compatibility

- Policy mới có thể require re-verification.
- Task PASSED với policy cũ vẫn valid (không tự revert).
- Task mới dùng policy mới.

### 14.3 Policy migration

- Policy không migrate data.
- Policy chỉ binding version.
- Nếu policy mới strict hơn → task cũ cần re-verify khi re-run.

Tham chiếu: `INVARIANTS.md` → **VR-009, HI-001**.

---

## 15. Runtime Downgrade

### 15.1 Downgrade scenarios

- User cài runtime cũ.
- CI rollback.
- Bug fix revert.

### 15.2 Downgrade flow

```
1. Runtime start.
2. Read schema_versions.
3. If runtime.schemaVersion < db.schemaVersion:
   a. Check migration chain có rollback không.
   b. Nếu có → apply rollback.
   c. Nếu không → fail fast.
4. If runtime.canonicalFormVersion < db.canonicalFormVersion:
   a. Fail fast (forward-only).
5. If runtime.policyVersion < db.policyVersion:
   a. Warn user (policy cũ không hỗ trợ).
   b. Có thể chạy read-only.
```

### 15.3 Downgrade safety

- Downgrade không được phá state.
- Nếu không chắc → fail fast.
- Không silent downgrade.

Tham chiếu: `INVARIANTS.md` → **CP-007**.

---

## 16. Multi-Workspace Migration

### 16.1 v1 scope

- v1: single workspace.
- Migration áp dụng cho workspace hiện tại.
- Không có global DB.

### 16.2 v2 scope (future)

- Multi-workspace.
- Migration per-workspace.
- Global registry.

### 16.3 Isolation

- Migration không ảnh hưởng workspace khác.
- Lock trong migration.

---

## 17. Migration Failure Handling

### 17.1 Failure types

| Type | Handling |
|---|---|
| Schema validation fail | Rollback migration |
| Data validation fail | Rollback migration |
| Disk full | Fail, restore backup |
| Timeout | Fail, restore backup |
| Crash | Resume from last checkpoint |
| Corruption | Fail, restore backup |

### 17.2 Recovery

- Backup là recovery chính.
- Không tự recover từ corrupt DB.
- Emit event, notify user.

### 17.3 Escalation

- Migration fail → session ABORTED.
- User phải can thiệp.
- Không tự retry vô hạn.

Tham chiếu: `INVARIANTS.md` → **CP-004, CP-009**.

---

## 18. Migration API

### 18.1 Interface

```typescript
interface MigrationEngine {
  detect(): Promise<MigrationPlan>;
  plan(from: number, to: number): Promise<MigrationPlan>;
  apply(plan: MigrationPlan): Promise<MigrationResult>;
  rollback(plan: MigrationPlan): Promise<MigrationResult>;
  verify(): Promise<ValidationResult>;

  listApplied(): Promise<SchemaVersionRecord[]>;
  listPending(): Promise<Migration[]>;
}

interface MigrationPlan {
  fromVersion: number;
  toVersion: number;
  migrations: Migration[];
  estimatedDurationMs: number;
  forwardOnly: boolean;
  requiresBackup: boolean;
}

interface MigrationResult {
  status: 'SUCCESS' | 'FAILED' | 'ROLLED_BACK';
  appliedMigrations: string[];
  error?: MigrationError;
  durationMs: number;
}
```

### 18.2 Error codes

| Code | Meaning |
|---|---|
| `MIGRATION_NOT_FOUND` | Không có migration path |
| `MIGRATION_FAILED` | Migration fail |
| `MIGRATION_ROLLBACK_FAILED` | Rollback fail |
| `MIGRATION_FORWARD_ONLY` | Không rollback được |
| `MIGRATION_BACKUP_FAILED` | Backup fail |
| `MIGRATION_VERIFY_FAILED` | Verify fail |
| `MIGRATION_CORRUPT` | DB corrupt |

---

## 19. Invariant Mapping

| Invariant | Enforcement |
|---|---|
| CP-001 | §4.5 (transaction per migration) |
| CP-007 | §1.2, §3, §4, §10 |
| CP-008 | §6.6, §9.1 |
| CP-009 | §4.6, §10.4, §17.2 |
| PR-001 | §12.2 |
| PR-003 | §12.3 |
| WS-001 | §7, §8 |
| VR-001 | §7.3 |
| VR-009 | §2.5 |
| HI-001 | §2.5 |
| DC-001 | §1.3 (domain không phụ thuộc migration) |

---

## 20. Test Matrix

### 20.1 Migration unit tests

| Test | Target |
|---|---|
| `migration-id-unique` | registry check |
| `migration-chain-no-gap` | chain validation |
| `migration-ordering` | fromVersion tăng |
| `migration-idempotent` | apply twice |
| `migration-rollback` | apply + rollback |
| `migration-forward-only` | no rollback |

### 20.2 Schema migration tests

| Test | Target |
|---|---|
| `add-column` | schema updated |
| `add-table` | table created |
| `rename-column` | data preserved |
| `change-type` | data converted |
| `drop-table` | table removed |
| `add-index` | index created |

### 20.3 Data migration tests

| Test | Target |
|---|---|
| `migrate-empty` | no data |
| `migrate-small` | small data |
| `migrate-realistic` | realistic data |
| `migrate-large` | performance |
| `data-preserved` | no data loss |

### 20.4 Canonical form tests

| Test | Target |
|---|---|
| `canonical-form-v1-v2` | hash different |
| `canonical-form-no-migrate` | revision cũ giữ format |
| `canonical-form-freshness` | stale after bump |
| `canonical-form-reverify` | task needs re-verify |

### 20.5 Event log tests

| Test | Target |
|---|---|
| `event-version-migrate-on-read` | reader handle cũ |
| `event-replay` | state reproducible |
| `event-append-only` | no rewrite |

### 20.6 Cross-version tests

| Test | Target |
|---|---|
| `read-v1-with-v2` | backward compat |
| `read-v2-with-v1` | forward compat |
| `downgrade-with-rollback` | rollback works |
| `downgrade-forward-only` | fail fast |

### 20.7 Crash tests

| Test | Target |
|---|---|
| `crash-during-apply` | resume |
| `crash-during-rollback` | resume |
| `crash-after-backup` | continue |
| `crash-before-commit` | rollback |

---

## 21. Adversarial Tests

| Adversary | Attempt | Expected |
|---|---|---|
| Malicious migration | drop table without backup | reject (no backup) |
| Malicious migration | skip verify | reject (policy) |
| Malicious migration | silent data loss | detect in verify |
| Crash | kill mid-migration | resume or restore |
| Disk full | during apply | rollback + restore |
| Concurrent migration | two processes | lock |
| Downgrade | without rollback | fail fast |

---

## 22. CI/CD Integration

### 22.1 CI pipeline

```
1. Checkout code.
2. Load all migration fixtures.
3. Apply full chain: v1 → current.
4. Verify schema.
5. Verify invariants.
6. Rollback full chain: current → v1.
7. Verify schema.
8. Run migration tests.
```

### 22.2 PR gate

- PR thay đổi schema → bắt buộc migration.
- PR thay đổi migration → bắt buộc test.
- PR bump canonical form → bắt buộc test cross-version.

### 22.3 Release gate

- Release phải pass full migration test.
- Release phải có rollback plan.
- Release phải có backup instruction.

Tham chiếu: `INVARIANTS.md` → **CP-007**.

---

## 23. Documentation

### 23.1 Per migration

Mỗi migration phải có:

- README mô tả.
- Before/after schema.
- Rollback plan.
- Test evidence.

### 23.2 Migration log

`docs/migrations/` chứa:

- `0001_create_initial_schema.md`
- `0002_add_canonical_form_version.md`
- ...

### 23.3 User-facing

- Migration notification trong VS Code.
- Backup location.
- Rollback instruction.

---

## 24. Migration Best Practices

### 24.1 Do

- ✅ Backup trước migration.
- ✅ Test forward + rollback.
- ✅ Idempotent.
- ✅ Emit event.
- ✅ Ghi provenance.
- ✅ Validate data sau migration.
- ✅ Document.

### 24.2 Don't

- ❌ Migrate mà không backup.
- ❌ Silent drop field.
- ❌ Rewrite event log.
- ❌ Convert canonical form hash.
- ❌ Migrate ngoài transaction.
- ❌ Skip verify.
- ❌ Assume data valid.

### 24.3 Anti-patterns

- ❌ "Just drop and recreate" — mất data.
- ❌ "We'll fix it later" — không fix được.
- ❌ "Trust the model" — model không migrate.
- ❌ "Migration is just code" — migration phá state.

---

## 25. Open Questions (Phase 0)

1. **Backup retention**: giữ bao lâu?
2. **Migration timeout**: bao lâu?
3. **Forward-only list**: những migration nào?
4. **Canonical form bump**: khi nào bump?
5. **Event log compaction**: có cần không?
6. **Multi-workspace migration**: v2 scope?
7. **Migration signing**: có cần không?
8. **Migration rollback UI**: có cần không?

---

## 26. North Star

> **Migration không được phá state. Migration không được phá audit. Migration không được phá reproducibility.**

Mọi migration, mọi rollback, mọi version bump tồn tại để trả lời:

- **Version nào** đang chạy?
- **Data nào** đã migrate?
- **Audit** có bảo toàn?
- **Reproducibility** có giữ?
- **Rollback** có khả thi?

---
