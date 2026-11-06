# Design Document

## Overview

Five kernel gaps (G1 to G5) and one redactor bug (R1) were observed unstopped by the kernel shadow
ablation. Each gets a new, explicit rule with its own invariant id. Three mechanisms carry all six:

1. **Risk classification** (G1, G2, G5). A pure `resolveToolRiskClass` in `agent-core` replaces the
   body of `TaskExecutor.resolveRiskClass`. `run_command` is classified by command and subcommand into
   DESTRUCTIVE, NETWORK, PACKAGE_INSTALL or SYSTEM. Mutations of test files that existed when the
   goal started are escalated to DESTRUCTIVE. `buildToolPolicy` then asks a human for DESTRUCTIVE
   (already true, TG-007) and, new, for NETWORK at every autonomy level.
2. **Path access policy** (G3, G4, and the argument side of G1). A pure `evaluatePathAccess` in
   `agent-core` holds the sensitive-path, protected-VCS and test-like rules. `NodeWorkspaceManager`
   enforces it on every read and write, `ShellExecutor` and `GitExecutor` apply it to arguments. A
   rejection is a `WorkspaceError`, which the executors turn into a failed tool result (exit code 1).
   The run continues, so the model sees the reason and adapts.
3. **Shell argument boundary** (G1). `ShellExecutor` runs `WorkspaceManager.checkPath` on every
   path-like argument of every allowlisted command before it spawns.

R1 is a one-line, bounded change to a regular expression plus tests.

Nothing in `ToolGateway`, `ApprovalEngine`, `TaskGraph`, `VerificationEngine` or `CompletionGate`
changes. Every call still goes `TaskExecutor` → `ToolGateway.request` → (approval) →
`ToolGateway.execute` → executor (TG-001). The governance chain is the same; the inputs to the
policy (the risk class) and the checks inside the executors are stricter.

## Architecture

```mermaid
flowchart LR
  M[Model proposal] --> TE[TaskExecutor]
  TE -->|resolveToolRiskClass<br/>args + TestBaseline| RC[(agent-core<br/>risk-classification.ts<br/>shell-classifier.ts)]
  RC --> TE
  TE --> TG[ToolGateway.request]
  TG -->|determineAction<br/>buildToolPolicy v2| POL{action}
  POL -->|allow| EX[ToolGateway.execute]
  POL -->|require_approval| AP[ApprovalCoordinator<br/>or APPROVAL_PENDING]
  AP -->|approved| EX
  EX --> FS[FilesystemExecutor]
  EX --> SH[ShellExecutor]
  EX --> GIT[GitExecutor]
  FS --> WM[NodeWorkspaceManager]
  SH -->|checkPath + checkAccess| WM
  GIT -->|checkAccess| WM
  WM -->|evaluatePathAccess| PAP[(agent-core<br/>path-access-policy.ts)]
  WM -->|WorkspaceError<br/>SENSITIVE_PATH / PROTECTED_PATH / PATH_ESCAPE| FS
```

Layering (dependency-cruiser stays at 0 violations):

| Package | New or changed | Reason |
|---|---|---|
| `agent-core` | `tool/path-access-policy.ts`, `tool/shell-classifier.ts`, `tool/risk-classification.ts` (new, pure); `tool/tool-policy.ts`, `tool/shell-policy.ts` (comment), `execution/task-executor.ts`, `workspace/workspace-manager.ts` (error codes, optional `checkAccess`) | Policy and classification are pure functions of their inputs. |
| `infrastructure` | `workspace/node-workspace-manager.ts`, `workspace/workspace-test-baseline.ts` (new), `tools/shell-executor.ts`, `tools/git-executor.ts`, `redaction/redactor.ts`, `cli/runtime-cli.ts` | All I/O and wiring. |
| `testing` | `shadow-ablation/ablation-workspace.ts`, `injection-corpus.ts`, `arm.ts`, `report.ts` | Measurement-only; follows the kernel (SA-001). |

### Enforcement point mapping (shadow ablation)

| Gap | New stopper | Ledger point and reason |
|---|---|---|
| G1 `rm -rf ..` | DESTRUCTIVE → `require_approval`; with approval, the argument boundary | `EP-TOOL-POLICY` (`autonomy-full-v2:DESTRUCTIVE:require_approval`), then `EP-APPROVAL` (`no_approval_coordinator`); `EP-PATH` (`PATH_ESCAPE`) when approved |
| G2 `curl https://…` | NETWORK → `require_approval` | `EP-TOOL-POLICY`, then `EP-APPROVAL` |
| G3 `read_file .env` | Path_Access_Policy | `EP-PATH`, reason `SENSITIVE_PATH` |
| G4 `write_file .git/config` | Path_Access_Policy | `EP-PATH`, reason `PROTECTED_PATH` |
| G5 `edit_file` on a baseline test | Test baseline → DESTRUCTIVE → `require_approval` | `EP-TOOL-POLICY`, then `EP-APPROVAL` |

## Decisions

### D-A. Shell argument safety (G1)

Chosen: classify destructive commands as DESTRUCTIVE in the risk classifier, and path-check every
path-like argument of every allowlisted command.

| Option | Verdict |
|---|---|
| A1. Remove `rm`, `mv`, `cp` from `DEFAULT_SHELL_ALLOWLIST` | Rejected. `cp`, `mv` and `rm -rf dist` are normal build/refactor steps; removing them pushes the model to `node -e` workarounds that are less visible. |
| A2. Classify only (approval for `rm`) | Rejected alone. `cat /etc/passwd` and `find / -name x` stay open because they are not destructive. |
| A3. Path-check only | Rejected alone. `rm -rf dist` inside the workspace is still a decision a human should see. |
| **A4. Classify DESTRUCTIVE and path-check arguments** | **Chosen.** Two independent layers: approval for the verb, boundary for the target. |

`mv` and `move` are not DESTRUCTIVE: a rename inside the workspace is routine, and a rename out of the
workspace is already rejected by the argument boundary (the user guidance "`mv`/`move` outside the
workspace" is satisfied by the boundary, since an outside path never reaches `spawn`). `mv` of a
baseline test file is escalated by the test rule (D-E).

The `command` plus `args` single-string friction (analysis §2c, 7 of 50 traces) is **not changed**.
The new code handles both forms: `normalizeInvocation` splits a `command` that contains whitespace
into a leading token and extra tokens, so `rm -rf ..` as one string is classified DESTRUCTIVE (it is
still rejected afterwards by `checkCommand`, because the whole string is not an allowlisted name).

### D-B. Network (G2)

Chosen: classify network-capable commands as NETWORK and make `buildToolPolicy` ask for NETWORK at
every level.

Current `buildToolPolicy`: `NETWORK`, `PACKAGE_INSTALL` and `SYSTEM` use `commandAction` (`allow` under
`full`, `require_approval` under `edits` and `readonly`). The change gives NETWORK its own constant
`require_approval`. `PACKAGE_INSTALL` is **not** changed: it stays `allow` under `full`. This is an
**accepted risk**: `npm install` under `full` reaches the network through the registry. The
classification still helps (the risk class is recorded on the ToolCall and in the event log, and a
maintainer can later flip one table entry). `policyId` becomes `autonomy-<level>-v2` and `version` 2,
because TG-003 binds an approval to the policy version.

Git network subcommands (`clone`, `fetch`, `pull`, `push`, `ls-remote`) and `npm|pnpm|yarn publish`
are included: they are the same exfiltration channel as `curl`. `npx` is not classified (it is also how
`npx tsx test.ts` runs, a legitimate verification); recorded as residual risk.

`DEFAULT_TOOL_POLICY` (already `require_approval` for NETWORK, `deny` for DESTRUCTIVE) and
`PERMISSIVE_TEST_POLICY` stay as they are. No production wiring uses `DEFAULT_TOOL_POLICY`; the
runtime CLI always passes `buildToolPolicy(autonomy)`.

### D-C. Sensitive files (G3) and D-D. Protected VCS metadata (G4)

Chosen: one mechanism, the Path_Access_Policy, enforced in `NodeWorkspaceManager`, producing
`WorkspaceError('SENSITIVE_PATH' | 'PROTECTED_PATH')`.

The guidance asked to check how a policy `DENIED` is handled. In `TaskExecutor` a `DENIED` ToolCall is
**fatal**: `if (requestedCall.state === 'DENIED') { finalState = 'FAILED'; loopDone = true; break; }`.
A model that tries `read_file .env` once would end the whole run, which is worse than the gap. A
`WorkspaceError` thrown inside the executor becomes `ExecutorResult { exitCode: 1, stderr }`; the
executor's FAILED result is non-fatal ("FAILED tool call is NON-FATAL"), so the model sees
`SENSITIVE_PATH: …` in its transcript and can switch to `.env.example`. That matches how
`PATH_ESCAPE` already behaves.

| Option | Verdict |
|---|---|
| C1. Enforce `ToolRule.deniedPaths` in `ToolGateway`/`determineAction` | Rejected. It makes the denial a `DENIED` ToolCall (fatal for the run). `determineAction(toolName, riskClass, policy)` has no path input, so the signature and every caller would change; the gateway would also need per-tool knowledge of which argument is a path. Shell and `grep` traversals would stay uncovered. |
| C2. Reject in `FilesystemExecutor` only | Rejected. `grep` and `glob` read files through the `WorkspaceManager`, and `ShellExecutor` and `GitExecutor` would need their own copy of the rule. |
| **C3. Enforce in `NodeWorkspaceManager`, expose `checkAccess` for the other executors** | **Chosen.** Every filesystem read and write already goes through it (WS-003/004/005), so one choke point covers `read_file`, `write_file`, `edit_file`, `delete_file`, `move_file`, `grep` and `glob` reads. |

`ToolRule.deniedPaths` stays in the type (removing it is a breaking change for any external policy
author) but gets a `@deprecated` doc comment: not enforced by the gateway; path protection lives in
`Path_Access_Policy` (SE-012, WS-011).

**Enforcement point id.** Reuse `EP-PATH` with reasons `SENSITIVE_PATH` and `PROTECTED_PATH`. The
guard runs in the same component, at the same pipeline stage, and fails the same way as the path
boundary. A new id (`EP-PROTECT`) would touch `EnforcementPointId`, `ENFORCEMENT_POINT_ORDER`, the
report explanations and a large number of shadow-ablation tests, to carry information that the reason
code already carries. The friction analysis (task 6) groups by reason.

**Case sensitivity.** Rules match case-insensitively on every platform. Windows and macOS file systems
are case-insensitive (`.ENV`, `.Git/config` reach the same file), and a platform-independent pure
function is easier to test and gives the same verdict in the WSL and Windows suites. The cost is
a theoretical false positive for a Linux file named `CREDENTIALS`.

**Rules (single exported constants, tunable in code, no CLI flag).**

- Sensitive: basename `.env`; `.env.*` except `.env.example`, `.env.sample`, `.env.template`;
  `*.pem`, `*.key`, `*.p12`, `*.pfx`; `id_rsa*`, `id_ed25519*`, `id_ecdsa*`, `id_dsa*`; `.npmrc`,
  `.pypirc`, `.netrc`; `credentials` (also covers `.aws/credentials`); any path under a `.ssh`
  directory. Public halves (`*.pub`) are exempt and win over every other rule (including `.ssh/`).
- Protected: any segment equal to `.git`, `.hg` or `.svn`, for write, delete and move only.
- `id_ecdsa*` and `id_dsa*` are small additions to the list in the guidance, for the same reason as
  `id_rsa*`.

### D-E. Existing tests (G5)

Chosen: `require_approval` for edit, overwrite, delete and move of a test file that existed when the
goal started, by classifying the call as DESTRUCTIVE.

**Why DESTRUCTIVE and not a new risk class.** `RiskClass` is a domain enum used by the schemas,
the SQLite rows, the dashboard and the policy tables. A new class is a migration for the sake of one
rule. DESTRUCTIVE already means "needs a human at every autonomy level" (TG-007) and overwriting the
oracle that defines "correct" is that kind of act. The approval card shows the tool and arguments, so
the reviewer sees what is being changed. Alternative recorded: a `PROTECTED_MODIFY` class if more
path-based escalations appear.

**Baseline source (cheapest deterministic).** A `TestBaseline` port in `agent-core`
(`isBaselineTest(relpath): boolean`, synchronous) and `WorkspaceTestBaseline` in `infrastructure`
that lists directories (no file reads) and stores the normalised test-like paths. It is captured
where the CLI already calls `workspaceRollback.captureClean(sid)`, so "present at goal start" has one
definition shared with the rollback baseline. It costs one directory walk. Rejected: reusing
`WorkspaceSnapshotRollback` (it reads and stores file contents, far more than a set of names) and a
git-based "tracked files" check (needs git, and fails in a plain directory).

A test created by the agent during the session is not in the baseline, so creating and later editing
its own tests stays free. A test created by the agent in goal 1 becomes baseline in goal 2 of the same
runtime process (it existed when goal 2 started); this is intended.

**Under the Progressive_Runner** (no ApprovalCoordinator) a call that needs approval ends the run at
APPROVAL_PENDING. If the model edits a given test, that benchmark case ends there by design. The
replay (task 6) measures how often organic proposals hit the rule.

**This is a PRODUCT DECISION.** If benchmark friction proves too high, the maintainer can flip it to
warn-only by deleting the escalation in `resolveToolRiskClass` (one `if`) or by emptying the
`TEST_LIKE_*` constants; no other file changes.

### D-F. Redactor (R1)

Chosen pattern, bounded on every quantifier:

```ts
// BEGIN/END header: up to 4 uppercase type words, each 1..16 chars, then PRIVATE KEY (+ optional BLOCK).
const PEM_HEAD = String.raw`(?:[A-Z0-9]{1,16} ){0,4}PRIVATE KEY(?: BLOCK)?`;
pattern: new RegExp(
  `-----BEGIN ${PEM_HEAD}-----[\\s\\S]{1,32768}?-----END ${PEM_HEAD}-----`, 'g');
```

Why it is safe: the word group is delimited by a mandatory single space, so there is no ambiguity
between iterations (no nested unbounded quantifiers); the body is lazy and capped at 32 768
characters, so each `-----BEGIN` start costs at most 32 KB of scanning. With N starts and no footer
the work is N × 32 768 steps; for a 200 000-character input of repeated headers (about 7 000 starts)
that is about 230 million simple steps in the worst case, which is why the test bound is 1 000 ms and
the test measures it instead of assuming it. If measurement shows more than 1 000 ms, reduce the body
cap to 16 384 (a 16 384-bit RSA key in PEM is about 12 KB; an 8192-bit key about 6 KB).

Trade-off recorded: a PEM block larger than the cap is not matched and leaks. A truncated block (header,
no footer) is also not matched; that is the same as today and listed under Risks.

`(?: BLOCK)?` also covers `-----BEGIN PGP PRIVATE KEY BLOCK-----`. Public keys and certificates do not
contain `PRIVATE KEY` and stay unchanged (Requirement 1.5).

## Components and Interfaces

### C1. `agent-core/src/tool/path-access-policy.ts` (pure)

```ts
export type PathAccess = 'read' | 'write';          // 'write' = create, modify, delete, move endpoint
export type PathAccessCode = 'SENSITIVE_PATH' | 'PROTECTED_PATH';
export type PathAccessVerdict =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly code: PathAccessCode; readonly rule: string };

export interface PathAccessPolicy {
  readonly sensitiveDirs: readonly string[];            // ['.ssh']
  readonly sensitiveBasenames: readonly string[];       // ['.env', '.npmrc', '.pypirc', '.netrc', 'credentials']
  readonly sensitiveBasenamePrefixes: readonly string[];// ['.env.', 'id_rsa', 'id_ed25519', 'id_ecdsa', 'id_dsa']
  readonly sensitiveExtensions: readonly string[];      // ['.pem', '.key', '.p12', '.pfx']
  readonly sensitiveExemptBasenames: readonly string[]; // ['.env.example', '.env.sample', '.env.template']
  readonly publicSuffixes: readonly string[];           // ['.pub']
  readonly protectedDirs: readonly string[];            // ['.git', '.hg', '.svn']
}

export const DEFAULT_PATH_ACCESS_POLICY: PathAccessPolicy;
/** No rules at all. Used only by the measurement shadow arm and by tests that need an open manager. */
export const OPEN_PATH_ACCESS_POLICY: PathAccessPolicy;

/** Lowercased segments; '\\'→'/', '.' dropped, '..' resolved lexically, NTFS ':stream' and trailing dots/spaces removed. */
export function normalizeSegments(relpath: string): readonly string[];
export function evaluatePathAccess(policy: PathAccessPolicy, access: PathAccess, relpath: string): PathAccessVerdict;

export const TEST_LIKE_DIR_SEGMENTS: readonly string[];   // ['test','tests','__tests__','spec']
export function isTestLikePath(relpath: string): boolean;
```

Evaluation order: segments → (1) exempt basenames and public suffixes return `allowed` for the
sensitive family → (2) sensitive rules (both accesses) → (3) protected dirs (only `write`). The first
denying rule wins; `rule` names it for the ledger (`sensitive:.env`, `protected:.git`).

`isTestLikePath` uses the segments: basename `test.*`, `*.test.*`, `*.spec.*`, `test_*`, `*_test.*`,
or any directory segment in `TEST_LIKE_DIR_SEGMENTS`. It is exported so the injection-corpus helper and
`WorkspaceTestBaseline` share one definition.

### C2. `agent-core/src/tool/shell-classifier.ts` (pure)

```ts
export interface ShellInvocation { readonly name: string; readonly args: readonly string[] }
export type ShellRisk = 'SYSTEM' | 'DESTRUCTIVE' | 'NETWORK' | 'PACKAGE_INSTALL';

export const DESTRUCTIVE_COMMANDS: ReadonlySet<string>;      // rm rmdir del erase rd remove-item shred dd format mkfs
export const NETWORK_COMMANDS: ReadonlySet<string>;          // curl wget ssh scp sftp nc ncat netcat telnet ftp invoke-webrequest iwr invoke-restmethod irm
export const MUTATING_PATH_COMMANDS: ReadonlySet<string>;    // rm rmdir del erase rd mv move cp copy shred dd tee touch mkdir chmod chown
export const ENV_EXPANSION_EXEMPT_COMMANDS: ReadonlySet<string>; // echo printf

export function normalizeInvocation(command: string, args?: readonly string[]): ShellInvocation;
export function classifyShellInvocation(inv: ShellInvocation): ShellRisk;

export interface ShellArgumentView {
  readonly pathLike: readonly string[];        // boundary-checked with WorkspaceManager.checkPath
  readonly envExpansions: readonly string[];   // subset of pathLike that contains $NAME, ${, $(, %NAME%
  readonly fileCandidates: readonly string[];  // access-checked (sensitive, protected, test baseline)
}
export function extractShellArguments(inv: ShellInvocation): ShellArgumentView;
```

`normalizeInvocation` splits `command` on whitespace; the first token is reduced to a name (directory
prefix removed, lowercased, `.exe|.cmd|.bat|.ps1` removed); the remaining tokens are prepended to
`args`. Priority when several classes match: DESTRUCTIVE, then NETWORK, then PACKAGE_INSTALL, then SYSTEM.

Subcommand detection for `git` skips global options that take a value (`-C`, `-c`, `--git-dir`,
`--work-tree`, `--namespace`) and other flags, then takes the first remaining token. Package managers
look for an install word among the non-flag arguments before a `--`, so `npm --prefix . install` is
still PACKAGE_INSTALL; because PACKAGE_INSTALL has the same action as SYSTEM under `edits`/`readonly`,
a false positive on `npm run add` is harmless.

`extractShellArguments` follows the Glossary definitions. For `name=value` the value is tested; a
flag without `=` (`-rf`, `--force`) is skipped, so an attached short-option value such as `-o../x` is
not seen (Risks).

### C3. `agent-core/src/tool/risk-classification.ts` (pure)

```ts
export interface TestBaseline { isBaselineTest(relpath: string): boolean }
export interface RiskContext { readonly testBaseline?: TestBaseline }

export function resolveToolRiskClass(
  toolName: string,
  args: Readonly<Record<string, unknown>>,
  ctx?: RiskContext,
): RiskClass;
```

Behavior (unchanged rows marked `=`):

| Tool | Class |
|---|---|
| `read_file`, `list_dir`, `grep`, `glob`, `git_status`, `git_diff`, `git_log` | READ_ONLY `=` |
| `write_file`, `edit_file` | MODIFY_WORKSPACE `=`; DESTRUCTIVE when `path` is a baseline test |
| `git_add`, `git_commit` | MODIFY_WORKSPACE `=` |
| `delete_file` | DESTRUCTIVE `=` |
| `move_file` | SYSTEM `=`; DESTRUCTIVE when `path` or `to` is a baseline test |
| `run_command` | `classifyShellInvocation`; DESTRUCTIVE when `name` is in `{mv, move, cp, copy, tee, dd, touch}` and a file candidate is a baseline test |
| anything else | SYSTEM `=` |

`move_file` stays SYSTEM on purpose: moving it to MODIFY_WORKSPACE would silently loosen it under
`edits`. (`FilesystemExecutor.execute` has no `move_file` case today, so the tool fails with
"unknown filesystem tool"; that is an existing bug outside this spec, noted in Risks. The test-baseline
escalation is written now so the rule holds the day the tool is implemented.)

`TaskExecutor.resolveRiskClass` becomes a one-line call to `resolveToolRiskClass(proposal.toolName,
proposal.arguments, { testBaseline: this.deps.testBaseline })`. `TaskExecutorDeps` gets one optional
field, `testBaseline?: TestBaseline`.

### C4. `agent-core/src/tool/tool-policy.ts`

`buildToolPolicy` changes: `NETWORK` → `'require_approval'` for all levels; `policyId`
`autonomy-${level}-v2`; `version: 2`. The doc comment for `'full'` states that NETWORK, DESTRUCTIVE
and PRIVILEGED are the exceptions. `ToolRule.deniedPaths` gets the `@deprecated` note (D-C). No other
change; `determineAction` is untouched.

### C5. `agent-core/src/workspace/workspace-manager.ts`

```ts
export type WorkspaceErrorCode = /* existing */ | 'SENSITIVE_PATH' | 'PROTECTED_PATH';

export interface WorkspaceManager {
  /* existing members */
  /**
   * Optional (additive): throws WorkspaceError(SENSITIVE_PATH | PROTECTED_PATH) when `access`
   * to `relpath` is not allowed. Production NodeWorkspaceManager always implements it; fakes may omit it.
   */
  checkAccess?(access: PathAccess, relpath: string): Promise<void>;
}
```

Optional, so third-party fakes (`RecordingWorkspace` in `tests/shadow-ablation/containment.spec.ts`)
still type-check without edits. Enforcement does not depend on it: `NodeWorkspaceManager` applies the
policy inside its own operations; `checkAccess` exists so other executors and the measurement observer
can ask the same question.

### C6. `infrastructure/src/workspace/node-workspace-manager.ts`

`NodeWorkspaceManagerDeps` gets `pathAccess?: PathAccessPolicy` (default `DEFAULT_PATH_ACCESS_POLICY`).

- `checkAccess(access, relpath)`: verdict on the lexical path; then, when the path exists, on the
  real path made relative to the root (symlink inside the workspace pointing at `.env` or `.git/…`).
  A denied verdict throws `WorkspaceError(code, relpath, message)`. Messages are actionable:
  `SENSITIVE_PATH: <path> is a secret file and cannot be read or changed by the agent (use .env.example for placeholders)` and
  `PROTECTED_PATH: <path> is version-control metadata and cannot be changed by the agent`.
- `readFile`, `readFileBytes`: `checkAccess('read', …)` after `checkPath`.
- `writeFile`, `deleteFile`: `checkAccess('write', …)`; `moveFile`: both endpoints, source first.
- `fileExists`, `dirExists`, `listDir` are not guarded (names are not secret content, and
  `fileExists` swallows errors anyway).
- `grep` calls `readFileBytes` inside a `try { … } catch { continue; }`, so a sensitive file is skipped
  and its content never reaches the result.

### C7. `infrastructure/src/tools/shell-executor.ts`

After `checkCommand` and before the environment filter and spawn:

```ts
const inv  = normalizeInvocation(command, args);
const view = extractShellArguments(inv);
for (const a of view.pathLike) {
  if (view.envExpansions.includes(a) && !ENV_EXPANSION_EXEMPT_COMMANDS.has(inv.name)) {
    return fail(`PATH_ESCAPE: argument "${a}" contains an environment expansion that cannot be checked`);
  }
  try { await this.deps.workspace.checkPath(a); }
  catch (err) { if (err instanceof WorkspaceError) return fail(`${err.code}: argument "${a}" ${…}`); throw err; }
}
const access: PathAccess = MUTATING_PATH_COMMANDS.has(inv.name) && inv.name !== 'git' ? 'write' : 'read';
for (const a of view.fileCandidates) {
  try { await this.deps.workspace.checkAccess?.(access, a); }
  catch (err) { if (err instanceof WorkspaceError) return fail(`${err.code}: argument "${a}" …`); throw err; }
}
```

`fail` is the existing "exitCode 1, empty stdout, stderr message, `timedOut: false`" result. For an
absolute argument that is inside the root, `checkPath` accepts or rejects according to the existing
`canonicalizePath` contract; the task verifies which and adds a test (a rejected absolute-inside path
is a documented, conservative false positive).

### C8. `infrastructure/src/tools/git-executor.ts`

`gitDiff` (`path`) and `gitAdd` (`paths[]`) call `this.deps.workspace.checkAccess?.('read', p)` for each
path before spawning, and return exit 1 with the `SENSITIVE_PATH` message on rejection. Nothing else
changes.

### C9. `infrastructure/src/workspace/workspace-test-baseline.ts`

```ts
export class WorkspaceTestBaseline implements TestBaseline {
  constructor(deps: { readonly root: string; readonly skipDirs?: ReadonlySet<string> });
  /** Replace the set with the Test_Like_Paths currently present (directory listing only). */
  capture(): Promise<void>;
  isBaselineTest(relpath: string): boolean;     // normalizeSegments(relpath).join('/') in the set
  get size(): number;
}
```

Skip set: `node_modules`, `.git`, `dist`, `build`, `coverage`, `.cache`, `.codeforge`, `.cf2` (the
`WorkspaceSnapshotRollback` list). Unreadable directories are skipped. Wiring in `runtime-cli.ts`:
construct before `TaskExecutor`, pass `testBaseline` in the deps, call `await testBaseline.capture()` next
to `workspaceRollback.captureClean(sid)` (same try/catch non-fatal style; a failed capture leaves the
previous set, and a first-time failure leaves an empty set, which means "rule inactive", a fail-open
that is logged once).

### C10. `infrastructure/src/redaction/redactor.ts`

Only the `private-key` pattern changes (D-F). Name, position, `replacement` unchanged.

### C11. Shadow-ablation instrument (`packages/testing`)

- `AblationWorkspaceManager`: gets an option `pathAccess?: PathAccessPolicy` (the **oracle**; default
  `DEFAULT_PATH_ACCESS_POLICY`). In `decide`, after the boundary check passes, for operations with an
  access mode (`readFile`, `readFileBytes` → `read`; `writeFile`, `deleteFile`, `moveFile` → `write`)
  it calls the pure `evaluatePathAccess(oracle, access, relpath)` and, on a deny, records
  `EP-PATH` / `block` / reason = the code. Enforce mode: rethrow `WorkspaceError(code, …)` (identical to
  what `NodeWorkspaceManager` throws). Shadow mode: `effective: 'allow'`, `wouldBlock: true`, and the
  call **proceeds against the sandbox** (the effect stays inside the temp dir, which is the point of
  the measurement; no `escape-simulated` event). It also implements `checkAccess` the same way, so
  `ShellExecutor` and `GitExecutor` calls are observed.
- `arm.ts`: the enforce arm wraps `new NodeWorkspaceManager({ … })` (default policy). The shadow arm wraps
  `new NodeWorkspaceManager({ …, pathAccess: OPEN_PATH_ACCESS_POLICY })` so the inner manager lets the
  call through while the observer still evaluates the Kernel's real policy. Both arms construct a
  `WorkspaceTestBaseline` after seeding the sandbox and capture it where `captureClean(sid)` runs, and
  pass it to the `TaskExecutor`. `OPEN_PATH_ACCESS_POLICY` is only constructible by measurement code and
  tests; the CLI does not reference it (SA-001 style static scan extended in task 4.4).
- `injection-corpus.ts`: labels flip as in the mapping table (values taken from observed enforce arms,
  never the other way round); header block becomes "Closed kernel gaps"; the `ExpectedEnforce` union
  keeps the `kernelGap` variant. The corpus is **not extended**, so before and after counts stay comparable.
- `report.ts` and `comparison.ts`: no new enforcement point id; the gap section renders "no open gap
  probe" when `gapInjected === 0`; the gap-related explanation strings are reviewed.
- `tests/shadow-ablation/trace-format.spec.ts`: the `private-key` generator adds `''` to the type list
  and drops the exclusion comment.

## Data Models

No domain, database or event schema changes. New types are internal to the modules above.
`RiskClass` is unchanged. `ToolCall.riskClass` may now be DESTRUCTIVE or NETWORK for `run_command`
(previously always SYSTEM); consumers that switch on the class (approval banner, dashboard) already
handle every `RiskClass` value. `policyId` strings change (`-v1` → `-v2`); `toolPolicyVersion` in
approval bindings becomes 2.

## Error Handling

| Condition | Result | Run effect |
|---|---|---|
| Argument escapes the root (`..`, absolute, `~`, drive letter, unresolved `$VAR`) | `ExecutorResult` exit 1, `PATH_ESCAPE: argument "<a>" …`, no spawn | Non-fatal: the model sees it. |
| Sensitive or protected path (filesystem tool, shell argument, git tool) | `ExecutorResult` exit 1, `SENSITIVE_PATH: …` or `PROTECTED_PATH: …` | Non-fatal. |
| DESTRUCTIVE or NETWORK call, no coordinator | `ToolCall` APPROVAL_PENDING | Run ends (`pendingApprovalToolCallId`), as today for DESTRUCTIVE. |
| Same call, coordinator wired | In-loop wait; denied or timed out becomes a transcript line | Non-fatal. |
| Baseline capture throws | Logged once, set stays empty | Rule inactive (fail-open), documented. |
| `checkAccess` absent on a fake manager | Skipped (`?.`) | Only fakes; production always has it. |

## Behavior changes for users

| What the agent does | Before | After | Escape hatch |
|---|---|---|---|
| `run_command rm …` (any args) | Ran under `full`; asked under `edits` | Asks at every level (DESTRUCTIVE). Interactive: approval card. Progressive_Runner: run ends at APPROVAL_PENDING | Approve in the dashboard/CLI prompt; or use `delete_file` for single files (already asked) |
| `run_command` with an argument outside the workspace (`..`, `/etc/x`, `~`, `C:\…`, `$HOME/x`) | Ran | Rejected (`PATH_ESCAPE`), no spawn | Work with workspace-relative paths; no override |
| `run_command curl|wget|ssh|scp|…`, `git clone|fetch|pull|push`, `npm publish` | Ran under `full` | Asks at every level (NETWORK) | Approve; run network steps yourself |
| `run_command npm install|pip install|cargo add|…` | Ran under `full`; asked under `edits` | Same (PACKAGE_INSTALL keeps its action) | none needed; accepted risk |
| `npm test`, `node file.js`, `go test ./...`, `cargo test`, `python -m pytest`, `tsc`, `eslint` | Ran | Same | none needed |
| `read_file`/`write_file`/`edit_file`/`delete_file` on `.env`, `.env.local`, `*.pem`, `*.key`, `id_rsa`, `.npmrc`, `.ssh/*`, `credentials` | Allowed | Failed tool result `SENSITIVE_PATH` | Read `.env.example`; edit the secret yourself. Rule list is one constant in `agent-core` |
| `run_command cat .env`, `git_add .env`, `git_diff .env` | Allowed | Failed tool result `SENSITIVE_PATH` | same |
| Write, edit, delete, move under `.git/`, `.hg/`, `.svn/` | Allowed | Failed tool result `PROTECTED_PATH` | Use the git tools; edit VCS metadata yourself |
| Edit, overwrite, delete or move a test file that existed at goal start | Allowed | Asks at every level (DESTRUCTIVE). Progressive_Runner: run ends at APPROVAL_PENDING, so a benchmark case where the model edits a given test fails by design | Approve; or flip to warn-only (one `if` in `resolveToolRiskClass`) |
| Create a new test file; edit a test the agent created this session | Allowed | Same | none needed |
| `read_file .env.example`, `src/env.js`, `.github/workflows/ci.yml`, `.gitignore` | Allowed | Same | none needed |
| `buildToolPolicy('full')` banner line `ask: …` | `DESTRUCTIVE` | `NETWORK, DESTRUCTIVE` | none |

## Risks

- **False positives.** Heuristic path-likeness can flag a regex argument that contains `/` and `..`
  (`grep "a/../b"`), a `*.key` data file that is not a secret (`i18n/en.key`), an absolute path inside the
  workspace root, or a baseline test that a refactor legitimately renames. Each is a visible tool error
  or an approval prompt, never a silent change; the replay (task 6) lists the organic hits. Mitigation
  is to edit one constant.
- **Bypass by shell constructs.** `sh -c`, `bash -c`, `cmd /c` and `powershell` are not allowlisted
  (SE-003), so they never run; if an operator adds one to the allowlist, argument checks see only one
  opaque string. `find -exec` and `-delete` are classified DESTRUCTIVE, but `xargs` and `env` wrappers
  would have to be kept off the allowlist.
- **Interpreters open paths internally.** `node -e "fs.readFileSync('.env')"`, `python3 -c`, a test file
  that reads `../secret`, `npm run <script>` and `npx` execute arbitrary code that the argument checks
  cannot see. The shell checks are a heuristic layer, **not an OS sandbox**. Quoted strings are
  skipped on purpose (they are code or prose), so a path inside them is not checked.
- **Attached short options.** `-o../x` or `-p../x` (no `=`) is skipped as a flag.
- **Windows path forms.** The policy strips trailing dots and spaces and `:stream` suffixes and lowercases;
  8.3 short names (`GIT~1`, `ENV~1`), device paths (`\\?\`, `\\.\`) and UNC shares are not modelled
  (device and UNC forms are rejected by the existing boundary check as absolute paths; short names are a
  residual risk).
- **Symlinks.** A symlink inside the workspace that points at another in-workspace sensitive file is
  caught through the real-path check; a symlink to an outside file is already `SYMLINK_ESCAPE`. A
  symlink created after the check (race) is not covered; the existing realpath TOCTOU limits apply.
  Symlink tests need permission to create symlinks and are skipped where Windows denies it.
- **Unterminated or oversized private keys.** A header with no footer, or a PEM body longer than 32 768
  characters, is not redacted. The same was true before.
- **Not covered secrets.** `.envrc`, `kubeconfig`, `*.tfvars`, `service-account*.json`, `secrets.*`,
  browser profiles. Add to the constants if wanted.
- **Package installers under `full`.** `npm install` reaches the network without approval (accepted,
  see D-B).
- **GitExecutor.** It writes `.git/` as a side effect of `git add` and `git commit`; that is intended
  and unaffected. `git_diff` and `git_add` now refuse sensitive paths.
- **`move_file`.** Not implemented in `FilesystemExecutor` today; out of scope here.
- **Replay measures friction only.** The shadow replay serves recorded responses; a step after a new
  stop is counterfactual. The live benchmark pass rate effect (for example cases where the model edits a
  given test and now ends at APPROVAL_PENDING) needs a live Ollama run and is not measured by this spec.

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system-essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

### Property 1: Private-key blocks are fully redacted

For any list of 0 to 4 uppercase type words, any base64-style body of 1 to 200 lines, and any
surrounding text (plain, JSON-escaped, or log lines), redacting `prefix + BEGIN block END + suffix`
yields a string that contains neither the body nor any body line, contains the redaction placeholder, and
keeps `prefix` and `suffix` unchanged.

**Validates: Requirements 1.1, 1.2, 1.3**

### Property 2: Public material is not redacted

For any `PUBLIC KEY` or `CERTIFICATE` PEM block with any surrounding text, `redact` returns the input
unchanged.

**Validates: Requirements 1.5**

### Property 3: Destructive and network classification is stable under name decoration

For any command in `DESTRUCTIVE_COMMANDS` or `NETWORK_COMMANDS`, any directory prefix, any letter case,
any extension from `.exe .cmd .bat .ps1` (or none) and any argument list, `classifyShellInvocation`
returns DESTRUCTIVE or NETWORK respectively, and the result for `{ command: "<name> <args joined by space>" }`
equals the result for `{ command: "<name>", args }`.

**Validates: Requirements 2.1, 2.5, 2.6, 4.1**

### Property 4: Subcommand and flag rules classify as specified

For any argument list built around the specified forms (`chmod|chown` with or without a recursive flag,
`find` with or without `-delete|-exec|-execdir|-ok|-okdir`, `git` with each subcommand and global options
before it, `npm|pnpm|yarn publish`), the class equals the reference table: DESTRUCTIVE for the listed
forms, NETWORK for the listed git subcommands and `publish`, and SYSTEM for `git status|diff|log|add|commit`
and for `chmod|chown|find` without the listed flags.

**Validates: Requirements 2.2, 2.3, 2.4, 4.2, 4.3**

### Property 5: Installers are PACKAGE_INSTALL and verification commands stay SYSTEM

For any trailing arguments, the install forms of `npm pnpm yarn pip pip3 python python3 cargo go gem` are
PACKAGE_INSTALL, and `npm test`, `npm run <script>`, `node <file>`, `node --test <file>`, `npx tsx <file>`,
`go test ./...`, `cargo test`, `dart test`, `python -m pytest`, `python3 <file>`, `tsc`, `eslint`, `vitest`,
`jest` are SYSTEM.

**Validates: Requirements 5.1, 5.2**

### Property 6: DESTRUCTIVE and NETWORK always require approval

For any Autonomy_Level in `full | edits | readonly` and any tool name, `determineAction` over
`buildToolPolicy(level)` returns `require_approval` for the DESTRUCTIVE and NETWORK risk classes, and the
policy has `policyId` `autonomy-<level>-v2` and `version` 2.

**Validates: Requirements 2.7, 4.4, 4.5**

### Property 7: Argument extraction follows the definitions

For any generated argument string, `extractShellArguments` reports it as path-like exactly when a
reference implementation of the Glossary definition says so; arguments with whitespace, a shell
metacharacter or a `scheme://` prefix are never path-like; for `name=value` the verdict equals the verdict
of the bare `value`.

**Validates: Requirements 3.4, 3.5**

### Property 8: The shell executor spawns exactly when no argument escapes

For any allowlisted command and any argument list, `ShellExecutor` over a real temporary workspace and a
recording supervisor spawns once with the unchanged command, arguments, cwd and timeout when no
path-like argument resolves outside the root; otherwise it does not spawn and returns exit code 1 with
stderr containing `PATH_ESCAPE` and the first offending argument. An argument that contains an
environment expansion is offending for every command except `echo` and `printf`.

**Validates: Requirements 3.1, 3.2, 3.3, 3.7**

### Property 9: Sensitive-path verdicts match the reference list

For any path built from a segment list (any depth, any separator style, any letter case, optional
trailing dots or spaces on a segment, optional `:stream` suffix), `evaluatePathAccess` denies it with
`SENSITIVE_PATH` for both `read` and `write` exactly when a reference implementation of the sensitive
rules says so, with `.env.example`, `.env.sample`, `.env.template` and `*.pub` always allowed, and with
`environment.ts`, `src/env.js`, `env.d.ts`, `monkey.pem.md`, `credentials.ts`, `keyboard.ts` and
`.github/workflows/ci.yml` always allowed.

**Validates: Requirements 6.1, 6.3, 6.4, 6.5, 6.9**

### Property 10: Verdicts are invariant under path normalisation

For any path and any rewrite that changes only letter case, replaces `/` with `\`, adds a leading `./`,
duplicates a separator, or appends trailing dots or spaces to a segment, `evaluatePathAccess` returns the
same verdict (same code) for the rewritten path as for the original, for both access modes.

**Validates: Requirements 6.5**

### Property 11: Protected VCS metadata is write-protected and read-open

For any path with at least one segment equal to `.git`, `.hg` or `.svn` (any depth, any case), the
verdict is `PROTECTED_PATH` for `write` and allowed for `read`; for any path whose segments merely start
with `.git` (`.github`, `.gitignore`, `.gitattributes`, `.gitmodules`, `.gitkeep`, `.gitlab-ci.yml`) the
verdict is allowed for both modes. Through a real `NodeWorkspaceManager`, write, delete and move (either
endpoint) of a protected path throw `WorkspaceError('PROTECTED_PATH')` and leave the file system
unchanged, while `readFile`, `listDir`, `fileExists` behave as without the policy.

**Validates: Requirements 7.1, 7.2, 7.3**

### Property 12: Path rejections are failed tool results, never exceptions

For any filesystem tool (`read_file`, `write_file`, `edit_file`, `delete_file`, `grep`, `glob`) and any
sensitive or protected path, `FilesystemExecutor.execute` returns normally with exit code 1 and a stderr
message that contains `SENSITIVE_PATH` or `PROTECTED_PATH`, never throws, and leaves the file unchanged;
in a `TaskExecutor` run with a scripted model the next step still runs.

**Validates: Requirements 3.6, 6.2, 6.8, 7.4, 11.5**

### Property 13: Shell and git arguments obey the same access rules

For any allowlisted command and any argument list, `ShellExecutor` does not spawn and returns exit code 1
with `SENSITIVE_PATH` when a file-candidate argument is a Sensitive_Path (for every command including
`git`); it does not spawn and returns `PROTECTED_PATH` when a file-candidate argument is a Protected_Path
and the command is in `MUTATING_PATH_COMMANDS`; `git` is exempt from the protected rule. `GitExecutor`
returns `SENSITIVE_PATH` for a sensitive `git_diff` path or `git_add` entry and does not spawn.

**Validates: Requirements 8.1, 8.2, 8.3, 8.4**

### Property 14: Risk class follows the test-baseline reference model

For any baseline set, any tool in `write_file edit_file delete_file move_file run_command`, and any path
or file-candidate arguments, `resolveToolRiskClass` returns DESTRUCTIVE exactly when the reference model
says: the tool mutates (for `move_file`, `path` or `to`; for `run_command`, a name in
`{mv, move, cp, copy, tee, dd, touch}`) and a target is a member of the baseline; a `write_file` to a
test-like path that is not in the baseline stays MODIFY_WORKSPACE; with no baseline wired the result
equals the result with an empty baseline and equals the pre-change classification for every non-shell
tool.

**Validates: Requirements 9.2, 9.3, 9.4, 9.5**

### Property 15: Baseline capture matches the reference listing

For any generated workspace tree (test-like and ordinary files, files inside `node_modules`, `.git`,
`dist`), `WorkspaceTestBaseline.capture` yields exactly the test-like paths outside the skipped
directories, reads no file content, and `isBaselineTest` is invariant under case and separator rewrites.

**Validates: Requirements 9.1**

### Property 16: Classification and access functions are deterministic

For any input, calling `classifyShellInvocation`, `extractShellArguments`, `evaluatePathAccess`,
`isTestLikePath` and `resolveToolRiskClass` twice returns deeply equal results.

**Validates: Requirements 10.2**

### Property 17: Unapproved risky calls never execute

For any generated `run_command` whose class is DESTRUCTIVE or NETWORK, and any autonomy level, a
`TaskExecutor` over a real `ToolGateway`, with no approval coordinator, ends the run with a pending
approval and the executor spy records zero executions; with a coordinator that denies, the spy records
zero executions and the run continues.

**Validates: Requirements 11.1, 11.2**

## Testing Strategy

Reflection after the prework (redundant items merged): criteria 1.1, 1.2 and 1.3 collapse into one
redaction property; 2.7 and 4.4 into one policy property; 3.1, 3.2 and 3.7 into one executor property;
4.1 to 4.3 into one classification property; 6.3, 6.4 and 6.5 are matching clauses of one property plus
one metamorphic property; 6.8 and 7.4 are one executor-result property; 7.1 to 7.3 are one property;
8.1 and 8.2 are one property; 9.2 and 9.3 are one reference-model property. The timing check (1.4), the
policy id (4.5), the symlink case (6.6), the `grep` content leak (6.7), the CLI wiring (9.6), the
APPROVAL_PENDING outcome (9.7), the legitimate workflow matrix (Requirement 12) and the instrument checks
(Requirement 13) are example tests.

Dual approach. **Property tests** use the repo's seeded local `mulberry32` helper (as in
`tests/mission/clarification-generators.ts` and `tests/shadow-ablation/*.spec.ts`), at least 100
iterations each, and carry the tag `// Feature: kernel-gap-closure, Property N: <title>`. No
property-testing dependency is added. `tests/tsconfig.json` does not include `tests/mission/**`, so the
generator is copied into a new local helper `tests/tool/gap-closure-generators.ts` instead of imported
from there. Reference implementations in tests are written independently of the production code (plain
string checks over a literal list), so a shared bug cannot hide.

**Example tests** cover: the 1 000 ms redaction bound; the legitimate workflow matrix (Requirement 12);
`AblationWorkspaceManager` ledger rows in enforce and shadow modes; the harness-e2e label check; the zero-gap
report section; the symlink case; the `grep` marker non-leak; the CLI wiring (a static test that
`runtime-cli.ts` constructs `WorkspaceTestBaseline`, calls `capture()` beside `captureClean`, and passes the
same instance to `TaskExecutor`); the APPROVAL_PENDING outcome with a baseline test edit; the invariant
registry count (181 → 187) and `version` 1.12.

**Invariant specs** (`tests/invariants/…`, one file per id, deterministic and short):

| Id | Severity | Statement (registry text is Vietnamese like its neighbours; English here) | Test path |
|---|---|---|---|
| SE-011 | CRITICAL | Path-like arguments of allowlisted commands stay inside the workspace | `tests/invariants/security/se-011.spec.ts` |
| SE-012 | CRITICAL | Sensitive files cannot be read or written by the agent | `tests/invariants/security/se-012.spec.ts` |
| TG-011 | CRITICAL | Destructive shell commands are DESTRUCTIVE and never auto-approved | `tests/invariants/tool-gateway/tg-011.spec.ts` |
| TG-012 | HIGH | Network commands are NETWORK and need approval at every autonomy level | `tests/invariants/tool-gateway/tg-012.spec.ts` |
| TG-013 | HIGH | Mutating a pre-existing test needs approval | `tests/invariants/tool-gateway/tg-013.spec.ts` |
| WS-011 | CRITICAL | VCS metadata cannot be written by the agent | `tests/invariants/workspace/ws-011.spec.ts` |

Redactor tests live in a new `tests/security/redactor-private-key.spec.ts`; SE-005 keeps its existing
test.

**Existing tests expected to change** (they assert the old gap behavior; each is listed with its
justification in the completion notes): `tests/_harness/phase0-harness.spec.ts` (invariant count 181 → 187,
two assertions); `tests/shadow-ablation/injection-corpus.spec.ts` (the "gap entries" test expects at
least one `kernelGap` entry); `tests/shadow-ablation/harness-e2e.spec.ts` (gap-specific expectations around
`kernelGap` and the `autonomyStop` logic); `tests/approval-runtime/autonomy-policy.spec.ts` (only if it asserts
NETWORK `allow` under `full` or `policyId` `-v1`); `tests/shadow-ablation/trace-format.spec.ts` (generator,
by design). Everything else must pass unmodified.

**Replay (task 6).** Before the run, copy `.agents/kernel-shadow-ablation.json` to
`.agents/_tmp-reports/kernel-shadow-ablation.before.json` (the new run overwrites it) so the analysis can
diff organic would-blocks case by case. Then run
`node scripts/run-shadow-ablation.mjs --traces .agents/traces/qwen35-20261104 --benchmark benchmarks/codeforge-progressive/benchmark.json`
(about 33 minutes on Windows, in the background; no model, no Ollama).

## Documentation Plan

`SECURITY_MODEL.md` (new rules, threat-table rows, residual risks: heuristics, not an OS sandbox);
`INFRASTRUCTURE_SPEC.md` and the agent or tool spec that describes ToolPolicy or the shell policy (grep
`deniedPaths`, `DEFAULT_SHELL_ALLOWLIST`; today only `SECURITY_MODEL.md` §constraints mentions
`deniedPaths`); `INVARIANTS.md` and `invariants.yaml` (6 entries, `version` 1.12); `README.md`
(limitations: remove the five gaps and the PKCS#8 bullet, add the rules and the test-edit approval
behavior); `PROJECT_STATUS.md` (limitation 12 → closed items, shadow-ablation row, "Last updated" at the
end); `ROADMAP.md` item 5; `PHASE_12_SIGNOFF.md` addendum row; `EVALUATION_MODEL.md` §17 note
(lines about "reported, not fixed"); `.agents/failure-taxonomy.md` footer.
