/*
 * Copyright 2026 DienVu (Dienvu1008)
 * SPDX-License-Identifier: Apache-2.0
 */

// WorkspaceSnapshotRollback — P12.14. Node implementation of the agent-core `WorkspaceRollback`
// port, backed by a per-session content snapshot of the workspace tree.
//
// Why a content snapshot (not the Checkpoint): a Checkpoint stores only a revision HASH (a claim
// about the filesystem — CP-010), never file content, so it cannot by itself restore bytes. This
// class holds the actual content of the last CLEAN point so a ROLLBACK can revert the agent's
// broken edit to a known-good baseline.
//
// Lifecycle:
//   captureClean(sessionId)        — snapshot the current tree as the clean baseline for a session
//                                    (call right after a clean verification, or once before the
//                                    agent starts — the pre-edit seeded state is itself clean).
//   rollbackToLastClean(sessionId) — restore the tree to that snapshot: overwrite files whose
//                                    content drifted, re-create files the agent deleted, and delete
//                                    files the agent created after the snapshot. Returns false when
//                                    no clean snapshot exists for the session (nothing to revert to).
//
// Determinism: snapshot is a sorted relpath→content map; restore applies a deterministic diff.
// Never throws out of rollbackToLastClean (the port contract) — a failure returns false.
import { promises as fsp, type Dirent } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { WorkspaceRollback } from '@codeforge/agent-core';

/** Directory names never walked/snapshotted (build output, VCS, deps). */
const SKIP_DIRS: ReadonlySet<string> = new Set([
  'node_modules', '.git', 'dist', 'build', 'coverage', '.cache', '.cf2',
]);

export interface WorkspaceSnapshotRollbackDeps {
  /** Absolute workspace root. */
  readonly root: string;
  /** Optional: max file size (bytes) to snapshot; larger files are skipped. Default 1 MiB. */
  readonly maxFileBytes?: number;
}

export class WorkspaceSnapshotRollback implements WorkspaceRollback {
  private readonly root: string;
  private readonly maxFileBytes: number;
  /** sessionId → (relpath '/'-separated → file content bytes) of the last clean point. */
  private readonly snapshots = new Map<string, Map<string, Buffer>>();

  constructor(deps: WorkspaceSnapshotRollbackDeps) {
    this.root = deps.root.replace(/\\/g, '/').replace(/\/+$/, '');
    this.maxFileBytes = deps.maxFileBytes ?? 1024 * 1024;
  }

  /** Snapshot the current tree as the clean baseline for `sessionId` (replaces any prior). */
  async captureClean(sessionId: string): Promise<void> {
    const files = new Map<string, Buffer>();
    await this.walk(this.root, files);
    this.snapshots.set(sessionId, files);
  }

  /** True once a clean snapshot has been captured for the session. */
  hasSnapshot(sessionId: string): boolean {
    return this.snapshots.has(sessionId);
  }

  async rollbackToLastClean(sessionId: string): Promise<boolean> {
    const clean = this.snapshots.get(sessionId);
    if (clean === undefined) return false;
    try {
      // 1. Restore / recreate every file that existed at the clean point.
      for (const [rel, content] of clean) {
        const abs = this.abs(rel);
        const lastSlash = abs.lastIndexOf('/');
        if (lastSlash > 0) await fsp.mkdir(abs.slice(0, lastSlash), { recursive: true });
        await fsp.writeFile(abs, content);
      }
      // 2. Delete files that exist NOW but were absent at the clean point (agent-created).
      const current = new Map<string, Buffer>();
      await this.walk(this.root, current);
      for (const rel of current.keys()) {
        if (!clean.has(rel)) {
          try { await fsp.unlink(this.abs(rel)); } catch { /* already gone */ }
        }
      }
      return true;
    } catch {
      return false;
    }
  }

  // ── internals ───────────────────────────────────────────────────────────────

  private abs(rel: string): string {
    return join(this.root, rel).replace(/\\/g, '/');
  }

  /** Recursively collect relpath→content for every regular file under `dir` (skipping SKIP_DIRS). */
  private async walk(dir: string, out: Map<string, Buffer>): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return; // unreadable dir — skip
    }
    // Deterministic order.
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        await this.walk(join(dir, e.name), out);
      } else if (e.isFile()) {
        const abs = join(dir, e.name);
        try {
          const stat = await fsp.stat(abs);
          if (stat.size > this.maxFileBytes) continue;
          const content = await fsp.readFile(abs);
          const rel = relative(this.root, abs).split(sep).join('/');
          out.set(rel, content);
        } catch { /* unreadable file — skip */ }
      }
    }
  }
}
