// NodeWorkspaceManager — P3-WM1. Node.js implementation of WorkspaceManager.
//
// All paths are canonicalized + boundary-checked before any fs operation.
// WS-003: canonicalizePath() rejects `..` / absolute paths.
// WS-004: resolveRealpath() rejects symlink escape.
// WS-010: write/delete/move operations produce a ChangeRecord.
import { promises as fsp } from 'node:fs';
import { join } from 'node:path';
import type { WorkspaceManager, DirEntry, WriteOptions } from '@codeforge/agent-core';
import { WorkspaceError } from '@codeforge/agent-core';
import type { ChangeRecord } from '@codeforge/agent-core';
import { canonicalizePath, resolveRealpath, PathError } from '../path/index.js';

export interface NodeWorkspaceManagerDeps {
  readonly root:    string;
  readonly now:     () => string;
  readonly nextId:  () => string;
}

export class NodeWorkspaceManager implements WorkspaceManager {
  readonly root: string;

  constructor(private readonly deps: NodeWorkspaceManagerDeps) {
    // Normalise root: forward slashes, no trailing slash.
    this.root = deps.root.replace(/\\/g, '/').replace(/\/+$/, '');
  }

  // ── checkPath ───────────────────────────────────────────────────────────────

  async checkPath(relpath: string): Promise<string> {
    // Normalise: empty or '.' → treat as root (list root dir case).
    const normalized = (!relpath || relpath === '.') ? '' : relpath;
    try {
      // Step 1: lexical canonicalization (WS-003: rejects `..` / absolute paths).
      const canonical = normalized === ''
        ? this.root
        : canonicalizePath(normalized, { root: this.root });

      // Step 2: realpath only for existing paths (WS-004: symlink escape check).
      // If the path doesn't exist yet (e.g. for write_file), skip realpath — lexical
      // check alone is sufficient for boundary enforcement on not-yet-created paths.
      const absToCheck = join(this.root, normalized || '.').replace(/\\/g, '/');
      try {
        await resolveRealpath(absToCheck, { root: this.root });
      } catch (err) {
        if (err instanceof PathError) {
          if (err.code === 'SYMLINK_ESCAPE' || err.code === 'SYMLINK_LOOP') {
            throw new WorkspaceError('SYMLINK_ESCAPE', relpath, err.message);
          }
          if (err.code === 'PATH_ESCAPE') {
            throw new WorkspaceError('PATH_ESCAPE', relpath, err.message);
          }
          // NOT_FOUND from realpath → path doesn't exist yet, that's ok for writes.
        } else if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw err;
        }
      }
      return canonical;
    } catch (err) {
      if (err instanceof WorkspaceError) throw err;
      if (err instanceof PathError) {
        const code = err.code === 'SYMLINK_ESCAPE' || err.code === 'SYMLINK_LOOP'
          ? 'SYMLINK_ESCAPE' : 'PATH_ESCAPE';
        throw new WorkspaceError(code, relpath, err.message);
      }
      throw err;
    }
  }

  // ── Read operations ─────────────────────────────────────────────────────────

  async readFile(relpath: string): Promise<string> {
    const abs = await this.resolveAbs(relpath);
    try {
      return await fsp.readFile(abs, 'utf8');
    } catch (err) {
      throw this.fsError(err, relpath);
    }
  }

  async readFileBytes(relpath: string): Promise<Buffer> {
    const abs = await this.resolveAbs(relpath);
    try {
      return await fsp.readFile(abs);
    } catch (err) {
      throw this.fsError(err, relpath);
    }
  }

  async listDir(relpath: string): Promise<readonly DirEntry[]> {
    const abs = await this.resolveAbs(relpath);
    try {
      const entries = await fsp.readdir(abs, { withFileTypes: true });
      return entries.map((e) => ({
        name:    e.name,
        relpath: (!relpath || relpath === '.')
          ? e.name
          : `${relpath}/${e.name}`,
        isFile:  e.isFile(),
        isDir:   e.isDirectory(),
      }));
    } catch (err) {
      throw this.fsError(err, relpath);
    }
  }

  async fileExists(relpath: string): Promise<boolean> {
    try {
      const abs = await this.resolveAbs(relpath);
      const stat = await fsp.stat(abs);
      return stat.isFile();
    } catch {
      return false;
    }
  }

  async dirExists(relpath: string): Promise<boolean> {
    try {
      const abs = await this.resolveAbs(relpath);
      const stat = await fsp.stat(abs);
      return stat.isDirectory();
    } catch {
      return false;
    }
  }

  // ── Write operations ────────────────────────────────────────────────────────

  async writeFile(
    relpath:   string,
    content:   string | Buffer,
    sessionId: string,
    opts:      WriteOptions = {},
  ): Promise<ChangeRecord> {
    const abs = await this.resolveAbs(relpath);
    const exists = await this.fileExists(relpath);

    if (opts.exclusive === true && exists) {
      throw new WorkspaceError('ALREADY_EXISTS', relpath);
    }

    if (opts.mkdirp !== false) {
      const lastSlash = abs.lastIndexOf('/');
      const dir = lastSlash > 0 ? abs.slice(0, lastSlash) : null;
      if (dir && dir !== this.root) await fsp.mkdir(dir, { recursive: true });
    }

    const encoding = (typeof content === 'string' ? (opts.encoding ?? 'utf8') : undefined);
    try {
      if (typeof content === 'string') {
        await fsp.writeFile(abs, content, encoding ?? 'utf8');
      } else {
        await fsp.writeFile(abs, content);
      }
    } catch (err) {
      throw this.fsError(err, relpath);
    }

    return {
      changeId:    this.deps.nextId(),
      sessionId,
      kind:        exists ? 'modify' : 'create',
      relpath,
      ownedBy:     'agent',
      inScratchZone: false,
      at:          this.deps.now(),
    };
  }

  async deleteFile(relpath: string, sessionId: string): Promise<ChangeRecord> {
    const abs = await this.resolveAbs(relpath);
    try {
      await fsp.unlink(abs);
    } catch (err) {
      throw this.fsError(err, relpath);
    }
    return {
      changeId:    this.deps.nextId(),
      sessionId,
      kind:        'delete',
      relpath,
      ownedBy:     'agent',
      inScratchZone: false,
      at:          this.deps.now(),
    };
  }

  async moveFile(
    fromRelpath: string,
    toRelpath:   string,
    sessionId:   string,
  ): Promise<ChangeRecord> {
    const fromAbs = await this.resolveAbs(fromRelpath);
    const toAbs   = await this.resolveAbs(toRelpath);
    try {
      await fsp.rename(fromAbs, toAbs);
    } catch (err) {
      throw this.fsError(err, fromRelpath);
    }
    return {
      changeId:    this.deps.nextId(),
      sessionId,
      kind:        'rename',
      relpath:     toRelpath,
      ownedBy:     'agent',
      inScratchZone: false,
      at:          this.deps.now(),
    };
  }

  // ── internals ──────────────────────────────────────────────────────────────

  /** Resolve relpath to an absolute path after boundary check. */
  private async resolveAbs(relpath: string): Promise<string> {
    await this.checkPath(relpath);
    if (!relpath || relpath === '.') return this.root;
    return join(this.root, relpath).replace(/\\/g, '/');
  }

  private fsError(err: unknown, relpath: string): WorkspaceError {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return new WorkspaceError('NOT_FOUND', relpath);
    if (code === 'EACCES' || code === 'EPERM')
      return new WorkspaceError('PERMISSION_DENIED', relpath);
    if (code === 'EISDIR') return new WorkspaceError('IS_DIRECTORY', relpath);
    return new WorkspaceError('NOT_FOUND', relpath, String(err));
  }
}
