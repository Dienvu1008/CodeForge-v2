/*
 * Copyright 2026 DienVu (Dienvu1008)
 * SPDX-License-Identifier: Apache-2.0
 */

// Kernel gap closure (G5, TG-013): the set of test-like files that existed when the goal started.
// Directory listing only: no file content is ever opened or read.

import { promises as fsp } from 'node:fs';
import { join } from 'node:path';
import { isTestLikePath, normalizeSegments, type TestBaseline } from '@codeforge/agent-core';

/** Directories never walked (same list as WorkspaceSnapshotRollback). */
const DEFAULT_SKIP_DIRS: ReadonlySet<string> = new Set([
  'node_modules', '.git', 'dist', 'build', 'coverage', '.cache', '.codeforge', '.cf2',
]);

export interface WorkspaceTestBaselineDeps {
  /** Absolute workspace root. */
  readonly root: string;
  /** Directory names (lowercase) to skip. Defaults to the rollback skip list. */
  readonly skipDirs?: ReadonlySet<string>;
}

export class WorkspaceTestBaseline implements TestBaseline {
  private readonly root: string;
  private readonly skipDirs: ReadonlySet<string>;
  private paths: ReadonlySet<string> = new Set();

  constructor(deps: WorkspaceTestBaselineDeps) {
    this.root = deps.root;
    this.skipDirs = deps.skipDirs ?? DEFAULT_SKIP_DIRS;
  }

  /** Replace the set with the test-like paths currently present. Symlinked directories are not followed. */
  async capture(): Promise<void> {
    const found = new Set<string>();
    await this.walk('', found);
    this.paths = found;
  }

  isBaselineTest(relpath: string): boolean {
    return this.paths.has(normalizeSegments(relpath).join('/'));
  }

  get size(): number {
    return this.paths.size;
  }

  private async walk(rel: string, out: Set<string>): Promise<void> {
    let entries;
    try {
      entries = await fsp.readdir(rel === '' ? this.root : join(this.root, rel), { withFileTypes: true });
    } catch {
      return; // unreadable directory: skipped
    }
    for (const e of entries) {
      const childRel = rel === '' ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) {
        if (this.skipDirs.has(e.name.toLowerCase())) continue;
        await this.walk(childRel, out);
      } else if (isTestLikePath(childRel)) {
        out.add(normalizeSegments(childRel).join('/'));
      }
    }
  }
}
