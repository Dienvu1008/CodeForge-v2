// Vector builder (A3) — materializes a declarative vector into a real temp directory.
import { mkdtemp, mkdir, writeFile, symlink, chmod, rm, realpath as fsRealpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import type { WorkspaceVector } from './types.js';

export interface BuiltVector {
  /** canonical workspace root, '/'-separated */
  readonly root: string;
  /** true if any symlink entry was skipped because the platform lacks support */
  readonly symlinkSkipped: boolean;
  cleanup(): Promise<void>;
}

/** Materialize a vector under a fresh temp dir. Returns the canonical root and a cleanup fn. */
export async function buildVector(vector: WorkspaceVector): Promise<BuiltVector> {
  const parent = await mkdtemp(join(tmpdir(), `cf2-vec-${vector.id}-`));
  const rootNative = join(parent, 'root');
  const outsideNative = join(parent, 'outside');
  await mkdir(rootNative, { recursive: true });
  const root = (await fsRealpath(rootNative)).replace(/\\/g, '/');
  let symlinkSkipped = false;

  for (const entry of vector.entries) {
    const abs = join(rootNative, entry.path);
    if (entry.kind === 'file') {
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, Buffer.from(entry.base64, 'base64'));
      if (entry.mode !== undefined && process.platform !== 'win32') {
        await chmod(abs, entry.mode);
      }
    } else if (entry.kind === 'dir') {
      await mkdir(abs, { recursive: true });
    } else {
      // symlink
      await mkdir(dirname(abs), { recursive: true });
      let target: string;
      if (entry.external) {
        await mkdir(outsideNative, { recursive: true });
        await writeFile(join(outsideNative, 'secret.txt'), 'secret');
        // External target is absolute (points outside root); this symlink is skipped
        // from the hash anyway (WORKSPACE_SPEC §6.2), so its target does not affect hashes.
        target = outsideNative;
      } else {
        // Internal target is RELATIVE so the recorded symlink target — and therefore the
        // hash — is reproducible across machines/temp dirs (WS-001). The vector declares
        // the target relative to the workspace root.
        target = entry.target;
      }
      try {
        await symlink(target, abs, entry.type ?? 'file');
      } catch {
        symlinkSkipped = true; // Windows without Dev Mode
      }
    }
  }

  return {
    root,
    symlinkSkipped,
    cleanup: () => rm(parent, { recursive: true, force: true }),
  };
}
