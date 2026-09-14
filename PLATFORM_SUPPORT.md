# PLATFORM_SUPPORT.md

**Ollama Coding Agent — Platform Matrix, Adapters & Constraints**

Version: 1.0
Status: Architecture Baseline
Owner: infrastructure / PlatformAdapter
Scope: Windows 11 + Ubuntu (WSL2)
Explicitly out of scope: macOS, Windows 10, other Linux distros (v1)
Related specs:
`INVARIANTS.md` (WS-*, SE-*, CP-*), `WORKSPACE_SPEC_v1.0.md`,
`INFRASTRUCTURE_SPEC.md`, `SECURITY_MODEL.md`, `PHASE_0_ACCEPTANCE.md`

---

## 0. Mục đích

File này định nghĩa **platform support matrix** cho Ollama Coding Agent v1.

Nguyên tắc trung tâm:

> **Support ít platform nhưng support đúng. Không nói dối về cái chưa test.**

v1 **chỉ support**:

- **Windows 11** (native host)
- **Ubuntu trên WSL2** (primary development & execution)

v1 **không support**:

- macOS
- Windows 10
- Linux native (không qua WSL2)
- Các distro khác

File này định nghĩa:

- platform matrix;
- rationale;
- WSL2-specific considerations;
- PlatformAdapter interface;
- path / process / filesystem differences;
- line endings;
- shell strategy;
- CI matrix;
- risk assessment;
- deferred items;
- invariant mapping;
- test matrix.

---

## 1. Platform Matrix

### 1.1 v1 Supported Platforms

| Platform | Status | Role | Node | Shell |
|---|---|---|---|---|
| **Windows 11** | Supported | Host OS, native execution | 20 LTS | PowerShell 7+ |
| **Ubuntu 22.04+ (WSL2)** | Supported | Primary dev, primary execution | 20 LTS | bash |

### 1.2 v1 Non-Supported Platforms

| Platform | Status | Reason |
|---|---|---|
| macOS | Deferred (v2) | No Apple hardware |
| Windows 10 | Not tested | May work, unsupported |
| Linux native (bare metal) | Not tested | WSL2 is target |
| Debian / Fedora / Arch | Not tested | WSL2 Ubuntu only |
| Alpine / musl | Not tested | glibc target |

### 1.3 Support tiers

| Tier | Meaning | Test requirement |
|---|---|---|
| **Tier 1** | Fully supported, CI-tested | CI pass required |
| **Tier 2** | Supported, manual-tested | Manual check before release |
| **Tier 3** | Best-effort, no guarantee | No test required |
| **Tier 4** | Unsupported | No test, no support |

v1:
- Windows 11 → **Tier 1**
- Ubuntu WSL2 → **Tier 1**
- Everything else → **Tier 4**

---

## 2. Rationale

### 2.1 Tại sao Windows + WSL2?

1. **Developer hardware**: chỉ có Windows.
2. **WSL2 là Linux thật**: kernel thật, không phải emulation.
3. **Coverage**: Windows (NTFS, Win32) + Linux (ext4, POSIX) cover 2 họ hệ điều hành khác nhau.
4. **Realistic**: 90%+ user của coding agent dùng Windows hoặc Linux.

### 2.2 Tại sao không macOS?

1. **Không có hardware**: Apple cấm virtualize macOS trên non-Apple hardware.
2. **Không test được**: không thể verify.
3. **Không thể "hỗ trợ" cái chưa test**: đó là nói dối.
4. **Defer không mất gì**: có thể thêm sau.

### 2.3 Tại sao không Linux native?

1. **WSL2 đủ giống**: kernel 5.15+, glibc, ext4.
2. **Không có hardware Linux riêng**: chỉ có Windows.
3. **Khác biệt chính**: systemd, mount options, network namespace — không critical cho v1.

### 2.4 Trade-offs chấp nhận

| Trade-off | Impact | Mitigation |
|---|---|---|
| Không support macOS | Mất user macOS | Docs rõ ràng, defer v2 |
| Không support Linux native | Mất user server | WSL2 ổn, có thể thêm sau |
| Không support Windows 10 | Mất user cũ | Windows 11 phổ biến |
| WSL2-specific bugs | Có thể miss Linux native bugs | Test với container CI |

---

## 3. WSL2 Considerations

### 3.1 WSL2 là gì

- Linux kernel thật (Microsoft fork).
- Chạy trong lightweight VM.
- Filesystem: ext4 ảo.
- Network: NAT với host.
- Interop: gọi được Windows binary từ Linux.

### 3.2 Filesystem layout

```
Windows host:
  C:\Users\<user>\projects\    ← Windows filesystem (NTFS)

WSL2:
  /home/<user>/projects/       ← WSL2 filesystem (ext4)
  /mnt/c/Users/<user>/projects/ ← Windows filesystem mounted
```

### 3.3 Rule: code trong WSL2 filesystem

**Bắt buộc** đặt project trong `/home/<user>/...`, **không** trong `/mnt/c/...`.

Lý do:

| Aspect | `/home/` (ext4) | `/mnt/c/` (NTFS qua 9p) |
|---|---|---|
| I/O speed | Native | 3–10x chậm hơn |
| File watching | Fast | Chậm, miss events |
| Permissions | POSIX đúng | Windows ACL |
| Symlinks | Native | Hạn chế |
| Case sensitivity | Sensitive | Insensitive (kế thừa Windows) |

**Enforcement**: WorkspaceManager phải warn nếu workspace root nằm trong `/mnt/c/`.

### 3.4 Interop

WSL2 có thể:

- Gọi Windows binary: `notepad.exe`, `powershell.exe`.
- Truy cập Windows filesystem: `/mnt/c/`.
- Dùng Windows network.

WSL2 **không** có:

- systemd (mặc định, có thể bật).
- Native Windows GUI.
- Access tới Windows services.

### 3.5 Network

- WSL2 có IP riêng.
- Ollama trên Windows host → WSL2 phải gọi qua host IP.
- Hoặc chạy Ollama trong WSL2.

**Khuyến nghị**: chạy Ollama trong WSL2 để giảm network complexity.

---

## 4. PlatformAdapter Interface

### 4.1 Interface

```typescript
interface PlatformAdapter {
  // Identification
  platform(): 'win32' | 'linux';
  isWsl(): boolean;
  isWsl2(): boolean;
  distro(): string | null;         // "ubuntu-22.04" cho WSL2

  // Paths
  pathSeparator(): '/' | '\\';
  canonicalSeparator(): '/';       // luôn '/' trong domain
  isCaseSensitive(): boolean;
  homeDir(): string;
  tmpDir(): string;

  // Process
  processModel(): 'posix' | 'win32';
  shell(): ShellInfo;
  canSendSignals(): boolean;
  terminateProcess(pid: number, graceful: boolean): Promise<void>;

  // Filesystem
  supportsSymlinks(): boolean;
  supportsFileMode(): boolean;
  maxPathLength(): number;

  // Environment
  env(): EnvInfo;
}

interface ShellInfo {
  kind: 'bash' | 'powershell' | 'cmd';
  executable: string;
  argsPrefix: string[];            // e.g., ['-c'] cho bash
  escapeQuotes(s: string): string;
}

interface EnvInfo {
  allowlist(): Record<string, string>;
  platformVars(): Record<string, string>;
}
```

### 4.2 Implementations

- `WindowsPlatformAdapter` — Windows 11 native.
- `WslPlatformAdapter` — Ubuntu trên WSL2.

Detection:

```typescript
function detectPlatform(): PlatformAdapter {
  if (process.platform === 'win32') {
    return new WindowsPlatformAdapter();
  }
  if (process.platform === 'linux') {
    if (isWsl()) {
      return new WslPlatformAdapter();
    }
    throw new UnsupportedPlatformError('linux-native');
  }
  throw new UnsupportedPlatformError(process.platform);
}
```

### 4.3 Feature differences

| Feature | Windows | WSL2 |
|---|---|---|
| Case sensitive FS | ❌ | ✅ |
| Symlink (không cần admin) | ❌ | ✅ |
| File mode (chmod) | ⚠️ (limited) | ✅ |
| POSIX signals | ❌ | ✅ |
| `fork()` semantics | ❌ | ✅ |
| Native `kill` | ⚠️ | ✅ |
| Max path length | 260 (default) | 4096 |
| CRLF default | ✅ | ❌ |

---

## 5. Path Semantics

### 5.1 Canonical form

**Trong domain**: luôn dùng `/` separator.

```typescript
interface WorkspaceRevision {
  root: string;                    // canonical, '/'-separated
  // ...
}
```

**Trên disk**: dùng separator theo OS.

### 5.2 Path conversion

```typescript
function toCanonical(path: string, platform: PlatformAdapter): string {
  // Convert to domain form: always '/'
  return path.replace(/\\/g, '/');
}

function toNative(path: string, platform: PlatformAdapter): string {
  if (platform.platform() === 'win32') {
    return path.replace(/\//g, '\\');
  }
  return path;
}
```

### 5.3 Windows-specific

- Long path prefix `\\?\` — reject ngoài policy.
- UNC path `\\server\share` — reject.
- Drive letter `C:\` — normalize thành `/c/` khi vào WSL2.
- Reserved names: `CON`, `PRN`, `AUX`, `NUL`, `COM1-9`, `LPT1-9` — reject.

### 5.4 WSL2-specific

- `/mnt/c/...` → Windows filesystem, chậm, case-insensitive.
- `/home/...` → WSL2 filesystem, nhanh, case-sensitive.
- `/mnt/wsl/...` → shared mounts, không stable.

**Enforcement**: WorkspaceManager **reject** workspace root trong `/mnt/c/` cho performance critical operations.

---

## 6. Process Semantics

### 6.1 Process model

| Aspect | Windows | WSL2 |
|---|---|---|
| Process model | Win32 | POSIX |
| Signals | ❌ | ✅ (SIGTERM, SIGKILL, ...) |
| Process tree | Job Objects | Process groups |
| Kill graceful | `TerminateProcess` | `SIGTERM` → `SIGKILL` |
| Orphan detection | Job Objects | Parent PID check |
| PID reuse | Fast | Slow |

### 6.2 ProcessSupervisor abstraction

```typescript
interface ProcessSupervisorAdapter {
  spawn(request: SpawnRequest): Promise<ProcessHandle>;
  killTree(handle: ProcessHandle): Promise<void>;
  wait(handle: ProcessHandle): Promise<ProcessResult>;
  listOrphans(sessionId: string): Promise<ProcessHandle[]>;
  cleanupOrphans(): Promise<OrphanReport>;
}
```

### 6.3 Windows implementation

- Dùng **Job Objects** để đảm bảo process tree chết theo parent.
- `TerminateProcess` không graceful → phải tự cleanup.
- Không có signal → dùng exit code + timeout.
- Process tree tracking qua Job Object API.

### 6.4 WSL2 implementation

- Dùng **process group** (`setsid`, `setpgid`).
- `SIGTERM` → wait 5s → `SIGKILL`.
- Process tree tracking qua `/proc/<pid>/task/<tid>/children`.
- Orphan cleanup qua session tracking.

### 6.5 Signal abstraction

```typescript
async function terminateGracefully(
  handle: ProcessHandle,
  platform: PlatformAdapter,
): Promise<void> {
  if (platform.processModel() === 'posix') {
    await kill(handle.pid, 'SIGTERM');
    await waitForExit(handle, 5000);
    await kill(handle.pid, 'SIGKILL');
  } else {
    // Windows: no graceful signal
    await terminateProcess(handle.pid);
  }
}
```

---

## 7. Filesystem Semantics

### 7.1 Case sensitivity

| Platform | FS | Case |
|---|---|---|
| Windows 11 | NTFS | Insensitive |
| WSL2 `/home/` | ext4 | Sensitive |
| WSL2 `/mnt/c/` | 9p → NTFS | Insensitive |

**Rule**: detect case sensitivity của workspace root tại runtime, không hardcode.

```typescript
async function detectCaseSensitivity(root: string): Promise<boolean> {
  // Create temp file "test", check if "TEST" resolves
  // ...
}
```

**Enforcement**: nếu case-insensitive và có case collision → reject commit.

### 7.2 Symlinks

| Platform | Symlink |
|---|---|
| Windows 11 (Dev Mode) | ✅ (cần admin/dev mode) |
| Windows 11 (no Dev Mode) | ❌ |
| WSL2 `/home/` | ✅ |
| WSL2 `/mnt/c/` | ⚠️ (hạn chế) |

**Rule**: 
- Detect symlink support tại runtime.
- Nếu không support → reject operations cần symlink.
- Không assume symlink.

### 7.3 File permissions

| Platform | chmod |
|---|---|
| Windows 11 | ⚠️ (chỉ read-only flag) |
| WSL2 | ✅ |

**Rule**: 
- Không dùng chmod cho security.
- Chỉ dùng cho executable bit (WSL2).
- Windows: dùng ACL nếu cần.

### 7.4 File mode trong canonical hash

**v1**: file mode **không** đóng góp vào hash.

Lý do: Windows không có POSIX mode → cross-platform mismatch.

**v2**: có thể thêm nếu cần, với canonical form bump.

---

## 8. Line Endings

### 8.1 Default

| Platform | Default |
|---|---|
| Windows | CRLF (`\r\n`) |
| WSL2 | LF (`\n`) |

### 8.2 Policy

**Trong workspace**: line ending là **content**, không normalize.

- File có CRLF → hash theo CRLF.
- File có LF → hash theo LF.
- File có mixed → hash theo mixed.

Lý do: EOL là thay đổi thật, không được che giấu.

### 8.3 Git integration

- `.gitattributes` khuyến nghị:
  ```
  * text=auto eol=lf
  *.bat text eol=crlf
  *.ps1 text eol=crlf
  ```
- Không force normalize.
- Test vector phải dùng **binary fixture**, không checkout qua Git.

### 8.4 Editor config

- `.editorconfig` khuyến nghị:
  ```
  root = true
  [*]
  end_of_line = lf
  insert_final_newline = true
  ```

Không bắt buộc, chỉ khuyến nghị.

---

## 9. Shell Strategy

### 9.1 Decision: WSL2-first

**v1 chọn WSL2-first** cho execution:

- Agent chạy trên WSL2.
- Shell tools dùng **bash**.
- Windows native chỉ là host cho VS Code.

### 9.2 Rationale

1. **Đơn giản**: một shell model duy nhất.
2. **Realistic**: code repos target Linux.
3. **Tool compatibility**: hầu hết dev tools (npm, dart, git) chạy tốt trên Linux.
4. **Ollama**: chạy tốt trên WSL2.

### 9.3 Windows native scope

Windows native **chỉ dùng** cho:

- VS Code host.
- GUI operations (Phase 8).
- Computer use (Phase 8).
- File system access ngoài WSL2 (nếu cần).

**Không** dùng cho:

- Shell execution.
- Build.
- Test.

### 9.4 Shell info

```typescript
interface ShellInfo {
  kind: 'bash';
  executable: '/bin/bash';
  argsPrefix: ['-c'];
  escapeQuotes(s: string): string; // ' -> '\''
}
```

### 9.5 Future: dual shell

v2 có thể support PowerShell nếu có nhu cầu. v1 không.

---

## 10. Environment

### 10.1 Environment allowlist

**WSL2**:

```typescript
const WSL2_ALLOWLIST = [
  'PATH', 'HOME', 'USER', 'SHELL', 'LANG', 'LC_*', 'TERM',
  'NODE_*', 'NPM_*', 'DART_*', 'PUB_*',
  'OLLAMA_*',
];
```

**Windows native** (nếu cần):

```typescript
const WINDOWS_ALLOWLIST = [
  'PATH', 'USERPROFILE', 'USERNAME', 'TEMP', 'TMP',
  'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT',
  'NODE_*', 'NPM_*',
];
```

### 10.2 Denylist

Luôn exclude:

- `AWS_*`, `GCP_*`, `AZURE_*`
- `*_SECRET`, `*_KEY`, `*_PASSWORD`, `*_TOKEN`
- `GITHUB_TOKEN`, `GITLAB_TOKEN`, `NPM_TOKEN`, `PYPI_TOKEN`
- `SSH_*`, `KUBECONFIG`
- `DATABASE_URL`

### 10.3 Redaction

Trước khi ghi log/artifact/provenance:

- Redact secret theo patterns (`SECURITY_MODEL.md` §7.2).
- WSL2 và Windows đều phải redact.

---

## 11. CI Matrix

### 11.1 GitHub Actions

```yaml
name: CI
on: [push, pull_request]

jobs:
  test:
    strategy:
      fail-fast: false
      matrix:
        include:
          - os: windows-latest
            shell: pwsh
            platform: windows
          - os: ubuntu-latest
            shell: bash
            platform: linux
    runs-on: ${{ matrix.os }}
    defaults:
      run:
        shell: ${{ matrix.shell }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - run: npm ci
      - run: npm run test:invariants
      - run: npm run test:workspace-vectors
      - run: npm run test:adversarial
      - run: npm run test:contracts
```

### 11.2 Local CI

Local WSL2 có thể chạy:

- Linux tests trực tiếp.
- Windows tests qua `powershell.exe` từ WSL2 (nếu cần).

**Khuyến nghị**: local test trên WSL2, cross-check Windows native trước push.

### 11.3 Requirements

| Requirement | Windows | WSL2 |
|---|---|---|
| Node 20 LTS | ✅ | ✅ |
| npm 10+ | ✅ | ✅ |
| Git 2.40+ | ✅ | ✅ |
| Ollama | ✅ | ✅ (khuyến nghị) |
| Dart (Phase 4) | ⚠️ | ✅ |

---

## 12. Risk Assessment

### 12.1 macOS defer

| Risk | Probability | Impact | Mitigation |
|---|---|---|---|
| Case-insensitive bug | Medium | High | Test trên Windows (cũng insensitive) |
| CRLF handling | Low | Medium | Test vector |
| Symlink bug | Low | Low | Không dùng symlink trên macOS |
| APFS-specific bug | Very low | Low | Không có gì đặc biệt |

**Overall**: rủi ro chấp nhận được. Windows cover 80% case-insensitive cases.

### 12.2 Linux native defer

| Risk | Probability | Impact | Mitigation |
|---|---|---|---|
| systemd-specific | Low | Low | Không dùng systemd |
| Mount option | Low | Low | Không mount đặc biệt |
| Network namespace | Low | Low | Không dùng |
| Kernel version | Low | Low | WSL2 kernel 5.15+ |

**Overall**: rủi ro thấp.

### 12.3 Windows 10 defer

| Risk | Probability | Impact | Mitigation |
|---|---|---|---|
| Path length 260 | Medium | Medium | Enable long path |
| Older WSL1 | Medium | High | Require WSL2 |
| Older PowerShell | Low | Low | Require PS 7+ |

**Overall**: khuyến nghị user dùng Windows 11.

### 12.4 WSL2-specific

| Risk | Probability | Impact | Mitigation |
|---|---|---|---|
| 9p performance | High | Medium | Require `/home/` |
| WSL2 IP changes | Medium | Low | Detect at runtime |
| Memory limit | Medium | Medium | Configure `.wslconfig` |
| Kernel panic | Low | High | Restart WSL |

**Overall**: manageable với hướng dẫn user.

---

## 13. Deferred Items

### 13.1 macOS (v2)

**Deferred until**: có hardware hoặc cloud macOS.

**Plan**:
1. Test canonical hash trên APFS.
2. Test process model (POSIX, Darwin).
3. Test case-insensitive FS.
4. Test symlink.
5. CI runner `macos-latest`.

**Effort estimate**: 2–3 tuần sau khi có hardware.

### 13.2 Linux native (v2)

**Deferred until**: có nhu cầu.

**Plan**:
1. Test systemd integration.
2. Test mount options.
3. Test network namespace.
4. CI runner với multiple distros.

**Effort estimate**: 1–2 tuần.

### 13.3 Windows 10 (v3)

**Deferred until**: có nhu cầu.

**Plan**:
1. Test long path.
2. Test PowerShell 5.
3. Document limitations.

### 13.4 Other Linux distros (v3)

**Deferred until**: có nhu cầu.

**Plan**:
1. Test trên Fedora, Debian, Arch.
2. Document differences.

---

## 14. Documentation Requirements

### 14.1 User-facing docs

Phải có:

- `README.md` — platform requirement.
- `INSTALL.md` — cài đặt trên Windows + WSL2.
- `TROUBLESHOOTING.md` — lỗi phổ biến.

### 14.2 Disclaimers

**Bắt buộc** trong README:

```markdown
## Platform Support

This version supports:
- Windows 11 (native)
- Ubuntu 22.04+ (WSL2)

Not supported in this version:
- macOS (planned for v2)
- Windows 10
- Linux native (bare metal)
- Other Linux distros

If you use an unsupported platform, the agent may not work correctly.
We cannot provide support for untested platforms.
```

### 14.3 WSL2 setup guide

**Bắt buộc** hướng dẫn:

```markdown
## WSL2 Setup

1. Enable WSL2: `wsl --install -d Ubuntu-22.04`
2. Update: `sudo apt update && sudo apt upgrade`
3. Install Node 20: `curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt install -y nodejs`
4. Install Git: `sudo apt install -y git`
5. Clone project **trong `/home/`**, không trong `/mnt/c/`
6. Install Ollama: `curl -fsSL https://ollama.ai/install.sh | sh`
7. Verify: `ollama run qwen2.5-coder:7b "hello"`
```

---

## 15. Invariant Mapping

| Invariant | Platform Enforcement |
|---|---|
| WS-001 | §5.1 canonical form |
| WS-002 | §8.2 line ending policy |
| WS-003 | §5.3, §5.4 path rules |
| WS-004 | §7.2 symlink rules |
| WS-005 | §6 process boundary |
| WS-006 | §7.3 file permissions |
| WS-007 | §3.3 scratch in WSL2 FS |
| SE-004 | §10 env allowlist |
| SE-005 | §10.3 redaction |
| SE-007 | §6 process timeout |
| SE-008 | §6.3, §6.4 process tree |
| CP-005 | §6.5 orphan cleanup |
| CP-006 | §6.5 cancellation |
| DC-001 | PlatformAdapter không trong domain |

---

## 16. Test Matrix

### 16.1 Path tests

| Test | Windows | WSL2 |
|---|---|---|
| `path-canonical-slash` | ✅ | ✅ |
| `path-canonical-backslash` | ✅ | ✅ |
| `path-long-windows` | ✅ | n/a |
| `path-reserved-name` | ✅ | n/a |
| `path-mnt-c-warning` | n/a | ✅ |
| `path-unc-reject` | ✅ | n/a |

### 16.2 Process tests

| Test | Windows | WSL2 |
|---|---|---|
| `process-spawn-simple` | ✅ | ✅ |
| `process-tree-kill` | ✅ (Job Objects) | ✅ (process group) |
| `process-timeout` | ✅ | ✅ |
| `process-orphan-cleanup` | ✅ | ✅ |
| `process-signal-term` | n/a | ✅ |
| `process-graceful-kill` | n/a | ✅ |

### 16.3 Filesystem tests

| Test | Windows | WSL2 |
|---|---|---|
| `fs-case-sensitive-detect` | ✅ | ✅ |
| `fs-case-collision-reject` | ✅ | ✅ |
| `fs-symlink-support-detect` | ✅ | ✅ |
| `fs-symlink-escape-reject` | ✅ | ✅ |
| `fs-file-mode` | ⚠️ | ✅ |

### 16.4 Hash tests

| Test | Windows | WSL2 |
|---|---|---|
| `hash-empty` | ✅ | ✅ |
| `hash-single-file` | ✅ | ✅ |
| `hash-crlf` | ✅ | ✅ |
| `hash-lf` | ✅ | ✅ |
| `hash-unicode-nfc` | ✅ | ✅ |
| `hash-symlink-internal` | ✅ | ✅ |
| `hash-scratch-excluded` | ✅ | ✅ |

### 16.5 Line ending tests

| Test | Windows | WSL2 |
|---|---|---|
| `eol-crlf-hash-differs` | ✅ | ✅ |
| `eol-lf-hash-differs` | ✅ | ✅ |
| `eol-mixed-hash` | ✅ | ✅ |

### 16.6 Shell tests

| Test | Windows | WSL2 |
|---|---|---|
| `shell-bash-available` | n/a | ✅ |
| `shell-no-injection` | n/a | ✅ |
| `shell-env-allowlist` | n/a | ✅ |
| `shell-cwd-boundary` | n/a | ✅ |

### 16.7 PlatformAdapter tests

| Test | Windows | WSL2 |
|---|---|---|
| `adapter-detect-windows` | ✅ | n/a |
| `adapter-detect-wsl2` | n/a | ✅ |
| `adapter-reject-macos` | ✅ | ✅ |
| `adapter-reject-linux-native` | n/a | ✅ |
| `adapter-is-wsl` | ✅ | ✅ |

---

## 17. Adversarial Tests

| Adversary | Attempt | Expected |
|---|---|---|
| Unsupported platform | Run on macOS | Reject at startup |
| Unsupported platform | Run on Linux native | Reject at startup |
| Workspace in `/mnt/c/` | Create session | Warn, allow but slow |
| Symlink without support | Create symlink on Windows | Reject |
| Case collision | Create `Foo.ts` + `foo.ts` on Windows | Reject |
| Long path | Create path > 260 on Windows | Reject |
| Reserved name | Create `CON` file | Reject |
| CRLF mismatch | Hash CRLF vs LF | Different hash |
| Native signal | Send SIGTERM on Windows | Reject (no signal) |
| Env leak | Pass `AWS_SECRET` | Excluded |

---

## 18. Support Contract

### 18.1 Người dùng được hỗ trợ

Nếu user dùng:
- Windows 11 với WSL2 Ubuntu 22.04+ → **supported**.
- Windows 11 native → **supported** cho GUI, không cho shell execution.
- macOS → **unsupported**.
- Windows 10 → **unsupported**.
- Linux native → **unsupported**.

### 18.2 Bug reports

Bug report chỉ được xử lý nếu:
- Platform supported.
- Repro steps rõ ràng.
- Log/artifact cung cấp.

Bug report từ unsupported platform → đóng, không fix.

### 18.3 Feature requests

Feature request cho macOS/Linux native → acknowledge, defer v2.

Không có timeline cam kết.

---

## 19. North Star

> **Support ít platform nhưng support đúng. Không nói dối về cái chưa test.**

Mọi platform matrix, mọi adapter, mọi test vector tồn tại để trả lời:

- **Platform nào** supported?
- **Test trên platform nào**?
- **Khác biệt gì** giữa các platform?
- **Adapter nào** xử lý?
- **Rủi ro gì** khi defer?

Và câu hỏi cuối cùng:

> **Nếu user hỏi "có support macOS không?", câu trả lời phải là "không, v1 không support, v2 sẽ support" — chứ không phải "chắc là được".**

---

## 20. Appendix

### 20.1 Minimum requirements

**Windows 11:**
- Windows 11 22H2+
- 8 GB RAM (16 GB khuyến nghị)
- 10 GB disk cho WSL2 + tools
- WSL2 enabled
- Virtualization enabled trong BIOS

**Ubuntu WSL2:**
- Ubuntu 22.04 LTS+ (24.04 OK)
- Node.js 20 LTS
- npm 10+
- Git 2.40+
- 4 GB RAM allocated cho WSL2 (mặc định 50% host)

### 20.2 Recommended setup

```
Windows 11
 ├── VS Code + Remote WSL extension
 ├── WSL2 (Ubuntu 22.04)
 │    ├── Node.js 20 LTS
 │    ├── Git 2.40+
 │    ├── Ollama (local)
 │    └── Project ở /home/<user>/projects/
 └── Windows native
      └── (optional) Ollama cho GUI tools
```

### 20.3 `.wslconfig` khuyến nghị

```ini
[wsl2]
memory=8GB
processors=4
swap=2GB
localhostForwarding=true
```

### 20.4 Common issues

| Issue | Cause | Fix |
|---|---|---|
| Slow I/O | Project trong `/mnt/c/` | Move to `/home/` |
| Ollama timeout | Ollama trên Windows, agent trên WSL2 | Chạy Ollama trong WSL2 |
| File watch miss | inotify limit | `echo fs.inotify.max_user_watches=524288 \| sudo tee -a /etc/sysctl.conf` |
| OOM | WSL2 memory limit | Tăng trong `.wslconfig` |
| Symlink fail | Windows Dev Mode off | Enable Dev Mode |

---

## 21. Kết luận

v1 support:

- **Windows 11** (native, Tier 1).
- **Ubuntu 22.04+ trên WSL2** (Tier 1).

v1 không support:

- macOS (v2).
- Windows 10.
- Linux native.
- Distro khác.

Đây là **quyết định có chủ đích**, không phải thiếu sót:

- Trung thực về coverage.
- Tập trung test đúng platform.
- Tránh "hỗ trợ giả" platform chưa verify.
- Có lộ trình rõ ràng cho v2.

Câu hỏi không phải "làm sao support mọi platform", mà là:

> **"Tôi support platform nào, test platform nào, và nói thật về cái tôi chưa test."**

Trả lời trung thực → user biết chính xác họ đang dùng gì.

---

