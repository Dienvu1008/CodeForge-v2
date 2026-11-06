/*
 * Copyright 2026 DienVu (Dienvu1008)
 * SPDX-License-Identifier: Apache-2.0
 */

// AblationWorkspaceManager (kernel-shadow-ablation, design C6). Measurement-only (SA-001).
//
// A WorkspaceManager decorator that is BOTH the EP-PATH observer and the filesystem containment
// layer. Every method runs, for every path argument, in this order:
//
//   (1) Kernel check      = `inner.checkPath(relpath)` — the Kernel's own decision (Requirement 4.3);
//                           only `WorkspaceError(PATH_ESCAPE | SYMLINK_ESCAPE)` counts as a block.
//   (2) Containment check = `isInsideSandbox` (sandbox.ts) on `resolve(root, relpath)`,
//                           `join(root, relpath)` and the Kernel's canonical path — an implementation
//                           independent from the Kernel's `canonicalizePath` (Requirement 7.3). The
//                           path is outside if ANY of the three forms is outside (conservative).
//
// Decision table (design C6):
//
//   kernel pass  + inside  → enforce: delegate        | shadow: delegate
//   kernel block + (any)   → enforce: ledger block,   | shadow: ledger block (wouldBlock),
//                            rethrow the WorkspaceError |         `escape-simulated`, simulated result
//   kernel pass  + outside → enforce: `kernelMiss`,   | shadow: `kernelMiss`, simulated result
//                            throw WorkspaceError('PATH_ESCAPE') (contained)
//
// Simulated results never touch the filesystem (Requirement 7.2): writes/deletes/moves return a
// synthetic ChangeRecord (`inScratchZone: false`) after recording the target and, for writes, the
// content SHA-256; reads return {@link SHADOW_SIMULATED_READ}; `listDir` → `[]`;
// `fileExists` / `dirExists` → `false`. `checkPath` itself (no effect to simulate) returns a
// placeholder path INSIDE the sandbox ({@link SHADOW_SIMULATED_PATH_SEGMENT}) that does not exist.
//
// Ledger policy (EP-PATH):
// - every Kernel block is recorded (one entry per blocked path argument, reason = WorkspaceError code);
// - Kernel allows are recorded ONCE per ledger step (reason `inside_workspace`), so the ledger
//   shows that the proposal reached EP-PATH (Requirement 4.1) without one entry per file a
//   grep/glob walk touches. The rule is deterministic, so both arms produce the same allow rows.
// - a `kernelMiss` is a containment event, not a Kernel decision: the Kernel said allow, so the
//   ledger keeps `allow`; the containment event is what the report surfaces (Requirement 7.4).
// - `tool` is `workspace.<method>` (this layer cannot see the tool name); `argsPreview` holds only
//   the path argument(s) via `previewArgs`, never file content.
//
// Enforce-mode transparency (Requirement 4.2): `fileExists` / `dirExists` of NodeWorkspaceManager
// swallow every error and return `false`; the decorator mirrors that (records the block, returns
// `false`) instead of throwing, so an enforce arm behaves exactly like the plain Kernel wiring.
//
// Containment event `target` is the path argument AS GIVEN (not the resolved absolute path), so
// the two arms — which run in different mkdtemp sandboxes — record identical events.
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import {
  DEFAULT_PATH_ACCESS_POLICY,
  WorkspaceError,
  evaluatePathAccess,
  type ChangeRecord,
  type DirEntry,
  type PathAccess,
  type PathAccessPolicy,
  type WorkspaceManager,
  type WriteOptions,
} from '@codeforge/agent-core';
import { previewArgs, type DecisionLedger } from './decision-ledger.js';
import { assertSandboxRoot, isInsideSandbox, SandboxError, type Sandbox } from './sandbox.js';

/** Content returned by simulated reads (Requirement 7.2: labelled `[shadow-simulated]`). */
export const SHADOW_SIMULATED_READ = '[shadow-simulated] content outside the workspace was not read';

/** Non-existent sandbox-relative segment returned by a simulated `checkPath`. */
export const SHADOW_SIMULATED_PATH_SEGMENT = '.cf-shadow-simulated';

export type AblationMode = 'enforce' | 'shadow';

export interface AblationWorkspaceOptions {
  /** Id source for simulated ChangeRecords (the arm counter). Default: `shadow-sim-<n>`. */
  readonly nextId?: () => string;
  /** Clock for simulated ChangeRecords (the arm clock). Default: the Unix epoch (deterministic). */
  readonly now?: () => string;
  /**
   * kernel-gap-closure: the ORACLE Path_Access_Policy (SE-012, WS-011) this observer evaluates after
   * the boundary check. Default `DEFAULT_PATH_ACCESS_POLICY` (the Kernel's real policy). A rejection
   * is an `EP-PATH` block with reason `SENSITIVE_PATH` | `PROTECTED_PATH` (no new enforcement point id).
   * Enforce: rethrow the same `WorkspaceError` the NodeWorkspaceManager throws. Shadow: record
   * `wouldBlock` and let the operation proceed against the sandbox (the inner manager is open).
   */
  readonly pathAccess?: PathAccessPolicy;
}

type EscapeCode = 'PATH_ESCAPE' | 'SYMLINK_ESCAPE';

type PathVerdict =
  | { readonly kind: 'delegate'; readonly canonical: string }
  | { readonly kind: 'simulate' };

function isEscapeError(err: unknown): err is WorkspaceError & { readonly code: EscapeCode } {
  return err instanceof WorkspaceError && (err.code === 'PATH_ESCAPE' || err.code === 'SYMLINK_ESCAPE');
}

function sha256(content: string | Buffer, encoding: BufferEncoding): string {
  const bytes = typeof content === 'string' ? Buffer.from(content, encoding) : content;
  return createHash('sha256').update(bytes).digest('hex');
}

export class AblationWorkspaceManager implements WorkspaceManager {
  readonly root: string;
  private readonly nextId: () => string;
  private readonly now: () => string;
  private readonly pathAccess: PathAccessPolicy;
  private simCounter = 0;
  /** Ledger step of the last recorded EP-PATH allow (allows are recorded once per step). */
  private lastAllowStep: number | undefined;

  constructor(
    private readonly inner: WorkspaceManager,
    private readonly sandbox: Sandbox,
    private readonly mode: AblationMode,
    private readonly ledger: DecisionLedger,
    opts: AblationWorkspaceOptions = {},
  ) {
    // Requirement 6.5: refuse a bad root before ANY filesystem access through this manager.
    assertSandboxRoot(sandbox.root);
    if (!isInsideSandbox(sandbox, inner.root)) {
      throw new SandboxError(
        'OUTSIDE_TMPDIR',
        inner.root,
        `inner workspace root is not inside the sandbox (${sandbox.root}): ${inner.root}`,
      );
    }
    if (mode !== 'enforce' && mode !== 'shadow') {
      throw new Error(`AblationWorkspaceManager: unknown mode ${String(mode)}`);
    }
    this.root = inner.root;
    this.nextId = opts.nextId ?? (() => `shadow-sim-${String(++this.simCounter).padStart(6, '0')}`);
    this.now = opts.now ?? (() => new Date(0).toISOString());
    this.pathAccess = opts.pathAccess ?? DEFAULT_PATH_ACCESS_POLICY;
  }

  // ── Path access (Path_Access_Policy observer) ───────────────────────────────

  /**
   * Same question as `NodeWorkspaceManager.checkAccess`, observed. Enforce: records the EP-PATH block
   * and throws; shadow: records `wouldBlock` and returns (the operation proceeds in the sandbox).
   */
  async checkAccess(access: PathAccess, relpath: string): Promise<void> {
    this.observeAccess('checkAccess', access, relpath, { path: relpath });
    await this.inner.checkAccess?.(access, relpath);
  }

  // ── Path validation ─────────────────────────────────────────────────────────

  async checkPath(relpath: string): Promise<string> {
    const v = await this.decide('checkPath', relpath, { path: relpath });
    if (v.kind === 'delegate') return v.canonical;
    return `${this.root}/${SHADOW_SIMULATED_PATH_SEGMENT}`;
  }

  // ── Read operations ─────────────────────────────────────────────────────────

  async readFile(relpath: string): Promise<string> {
    const v = await this.decide('readFile', relpath, { path: relpath }, undefined, 'read');
    if (v.kind === 'simulate') return SHADOW_SIMULATED_READ;
    return this.inner.readFile(relpath);
  }

  async readFileBytes(relpath: string): Promise<Buffer> {
    const v = await this.decide('readFileBytes', relpath, { path: relpath }, undefined, 'read');
    if (v.kind === 'simulate') return Buffer.from(SHADOW_SIMULATED_READ, 'utf8');
    return this.inner.readFileBytes(relpath);
  }

  async listDir(relpath: string): Promise<readonly DirEntry[]> {
    const v = await this.decide('listDir', relpath, { path: relpath });
    if (v.kind === 'simulate') return [];
    return this.inner.listDir(relpath);
  }

  async fileExists(relpath: string): Promise<boolean> {
    // Mirrors NodeWorkspaceManager: every error (including a Kernel block) → false.
    try {
      const v = await this.decide('fileExists', relpath, { path: relpath });
      if (v.kind === 'simulate') return false;
      return await this.inner.fileExists(relpath);
    } catch {
      return false;
    }
  }

  async dirExists(relpath: string): Promise<boolean> {
    try {
      const v = await this.decide('dirExists', relpath, { path: relpath });
      if (v.kind === 'simulate') return false;
      return await this.inner.dirExists(relpath);
    } catch {
      return false;
    }
  }

  // ── Write operations ────────────────────────────────────────────────────────

  async writeFile(
    relpath: string,
    content: string | Buffer,
    sessionId: string,
    opts?: WriteOptions,
  ): Promise<ChangeRecord> {
    const digest = sha256(content, opts?.encoding ?? 'utf8');
    const v = await this.decide('writeFile', relpath, { path: relpath }, digest, 'write');
    if (v.kind === 'simulate') return this.simulatedChange(sessionId, 'create', relpath);
    return this.inner.writeFile(relpath, content, sessionId, opts);
  }

  async deleteFile(relpath: string, sessionId: string): Promise<ChangeRecord> {
    const v = await this.decide('deleteFile', relpath, { path: relpath }, undefined, 'write');
    if (v.kind === 'simulate') return this.simulatedChange(sessionId, 'delete', relpath);
    return this.inner.deleteFile(relpath, sessionId);
  }

  async moveFile(fromRelpath: string, toRelpath: string, sessionId: string): Promise<ChangeRecord> {
    // Same order as NodeWorkspaceManager (source first): in enforce mode the first failing path
    // throws before the second is checked, exactly like the plain Kernel.
    const preview = { from: fromRelpath, to: toRelpath };
    const from = await this.decide('moveFile', fromRelpath, preview, undefined, 'write');
    const to = await this.decide('moveFile', toRelpath, preview, undefined, 'write');
    // Shadow: if either side would escape, the whole move is simulated (no partial effect).
    if (from.kind === 'simulate' || to.kind === 'simulate') {
      return this.simulatedChange(sessionId, 'rename', toRelpath);
    }
    return this.inner.moveFile(fromRelpath, toRelpath, sessionId);
  }

  // ── internals ──────────────────────────────────────────────────────────────

  /**
   * Kernel check → containment check → decision per the C6 table for ONE path argument.
   * Enforce mode throws on a Kernel block (the Kernel's own WorkspaceError) or a kernelMiss
   * (a contained `WorkspaceError('PATH_ESCAPE')`); shadow mode returns `simulate` instead.
   * Errors from `checkPath` that are not an escape decision propagate unchanged in both modes.
   */
  private async decide(
    op: string,
    relpath: string,
    args: Readonly<Record<string, string>>,
    contentSha256?: string,
    access?: PathAccess,
  ): Promise<PathVerdict> {
    const tool = `workspace.${op}`;
    let canonical: string | undefined;
    let kernelBlock: (WorkspaceError & { readonly code: EscapeCode }) | undefined;
    try {
      canonical = await this.inner.checkPath(relpath);
    } catch (err) {
      if (!isEscapeError(err)) throw err;
      kernelBlock = err;
    }

    if (kernelBlock !== undefined) {
      const shadow = this.mode === 'shadow';
      this.ledger.record({
        tool,
        argsPreview: previewArgs(args),
        point: 'EP-PATH',
        decision: 'block',
        reason: kernelBlock.code,
        effective: shadow ? 'allow' : 'block',
        wouldBlock: shadow,
      });
      if (!shadow) throw kernelBlock;
      this.ledger.contained({
        kind: 'escape-simulated',
        op,
        target: relpath,
        ...(contentSha256 !== undefined ? { sha256: contentSha256 } : {}),
      });
      return { kind: 'simulate' };
    }

    // Kernel allowed (checkPath returned a string by contract).
    const kernelPath = canonical ?? '';
    this.recordAllowOncePerStep(tool, args);
    if (this.isContained(relpath, kernelPath)) {
      // Path_Access_Policy oracle (after the boundary check). Shadow: records wouldBlock and proceeds.
      if (access !== undefined) this.observeAccess(op, access, relpath, args);
      return { kind: 'delegate', canonical: kernelPath };
    }

    // The Kernel accepted a path the independent check considers outside: highest severity.
    this.ledger.contained({
      kind: 'kernelMiss',
      op,
      target: relpath,
      ...(contentSha256 !== undefined ? { sha256: contentSha256 } : {}),
    });
    if (this.mode === 'enforce') {
      throw new WorkspaceError(
        'PATH_ESCAPE',
        relpath,
        `PATH_ESCAPE: ${relpath} (contained by the ablation harness: kernelMiss)`,
      );
    }
    return { kind: 'simulate' };
  }

  /**
   * Evaluate the oracle Path_Access_Policy; on a deny record `EP-PATH` `block` (reason = code).
   * Enforce throws the same WorkspaceError as NodeWorkspaceManager; shadow only flags `wouldBlock`.
   * No containment event: the operation stays inside the sandbox.
   */
  private observeAccess(
    op: string,
    access: PathAccess,
    relpath: string,
    args: Readonly<Record<string, string>>,
  ): void {
    const verdict = evaluatePathAccess(this.pathAccess, access, relpath);
    if (verdict.allowed) return;
    const shadow = this.mode === 'shadow';
    this.ledger.record({
      tool: `workspace.${op}`,
      argsPreview: previewArgs(args),
      point: 'EP-PATH',
      decision: 'block',
      reason: verdict.code,
      effective: shadow ? 'allow' : 'block',
      wouldBlock: shadow,
    });
    if (shadow) return;
    throw new WorkspaceError(
      verdict.code,
      relpath,
      verdict.code === 'SENSITIVE_PATH'
        ? `SENSITIVE_PATH: ${relpath} is a secret file and cannot be read or changed by the agent (use .env.example for placeholders)`
        : `PROTECTED_PATH: ${relpath} is version-control metadata and cannot be changed by the agent`,
    );
  }

  private isContained(relpath: string, kernelPath: string): boolean {
    const candidates = [resolve(this.root, relpath), join(this.root, relpath)];
    if (kernelPath !== '') candidates.push(kernelPath);
    return candidates.every((p) => isInsideSandbox(this.sandbox, p));
  }

  private recordAllowOncePerStep(tool: string, args: Readonly<Record<string, string>>): void {
    const step = this.ledger.currentStep();
    if (this.lastAllowStep === step) return;
    this.lastAllowStep = step;
    this.ledger.record({
      tool,
      argsPreview: previewArgs(args),
      point: 'EP-PATH',
      decision: 'allow',
      reason: 'inside_workspace',
      effective: 'allow',
      wouldBlock: false,
    });
  }

  private simulatedChange(sessionId: string, kind: ChangeRecord['kind'], relpath: string): ChangeRecord {
    return {
      changeId: this.nextId(),
      sessionId,
      kind,
      relpath,
      ownedBy: 'agent',
      inScratchZone: false,
      at: this.now(),
    };
  }
}
