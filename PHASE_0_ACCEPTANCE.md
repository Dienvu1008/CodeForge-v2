# PHASE_0_ACCEPTANCE.md

**Ollama Coding Agent — Executable Architecture Contract Acceptance Criteria**

Version: 1.0
Status: Architecture Baseline
Owner: Runtime / Architecture
Scope: Phase 0 (Executable Architecture Contract)
Related specs:
`INVARIANTS.md`, `WORKSPACE_SPEC_v1.0.md`, `DOMAIN_CONTRACTS.md`,
`STATE_MACHINE_SPEC.md`, `GRAPH_PROTOCOL.md`, `VERIFICATION_PROTOCOL.md`,
`SECURITY_MODEL.md`, `MIGRATION_SPEC.md`, `EVALUATION_MODEL.md`,
`CONTEXT_SPEC_v1.0.md`, `INFRASTRUCTURE_SPEC.md`

---

## 0. Mục đích

Phase 0 **không phải** là coding agent thông minh. Phase 0 là **executable architecture contract** — biến kiến trúc từ văn bản thành **test chạy được**.

Nguyên tắc trung tâm:

> **Phase 0 kết thúc khi architecture có thể được kiểm tra bằng test, không chỉ đọc bằng mắt.**

File này định nghĩa:

- Phase 0 goals và non-goals;
- Deliverables (docs, code, tests);
- Acceptance criteria (checklist);
- Test harness requirements;
- Cross-platform requirements;
- Adversarial harness requirements;
- CI requirements;
- Exit criteria (không thể nhầm lẫn);
- Anti-criteria (điều không được làm);
- Phase gate review.

Tham chiếu: `INVARIANTS.md` → toàn bộ.

---

## 1. Phase 0 Goals

### 1.1 Mục tiêu

1. **Freeze architecture contracts** — 11 spec docs hoàn chỉnh.
2. **Biến invariant thành test** — `invariants.yaml` + test harness.
3. **Reference implementation cho WorkspaceRevision** — canonical hash chạy được.
4. **Cross-platform test vectors** — Windows/Linux/macOS cho cùng hash.
5. **AdversarialModel harness** — có thể inject model độc hại.
6. **CI pipeline** — tự động chạy toàn bộ trên 3 OS.
7. **Domain types skeleton** — TypeScript types cho toàn bộ entity.
8. **Repository interface skeleton** — interface cho tất cả repository.

### 1.2 Không phải mục tiêu

- ❌ Chạy planner.
- ❌ Chạy Ollama thật.
- ❌ Execute tool thật.
- ❌ Verify task thật.
- ❌ Build agent loop.
- ❌ UI hoàn chỉnh.

Phase 0 **không** cần LLM. Phase 0 test **runtime**, không test **intelligence**.

---

## 2. Deliverables

### 2.1 Documentation (bắt buộc)

| # | File | Owner | Status |
|---|---|---|---|
| D1 | `INVARIANTS.md` | Runtime | ✅ |
| D2 | `WORKSPACE_SPEC_v1.0.md` | Workspace | ✅ |
| D3 | `DOMAIN_CONTRACTS.md` | agent-core | ✅ |
| D4 | `STATE_MACHINE_SPEC.md` | agent-core | ✅ |
| D5 | `GRAPH_PROTOCOL.md` | agent-core | ✅ |
| D6 | `VERIFICATION_PROTOCOL.md` | Verification | ✅ |
| D7 | `SECURITY_MODEL.md` | Policy | ✅ |
| D8 | `MIGRATION_SPEC.md` | infrastructure | ✅ |
| D9 | `EVALUATION_MODEL.md` | Runtime | ✅ |
| D10 | `CONTEXT_SPEC_v1.0.md` | Context | ✅ |
| D11 | `INFRASTRUCTURE_SPEC.md` | infrastructure | ✅ |

### 2.2 Machine-readable artifacts (bắt buộc)

| # | File | Purpose |
|---|---|---|
| A1 | `invariants.yaml` | Machine-readable invariant registry |
| A2 | `invariants.schema.json` | JSON Schema cho `invariants.yaml` |
| A3 | `workspace_vectors/manifest.json` | Cross-platform test vector registry |
| A4 | `scenarios.yaml` | Adversarial scenario registry |
| A5 | `phase_0_checklist.yaml` | CI checklist |

### 2.3 Code (bắt buộc)

| # | Component | Package |
|---|---|---|
| C1 | Canonical hash reference impl | `infrastructure/workspace-hash` |
| C2 | WorkspaceRevision ref impl | `infrastructure/workspace-revision` |
| C3 | Path canonicalizer ref impl | `infrastructure/path` |
| C4 | Domain entity types | `agent-core/domain` |
| C5 | State machine types | `agent-core/state-machine` |
| C6 | Graph types | `agent-core/graph` |
| C7 | Repository interfaces | `agent-core/repositories` |
| C8 | AdversarialModel interface | `testing/adversarial` |
| C9 | FakeModel implementation | `testing/fake-model` |
| C10 | Test harness runner | `testing/harness` |

### 2.4 Tests (bắt buộc)

| # | Suite | Coverage |
|---|---|---|
| T1 | `tests/invariants/` | Toàn bộ invariant CRITICAL Phase 0 |
| T2 | `tests/workspace/` | Canonical hash + revision |
| T3 | `tests/cross-platform/` | Windows/Linux/macOS vectors |
| T4 | `tests/adversarial/` | AdversarialModel harness |
| T5 | `tests/state-machine/` | Transition table (skeleton) |
| T6 | `tests/graph/` | Validator (skeleton) |
| T7 | `tests/contracts/` | Domain type conformance |

### 2.5 CI (bắt buộc)

| # | Workflow | OS |
|---|---|---|
| CI1 | `invariants.yml` | ubuntu, macos, windows |
| CI2 | `workspace-vectors.yml` | ubuntu, macos, windows |
| CI3 | `adversarial.yml` | ubuntu |
| CI4 | `contracts.yml` | ubuntu |
| CI5 | `dependency-direction.yml` | ubuntu |

---

## 3. Acceptance Criteria

### 3.1 Documentation acceptance

| # | Criterion | Test |
|---|---|---|
| DA-1 | 11 spec files tồn tại | `ls docs/` |
| DA-2 | Mỗi spec có version header | grep |
| DA-3 | Mỗi spec có "North Star" section | grep |
| DA-4 | Mỗi spec reference invariant IDs | grep `[A-Z]{2}-\d{3}` |
| DA-5 | Không có invariant nào duplicate statement | lint script |
| DA-6 | Không có invariant ID nào tái sử dụng | lint script |

### 3.2 Machine-readable acceptance

| # | Criterion | Test |
|---|---|---|
| MA-1 | `invariants.yaml` parse được | `yaml.load` |
| MA-2 | Pass schema `invariants.schema.json` | ajv |
| MA-3 | Mỗi invariant có `id`, `statement`, `enforcement`, `test`, `phase`, `severity`, `status` | schema |
| MA-4 | Không có invariant ID duplicate | script |
| MA-5 | Mỗi invariant có test file tồn tại HOẶC `phase > 0` | script |
| MA-6 | Số invariant CRITICAL ≥ 100 | count |
| MA-7 | Mỗi domain (SS, GL, TI, EX, GI, SM, SC, TG, VR, WS, BU, SE, CP, MG, CX, RC, HI, PR, OB, DC) có ≥ 1 invariant | count |

### 3.3 Canonical hash acceptance

| # | Criterion | Test |
|---|---|---|
| CH-1 | Implement đúng spec §6.2 WORKSPACE_SPEC | unit test |
| CH-2 | Empty workspace → known hash | vector |
| CH-3 | Single file → known hash | vector |
| CH-4 | Multiple files → known hash | vector |
| CH-5 | Nested dirs → known hash | vector |
| CH-6 | CRLF vs LF → different hash | vector |
| CH-7 | NFC vs NFD filename → same hash | vector |
| CH-8 | Symlink internal → recorded, not followed | vector |
| CH-9 | Symlink external → skipped | vector |
| CH-10 | Scratch zone excluded | vector |
| CH-11 | Empty dir included | vector |
| CH-12 | File with spaces → stable | vector |
| CH-13 | Unicode filename → stable | vector |
| CH-14 | Case collision on case-insensitive FS → reject | vector |
| CH-15 | Large file (100MB) → streaming, no OOM | perf test |
| CH-16 | 10,000 files → hash < 10s | perf test |
| CH-17 | Permission change → same hash (v1) | vector |
| CH-18 | Special chars in filename → escaped | vector |
| CH-19 | Deterministic: same input → same hash | property test |
| CH-20 | No false negative: different content → different hash | property test |

### 3.4 Cross-platform acceptance

| # | Criterion | OS |
|---|---|---|
| XP-1 | Toàn bộ vector CH-1..CH-20 pass trên Linux | ubuntu |
| XP-2 | Toàn bộ vector CH-1..CH-20 pass trên macOS | macos |
| XP-3 | Toàn bộ vector CH-1..CH-20 pass trên Windows | windows |
| XP-4 | Cùng logical content → cùng hash trên cả 3 OS | all |
| XP-5 | Path canonicalization consistent | all |
| XP-6 | Case sensitivity detect correctly | all |

### 3.5 WorkspaceRevision acceptance

| # | Criterion | Test |
|---|---|---|
| WR-1 | Schema khớp DOMAIN_CONTRACTS.md §16 | schema |
| WR-2 | `revisionId` là ULID | regex |
| WR-3 | `hash` deterministic | unit |
| WR-4 | `revisionId` immutable | type |
| WR-5 | Revision append-only | contract test |
| WR-6 | `gitMetadata` optional | schema |
| WR-7 | `canonicalFormVersion` recorded | schema |
| WR-8 | Revision bind với workspace root canonical | unit |
| WR-9 | Revision không phụ thuộc Git | unit |
| WR-10 | Freshness check works | unit |

### 3.6 Path canonicalizer acceptance

| # | Criterion | Test |
|---|---|---|
| PC-1 | `..` escape rejected | unit |
| PC-2 | Absolute path ngoài root rejected | unit |
| PC-3 | Symlink to external rejected | unit |
| PC-4 | Symlink loop detected | unit |
| PC-5 | Null byte rejected | unit |
| PC-6 | UNC path Windows rejected (ngoài policy) | unit |
| PC-7 | `\\?\` prefix rejected (ngoài policy) | unit |
| PC-8 | Case normalization theo OS | unit |
| PC-9 | Separator normalization `/` ↔ `\` | unit |
| PC-10 | Deterministic: same input → same output | property |

### 3.7 Domain types acceptance

| # | Criterion | Test |
|---|---|---|
| DT-1 | Session type khớp DOMAIN_CONTRACTS §2 | type check |
| DT-2 | Goal type khớp §3 | type check |
| DT-3 | Task type khớp §4 | type check |
| DT-4 | TaskExecution type khớp §5 | type check |
| DT-5 | TaskRun type khớp §6 | type check |
| DT-6 | TaskGraph type khớp §7 | type check |
| DT-7 | GraphMutation type khớp §8 | type check |
| DT-8 | VerificationReport type khớp §9 | type check |
| DT-9 | Failure type khớp §10 | type check |
| DT-10 | RecoveryAction type khớp §11 | type check |
| DT-11 | ToolCall type khớp §12 | type check |
| DT-12 | Approval type khớp §13 | type check |
| DT-13 | ContextSnapshot type khớp §14 | type check |
| DT-14 | Budget type khớp §15 | type check |
| DT-15 | Checkpoint type khớp §16 | type check |
| DT-16 | ChangeRecord type khớp §17 | type check |
| DT-17 | DomainEvent type khớp §18 | type check |
| DT-18 | Provenance type khớp §19 | type check |
| DT-19 | Artifact type khớp §20 | type check |
| DT-20 | Immutable types có `readonly` | lint |

### 3.8 State machine skeleton acceptance

| # | Criterion | Test |
|---|---|---|
| SM-1 | `SessionState` enum khớp §3.1 | type |
| SM-2 | `TaskState` enum khớp §4.1 | type |
| SM-3 | `TaskRunState` enum khớp §5.1 | type |
| SM-4 | `ToolCallState` enum khớp §7.1 | type |
| SM-5 | Transition table type defined | type |
| SM-6 | Illegal transition type error | type |
| SM-7 | Terminal state type defined | type |
| SM-8 | Transition function signature deterministic | type |

### 3.9 Graph skeleton acceptance

| # | Criterion | Test |
|---|---|---|
| GR-1 | `TaskGraph` type khớp §2.1 | type |
| GR-2 | `GraphOperation` union khớp §4.2 | type |
| GR-3 | `EdgeKind` enum khớp §2.1 | type |
| GR-4 | Cycle detection interface defined | type |
| GR-5 | Validator stages enum khớp §5.2 | type |

### 3.10 Repository interface acceptance

| # | Criterion | Test |
|---|---|---|
| RI-1 | `SessionRepository` interface khớp §23.1 | type |
| RI-2 | `TaskRepository` interface khớp §23.2 | type |
| RI-3 | `TaskGraphRepository` interface khớp §23.3 | type |
| RI-4 | `TaskRunRepository` interface khớp §23.4 | type |
| RI-5 | `VerificationRepository` interface khớp §23.5 | type |
| RI-6 | `EventLog` interface khớp §23.6 | type |
| RI-7 | Không có `update()` cho immutable entity | lint |
| RI-8 | Mọi repository có `getById()` | lint |

### 3.11 AdversarialModel acceptance

| # | Criterion | Test |
|---|---|---|
| AM-1 | `AdversarialModel` interface defined | type |
| AM-2 | `MaliciousPlanner` variant exists | type |
| AM-3 | `MaliciousReplanner` variant exists | type |
| AM-4 | `MaliciousVerifier` variant exists | type |
| AM-5 | `MaliciousToolProposal` variant exists | type |
| AM-6 | `MaliciousFailureAnalyzer` variant exists | type |
| AM-7 | `PromptInjectionContent` variant exists | type |
| AM-8 | Mỗi variant có ≥ 1 test | test count |
| AM-9 | Harness có thể inject variant | integration |
| AM-10 | Harness detect violation | integration |

### 3.12 FakeModel acceptance

| # | Criterion | Test |
|---|---|---|
| FM-1 | `FakeModel` implements `ModelGateway` interface | type |
| FM-2 | `setResponse()` deterministic | unit |
| FM-3 | `setSequence()` deterministic | unit |
| FM-4 | `setError()` throws typed error | unit |
| FM-5 | `setDelay()` works | unit |
| FM-6 | `callCount` accurate | unit |
| FM-7 | `history` recorded | unit |
| FM-8 | Không dùng LLM thật | audit |

### 3.13 Invariant tests acceptance

| # | Criterion | Test |
|---|---|---|
| IT-1 | Mọi invariant Phase 0 có test file | script |
| IT-2 | Test file không rỗng | script |
| IT-3 | Test pass trên Linux | CI |
| IT-4 | Test pass trên macOS | CI |
| IT-5 | Test pass trên Windows | CI |
| IT-6 | Không có test flaky | repeat 10x |
| IT-7 | Test chạy < 1s mỗi cái | perf |
| IT-8 | Coverage ≥ 80% cho reference impl | coverage |

### 3.14 Dependency direction acceptance

| # | Criterion | Test |
|---|---|---|
| DD-1 | `agent-core` không import `infrastructure` | dep-cruiser |
| DD-2 | `agent-core` không import `models` | dep-cruiser |
| DD-3 | `agent-core` không import `tools` | dep-cruiser |
| DD-4 | `verification` không import `models` | dep-cruiser |
| DD-5 | `recovery` không import `models` trực tiếp | dep-cruiser |
| DD-6 | CI fail nếu vi phạm | CI |

### 3.15 CI acceptance

| # | Criterion | Test |
|---|---|---|
| CI-1 | Toàn bộ test chạy trên ubuntu | CI green |
| CI-2 | Toàn bộ test chạy trên macos | CI green |
| CI-3 | Toàn bộ test chạy trên windows | CI green |
| CI-4 | CI chạy < 10 phút | timing |
| CI-5 | Không có warning từ dependency-cruiser | CI |
| CI-6 | Không có TypeScript error | tsc |
| CI-7 | Không có ESLint error | eslint |

---

## 4. Test Harness Requirements

### 4.1 Structure

```
/tests
  /invariants
    /session
    /goal
    /task
    /execution
    /graph
    /state-machine
    /scheduler
    /tool-gateway
    /verification
    /workspace
    /budget
    /security
    /crash
    /model-gateway
    /context
    /recovery
    /human
    /provenance
    /observability
    /dependency-direction
  /workspace
    /vectors
      v001-empty/
      v002-single-file/
      ...
      v020-special-chars/
  /cross-platform
  /adversarial
    /variants
    /scenarios
  /contracts
  /state-machine
  /graph
  /_harness
    runner.ts
    fake-model.ts
    adversarial-model.ts
    fixture-loader.ts
    crash-injector.ts
```

### 4.2 Harness interface

```typescript
interface Phase0Harness {
  loadInvariants(): Promise<InvariantRegistry>;
  loadVectors(): Promise<WorkspaceVector[]>;
  loadScenarios(): Promise<AdversarialScenario[]>;

  runInvariant(id: string): Promise<InvariantResult>;
  runAllInvariants(): Promise<InvariantResult[]>;

  runWorkspaceVector(id: string): Promise<VectorResult>;
  runAllWorkspaceVectors(): Promise<VectorResult[]>;

  runAdversarialVariant(id: string): Promise<AdversarialResult>;
  runAllAdversarial(): Promise<AdversarialResult[]>;

  runContractChecks(): Promise<ContractResult[]>;

  generateReport(): Promise<Phase0Report>;
}
```

### 4.3 Test conventions

- Mỗi test file phải có header `@invariant <ID>`.
- Mỗi test phải độc lập.
- Mỗi test phải cleanup.
- Không dùng global mutable state.
- Deterministic seed (không random).

### 4.4 Fixtures

- Workspace vectors là **binary fixtures** (base64 hoặc tarball).
- Không phụ thuộc Git checkout.
- Mỗi vector có `expected.json`.
- Cross-platform reproducible.

### 4.5 Crash injection

```typescript
interface CrashInjector {
  at(point: CrashPoint, action: () => void): void;
  list(): CrashPoint[];
  reset(): void;
}

type CrashPoint =
  | 'before-transition'
  | 'during-transition'
  | 'after-commit'
  | 'during-tool-call'
  | 'during-verification'
  | 'during-checkpoint'
  | 'during-migration';
```

Phase 0 chỉ cần crash injector interface. Implementation đầy đủ ở Phase 1.

---

## 5. Cross-Platform Requirements

### 5.1 CI matrix

| Runner | OS | Filesystem | Purpose |
|---|---|---|---|
| `ubuntu-latest` | Linux | ext4 | Primary |
| `macos-latest` | macOS | APFS | Case-insensitive |
| `windows-latest` | Windows | NTFS | Path separator, CRLF |

### 5.2 Requirements

- Cùng logical workspace → cùng hash trên 3 OS.
- Path canonicalization consistent.
- Symlink handling consistent.
- Case sensitivity detect đúng.
- Line ending handling consistent.

### 5.3 Known differences

| Aspect | Linux | macOS | Windows |
|---|---|---|---|
| Case | Sensitive | Insensitive | Insensitive |
| Separator | `/` | `/` | `\` |
| Symlink | Full | Full | Limited (needs dev mode) |
| Long path | Unlimited | Unlimited | Limited (unless enabled) |
| Null byte | Reject | Reject | Reject |

### 5.4 Handling

- Normalize path separator trong canonical form.
- Normalize case theo OS policy.
- Symlink trên Windows: skip nếu không support.
- Long path trên Windows: reject nếu ngoài policy.

---

## 6. Adversarial Harness Requirements

### 6.1 Variants

| Variant | Mục tiêu | Test count |
|---|---|---|
| MaliciousPlanner | Delete workspace, invalid tasks | ≥ 3 |
| MaliciousReplanner | Mutate immutable, cycle, supersede passed | ≥ 3 |
| MaliciousVerifier | PASS without checks, stale revision | ≥ 3 |
| MaliciousToolProposal | rm -rf, symlink escape, path traversal | ≥ 5 |
| MaliciousFailureAnalyzer | Retry forever, escalate nothing | ≥ 2 |
| PromptInjectionContent | README, comments, logs | ≥ 3 |
| CombinedAttack | Multiple vectors | ≥ 2 |

### 6.2 Scenarios

| Scenario | Description |
|---|---|
| `plan-only` | Planner proposes, validator rejects |
| `execute-only` | Tool proposal, gateway rejects |
| `verify-only` | Verifier claims, completion gate rejects |
| `recover-only` | Analyzer proposes, policy rejects |
| `mixed` | Multiple stages |

### 6.3 Success criteria

Harness pass khi:

- **Không** có violation CRITICAL.
- **Không** có state corruption.
- **Không** có workspace mutation ngoài policy.
- Mọi attack bị block và log.

### 6.4 Report

```
Adversarial Phase 0 Report
══════════════════════════
Variants: 7
Scenarios: 5
Total attacks: 84
Blocked: 84
Violations: 0
Status: PASS
```

---

## 7. Exit Criteria

Phase 0 được coi là **hoàn thành** khi **tất cả** điều sau đúng:

### 7.1 Documentation

- [ ] 11 spec files tồn tại và có version header.
- [ ] Không có invariant ID duplicate.
- [ ] Không có invariant ID tái sử dụng.
- [ ] Mỗi spec có North Star section.

### 7.2 Machine-readable

- [ ] `invariants.yaml` parse được.
- [ ] Pass schema validation.
- [ ] ≥ 100 invariant CRITICAL.
- [ ] Mỗi domain có ≥ 1 invariant.

### 7.3 Canonical hash

- [ ] 20 test vector CH-1..CH-20 pass.
- [ ] Pass trên Linux, macOS, Windows.
- [ ] Cùng logical content → cùng hash.
- [ ] Không false negative.

### 7.4 Domain contracts

- [ ] 20 entity types defined.
- [ ] Mỗi entity match DOMAIN_CONTRACTS.
- [ ] Immutable types có `readonly`.
- [ ] Repository interfaces defined.

### 7.5 State machines

- [ ] Enum types defined cho 10 machines.
- [ ] Transition table types defined.
- [ ] Terminal state types defined.

### 7.6 Graph

- [ ] `TaskGraph` type defined.
- [ ] `GraphOperation` union defined.
- [ ] Cycle detection interface defined.

### 7.7 Adversarial

- [ ] 7 variants implemented.
- [ ] 5 scenarios defined.
- [ ] Mỗi variant có ≥ 1 test.
- [ ] Harness detect violation.

### 7.8 FakeModel

- [ ] Implements ModelGateway interface.
- [ ] Deterministic.
- [ ] Không dùng LLM thật.

### 7.9 CI

- [ ] CI green trên 3 OS.
- [ ] CI < 10 phút.
- [ ] Không TypeScript error.
- [ ] Không ESLint error.
- [ ] Không dependency-cruiser warning.

### 7.10 Dependency direction

- [ ] 5 rule DD-1..DD-5 pass.
- [ ] CI fail nếu vi phạm.

---

## 8. Anti-Criteria (Không được làm)

Phase 0 **không được**:

- ❌ Chạy Ollama thật.
- ❌ Chạy LLM thật trong test invariant.
- ❌ Execute tool thật trong test invariant.
- ❌ Verify task thật.
- ❌ Build agent loop.
- ❌ Có UI hoàn chỉnh.
- ❌ Có planner chạy.
- ❌ Có recovery engine chạy.
- ❌ Có scheduler chạy.
- ❌ Có verification engine chạy.
- ❌ Có bất kỳ code nào phụ thuộc vào model output.
- ❌ Có test flaky.
- ❌ Có test phụ thuộc wall-clock (trừ timeout test).
- ❌ Có test phụ thuộc random.
- ❌ Có test phụ thuộc network.
- ❌ Có test phụ thuộc filesystem ngoài temp.
- ❌ Skip invariant CRITICAL.
- ❌ Merge khi CI red.

Nếu bất kỳ anti-criterion nào vi phạm → Phase 0 **chưa** hoàn thành.

---

## 9. Phase Gate Review

### 9.1 Review process

1. **Self-review**: developer chạy full checklist.
2. **Automated review**: CI chạy toàn bộ acceptance.
3. **Peer review**: ít nhất 1 reviewer đọc spec + code.
4. **Architecture review**: verify contract match spec.
5. **Sign-off**: ghi vào `PHASE_0_SIGNOFF.md`.

### 9.2 Sign-off format

```markdown
# Phase 0 Sign-off

Date: YYYY-MM-DD
Commit: <sha>

Checklist:
- [x] Documentation
- [x] Machine-readable
- [x] Canonical hash
- [x] Domain contracts
- [x] State machines
- [x] Graph
- [x] Adversarial
- [x] FakeModel
- [x] CI
- [x] Dependency direction

Test results:
- Invariants: 120 / 120 pass
- Workspace vectors: 20 / 20 pass
- Adversarial: 7 / 7 variants pass
- Contracts: 20 / 20 pass

Cross-platform:
- Linux: PASS
- macOS: PASS
- Windows: PASS

Signed by:
- Developer: <name>
- Reviewer: <name>
- Architect: <name>

Phase 0: COMPLETE
```

### 9.3 Re-open criteria

Phase 0 re-open nếu:

- Spec thay đổi major.
- Invariant thay đổi major.
- Canonical form bump.
- Breaking change trong domain contract.

---

## 10. Acceptance Checklist (CI-executable)

### 10.1 File structure

```
[ ] docs/INVARIANTS.md
[ ] docs/WORKSPACE_SPEC_v1.0.md
[ ] docs/DOMAIN_CONTRACTS.md
[ ] docs/STATE_MACHINE_SPEC.md
[ ] docs/GRAPH_PROTOCOL.md
[ ] docs/VERIFICATION_PROTOCOL.md
[ ] docs/SECURITY_MODEL.md
[ ] docs/MIGRATION_SPEC.md
[ ] docs/EVALUATION_MODEL.md
[ ] docs/CONTEXT_SPEC_v1.0.md
[ ] docs/INFRASTRUCTURE_SPEC.md
[ ] docs/invariants.yaml
[ ] docs/invariants.schema.json
[ ] docs/scenarios.yaml
[ ] docs/phase_0_checklist.yaml
[ ] docs/PHASE_0_ACCEPTANCE.md
```

### 10.2 Code structure

```
[ ] packages/agent-core/src/domain/
[ ] packages/agent-core/src/state-machine/
[ ] packages/agent-core/src/graph/
[ ] packages/agent-core/src/repositories/
[ ] packages/infrastructure/src/workspace-hash/
[ ] packages/infrastructure/src/workspace-revision/
[ ] packages/infrastructure/src/path/
[ ] packages/testing/src/fake-model/
[ ] packages/testing/src/adversarial/
[ ] packages/testing/src/harness/
```

### 10.3 Test structure

```
[ ] tests/invariants/
[ ] tests/workspace/vectors/
[ ] tests/cross-platform/
[ ] tests/adversarial/variants/
[ ] tests/adversarial/scenarios/
[ ] tests/contracts/
[ ] tests/state-machine/
[ ] tests/graph/
[ ] tests/_harness/
```

### 10.4 CI

```
[ ] .github/workflows/invariants.yml
[ ] .github/workflows/workspace-vectors.yml
[ ] .github/workflows/adversarial.yml
[ ] .github/workflows/contracts.yml
[ ] .github/workflows/dependency-direction.yml
```

### 10.5 Metrics

```
[ ] Invariants CRITICAL ≥ 100
[ ] Workspace vectors = 20
[ ] Adversarial variants ≥ 7
[ ] Adversarial scenarios ≥ 5
[ ] Cross-platform runners = 3
[ ] CI duration < 10 min
[ ] Coverage ≥ 80% reference impl
```

---

## 11. Post-Phase-0 Handoff

### 11.1 Artifacts bàn giao

- 11 spec docs (frozen).
- `invariants.yaml` (frozen).
- Reference implementations (frozen).
- Test harness (extensible).
- CI pipeline (running).

### 11.2 Điều kiện để bắt đầu Phase 1

- Phase 0 sign-off hoàn tất.
- CI green trên 3 OS.
- Không có invariant CRITICAL fail.
- Không có anti-criterion vi phạm.

### 11.3 Những gì Phase 1 sẽ thêm

- Runtime Kernel (Session, Goal, Task, Graph, StateMachine, Scheduler, Budget, Checkpoint, SQLite, EventLog).
- Với **FakeModel**.
- Không cần LLM thật.
- Không cần tool thật.
- Không cần UI.

Phase 1 exit criteria: runtime vượt toàn bộ invariant tests cơ bản.

### 11.4 Những gì Phase 0 KHÔNG bàn giao

- Không có runtime kernel.
- Không có planner.
- Không có tool.
- Không có verification engine.
- Không có recovery.
- Không có UI.

Phase 0 bàn giao **contract**, không bàn giao **implementation**.

---

## 12. North Star

> **Phase 0 kết thúc khi architecture có thể được kiểm tra bằng test, không chỉ đọc bằng mắt.**

Mọi deliverable, mọi acceptance criterion, mọi CI check tồn tại để trả lời:

- **Contract có rõ** không?
- **Invariant có test** không?
- **Cross-platform có ổn** không?
- **Adversarial có bị block** không?
- **Dependency direction có đúng** không?

Và câu hỏi cuối cùng:

> **Nếu ngày mai có người mới vào team, họ có thể chạy test và biết architecture đúng hay sai không?**

Nếu câu trả lời là **có** → Phase 0 hoàn thành.

---

## 13. Recommended Next Steps

Sau khi `PHASE_0_ACCEPTANCE.md` hoàn thành, các bước tiếp theo:

1. **Sinh `invariants.yaml`** từ `INVARIANTS.md`.
2. **Sinh `invariants.schema.json`**.
3. **Sinh domain types** trong `packages/agent-core/src/domain/`.
4. **Sinh reference impl** cho canonical hash.
5. **Sinh test vectors** cho workspace.
6. **Sinh `FakeModel` + `AdversarialModel`** interface.
7. **Sinh CI workflows**.
8. **Chạy Phase 0 acceptance** → sign-off.
9. **Bắt đầu Phase 1** — Runtime Kernel.



# Làm rõ Phase 0: Nó thực sự làm gì, và tại sao?

---

## 1. Câu trả lời ngắn nhất

> **Phase 0 không đảm bảo kiến trúc hoạt động đúng. Phase 0 làm cho kiến trúc có thể kiểm tra được.**

Đây là khác biệt căn bản giữa **checkable** và **correct**.

- **Checkable**: có thể viết test để phát hiện sai.
- **Correct**: thực sự đúng.

Phase 0 chỉ đạt được cái thứ nhất. Cái thứ hai chỉ đạt được sau nhiều vòng implementation + testing + real-world usage.

Nếu tôi nói "Phase 0 test xong thì kiến trúc đúng" — tôi đang nói dối.

---

## 2. Phase 0 thực sự làm gì

Phase 0 làm 5 việc, không hơn:

### 2.1. Biến invariant từ prose thành test

Trước Phase 0:

```
SM-002: RUNNING → PASSED không được phép
        nếu chưa có verification hợp lệ.
```

Sau Phase 0:

```typescript
it('SM-002: rejects RUNNING → PASSED without verification', () => {
  const task = setupTask({ state: 'RUNNING' });
  expect(() => transition(task, 'PASSED')).toThrow('INVALID_TRANSITION');
});
```

Sự khác biệt: **prose có thể hiểu sai. Test thì không.**

### 2.2. Chốt enforcement point

Mỗi invariant phải trả lời: **"Ai chịu trách nhiệm enforce?"**

Nếu không trả lời được → invariant là **ước muốn**, không phải **contract**.

Ví dụ:
- `VR-001` → `VerificationEngine`
- `TG-001` → `ToolGateway`
- `WS-004` → `WorkspaceManager`
- `SM-002` → `StateMachine`

Nếu sau này implementation không có enforcement point đó → biết ngay.

### 2.3. Chốt cross-platform behavior

Canonical hash là ví dụ rõ nhất.

Nếu không test trên 3 OS từ Phase 0 → đến Phase 4 mới phát hiện Windows hash khác Linux → phải viết lại toàn bộ verification logic → **thảm họa**.

### 2.4. Chốt adversarial surface

Liệt kê trước mọi cách model có thể phá runtime.

Nếu không → implement xong mới nghĩ đến → patch vá → nợ kỹ thuật.

### 2.5. Chốt dependency direction

Bằng máy, không bằng lời hứa.

`agent-core` không được import `infrastructure` — CI check, không phải "tôi hứa".

---

## 3. Tại sao cách test này KHÔNG đảm bảo đúng

Đây là phần trung thực nhất.

### 3.1. Test chỉ falsify, không prove

Test không chứng minh đúng. Test chỉ chứng minh **sai** (trong trường hợp cụ thể).

Nếu 100% test pass, có nghĩa:
- Không có bug **mà test bắt được**.

Không có nghĩa:
- Không có bug.
- Runtime sẽ deterministic trong practice.
- LLM không thể bypass.

### 3.2. Phase 0 không có runtime thật

Phase 0 test **contract**, không test **implementation**.

Contract đúng + implementation sai = hệ thống vẫn sai.

Ví dụ:
- Phase 0 nói "ToolGateway enforce policy".
- Phase 1 implement ToolGateway nhưng quên một case.
- Phase 0 test vẫn pass.
- Runtime vẫn bị bypass.

### 3.3. Ta chỉ test được cái ta nghĩ ra

Nếu có attack vector ta chưa nghĩ đến → Phase 0 không test.

Phase 0 không phải oracle. Nó là **best effort** dựa trên hiểu biết hiện tại.

### 3.4. Determinism không tự động

Test có thể pass trên máy này, fail trên máy khác (timing, filesystem, OS).

Cross-platform test giảm thiểu, không loại bỏ.

### 3.5. Adversarial harness không phải model thật

`MaliciousPlanner` là test double, không phải LLM thật.

LLM thật có thể nghĩ ra cách tấn công mà `MaliciousPlanner` không có.

---

## 4. Vậy tại sao vẫn làm Phase 0?

Vì Phase 0 **dịch chuyển lỗi từ runtime sang design time**.

### Không có Phase 0

```
Design ──► Implementation ──► Runtime ──► Bug ở production
              (lỗi ẩn)         (lỗi khó tìm)
```

- Lỗi design không bị phát hiện.
- Lỗi implementation trộn với lỗi design.
- Debug cực khó.

### Có Phase 0

```
Design ──► Contract test ──► Implementation ──► Runtime
              (lỗi bị bắt)     (lỗi bị cô lập)
```

- Lỗi design bị bắt ở Phase 0.
- Lỗi implementation bị cô lập ở Phase 1.
- Debug dễ hơn nhiều.

### Cụ thể hơn

Giả sử có mâu thuẫn giữa `VR-001` (verification bind với revision) và `VR-002` (stale evidence không complete).

- **Không Phase 0**: phát hiện khi verify task fail ở Phase 4 → mất vài ngày debug.
- **Có Phase 0**: phát hiện khi viết `invariants.yaml` → mất vài phút sửa spec.

Đây là giá trị thực của Phase 0: **rẻ**.

---

## 5. Phase 0 đảm bảo gì (chính xác)

| Điều | Phase 0 đảm bảo? |
|---|---|
| Contract không mâu thuẫn | ✅ Có |
| Mỗi invariant có enforcement point | ✅ Có |
| Mỗi invariant có test | ✅ Có |
| Canonical hash cross-platform | ✅ Có |
| Adversarial harness sẵn sàng | ✅ Có |
| Dependency direction enforce được | ✅ Có |
| Implementation đúng | ❌ Không |
| Runtime thực sự deterministic | ❌ Không |
| LLM không bypass được | ❌ Không |
| Không có bug | ❌ Không |

---

## 6. Ví dụ cụ thể: canonical hash

Tại sao test 20 vectors lại quan trọng?

**Kịch bản không test cross-platform:**

1. Phase 1 implement hash trên Linux. Pass.
2. Phase 4 chạy trên Windows. Hash khác.
3. Task `PASSED` trên Linux → `STALE` trên Windows.
4. Verification logic phải viết lại.
5. Mất 2-3 tuần.

**Kịch bản có test cross-platform ở Phase 0:**

1. Phase 0 viết 20 vectors.
2. CI chạy trên 3 OS. Windows fail.
3. Biết ngay: line ending handling sai.
4. Sửa spec.
5. Phase 1 implement đúng ngay từ đầu.

**Test không đảm bảo hash đúng. Test đảm bảo hash nhất quán — và đó là điều cần.**

---

## 7. Điểm yếu của Phase 0

Trung thực:

### 7.1. Có thể over-engineer

Viết 120 invariant khi chưa implement gì → có thể nhiều invariant không cần thiết.

### 7.2. Có thể giả định sai

Spec đúng trên giấy, sai trong practice. Implementation sẽ phát hiện.

### 7.3. Có thể chậm

Phase 0 mất vài tuần. Nếu bỏ qua, có thể bắt đầu code sớm hơn.

Nhưng: **lỗi design ở Phase 4 đắt hơn 10-100 lần so với ở Phase 0.**

### 7.4. Không thay thế testing thực

Phase 0 là **bổ sung**, không phải **thay thế**:
- Phase 1: invariant tests với implementation thật.
- Phase 1.5: adversarial tests với model thật.
- Phase 4: end-to-end với task thật.
- Production: observability + incident response.

---

## 8. Câu trả lời thẳng cho câu hỏi của bạn

> **"Vì sao cách test như thế lại đảm bảo kiến trúc hoạt động đúng?"**

Nó **không** đảm bảo kiến trúc hoạt động đúng.

Nó đảm bảo:

1. **Kiến trúc không tự mâu thuẫn.**
2. **Mọi invariant có chỗ enforce.**
3. **Mọi invariant có test.**
4. **Canonical hash ổn định cross-platform.**
5. **Adversarial surface được liệt kê.**
6. **Dependency direction enforce được.**
7. **Lỗi design bị bắt ở design time, không phải runtime.**

Và quan trọng nhất:

8. **Khi Phase 1 implement sai, ta biết ngay — vì contract đã đứng yên.**

Nếu không có Phase 0, mỗi lần test fail ta không biết:
- Design sai?
- Implementation sai?
- Cả hai?

Có Phase 0, câu trả lời luôn rõ: **design đã freeze, nên đây là lỗi implementation.**

---

## 9. Phép so sánh

Phase 0 giống như **xây móng nhà**:

- Móng không làm nhà đứng vững.
- Nhưng nhà không có móng sẽ sập.
- Móng tốt không đảm bảo nhà đẹp.
- Móng tốt đảm bảo nhà **có thể** đứng vững.

Phase 0 không đảm bảo agent hoạt động đúng. Phase 0 đảm bảo agent **có thể** hoạt động đúng — và nếu sai, ta biết **sai ở đâu**.

---

## 10. North Star (thật)

> **Phase 0 không làm runtime đúng. Phase 0 làm runtime có thể bị chứng minh là sai.**

Một kiến trúc không thể bị chứng minh sai là một kiến trúc không thể tin được.

Và câu hỏi cuối cùng, thành thật:

> **Bạn có sẵn sàng bỏ 2-4 tuần Phase 0 để tiết kiệm 2-4 tháng debug ở Phase 4 không?**

Nếu có → Phase 0 xứng đáng.
Nếu không → bắt đầu code luôn, chấp nhận rủi ro.

Cả hai đều là lựa chọn hợp lệ. Chỉ cần biết mình đang chọn gì.