// WorkspaceManager contract — WORKSPACE_SPEC §3-§6, SECURITY_MODEL §6, P3-WM1.
//
// The single boundary through which ALL filesystem mutations and reads are routed.
// Enforces:
//   WS-003: path traversal rejected (PATH_ESCAPE).
//   WS-004: symlink escape rejected (SYMLINK_ESCAPE).
//   WS-005: agent cannot mutate outside declared workspace root.
//   WS-006: user-existing changes are preserved (ChangeRecord tracks ownership).
//   WS-010: every mutation produces a ChangeRecord for audit.
//
// This is a CONTRACT (interface). Concrete implementation in infrastructure
// uses the existing path canonicalizer (C3) and Node fs APIs (DC-002).
import type { ChangeRecord } from '../domain/change-record.js';

// ── WorkspaceError ────────────────────────────────────────────────────────────

export type WorkspaceErrorCode =
  | 'PATH_ESCAPE'      // WS-003: path would escape workspace root
  | 'SYMLINK_ESCAPE'   // WS-004: symlink target outside root
  | 'NOT_FOUND'        // file/dir does not exist
  | 'ALREADY_EXISTS'   // write with exclusive mode failed
  | 'IS_DIRECTORY'     // expected file, got directory
  | 'PERMISSION_DENIED';

export class WorkspaceError extends Error {
  public readonly code: WorkspaceErrorCode;
  public readonly path: string;
  constructor(code: WorkspaceErrorCode, path: string, message?: string) {
    super(message ?? `${code}: ${path}`);
    this.name = 'WorkspaceError';
    this.code = code;
    this.path = path;
  }
}

// ── DirEntry ──────────────────────────────────────────────────────────────────

export interface DirEntry {
  readonly name:     string;
  readonly relpath:  string; // relative to workspace root, '/' separated
  readonly isFile:   boolean;
  readonly isDir:    boolean;
  readonly sizeBytes?: number;
}

// ── WriteOptions ──────────────────────────────────────────────────────────────

export interface WriteOptions {
  /** Create parent directories if they don't exist. Default: true. */
  readonly mkdirp?: boolean;
  /** Fail if file already exists. Default: false. */
  readonly exclusive?: boolean;
  /** Text encoding. Default: 'utf8'. */
  readonly encoding?: BufferEncoding;
}

// ── WorkspaceManager ──────────────────────────────────────────────────────────

/**
 * WorkspaceManager — single filesystem boundary for the agent.
 *
 * All paths supplied to these methods are workspace-relative (no leading slash,
 * '/' separated). The implementation resolves them against `root` and checks
 * the boundary before any filesystem operation.
 *
 * Returns ChangeRecords for mutations so callers can record them in the event log.
 */
export interface WorkspaceManager {
  /** Canonical absolute workspace root (read-only, set at construction). */
  readonly root: string;

  // ── Read operations (READ_ONLY risk class) ──────────────────────────────────

  /** Read a file as a UTF-8 string. Throws NOT_FOUND / PATH_ESCAPE. */
  readFile(relpath: string): Promise<string>;

  /** Read a file as a Buffer. */
  readFileBytes(relpath: string): Promise<Buffer>;

  /** List the contents of a directory (non-recursive). */
  listDir(relpath: string): Promise<readonly DirEntry[]>;

  /** True if the relpath exists and is a file. */
  fileExists(relpath: string): Promise<boolean>;

  /** True if the relpath exists and is a directory. */
  dirExists(relpath: string): Promise<boolean>;

  // ── Write operations (MODIFY_WORKSPACE / DESTRUCTIVE risk class) ───────────

  /**
   * Write (create or overwrite) a file.
   * WS-010: returns a ChangeRecord the caller should persist.
   */
  writeFile(
    relpath: string,
    content: string | Buffer,
    sessionId: string,
    opts?: WriteOptions,
  ): Promise<ChangeRecord>;

  /**
   * Delete a file (DESTRUCTIVE — requires approval at ToolGateway level).
   * WS-010: returns a ChangeRecord.
   */
  deleteFile(relpath: string, sessionId: string): Promise<ChangeRecord>;

  /**
   * Move/rename a file or directory.
   * WS-010: returns a ChangeRecord with kind='rename'.
   */
  moveFile(
    fromRelpath: string,
    toRelpath:   string,
    sessionId:   string,
  ): Promise<ChangeRecord>;

  // ── Path validation (pure) ──────────────────────────────────────────────────

  /**
   * Check whether a workspace-relative path is safe to access.
   * Returns the canonical absolute path on success.
   * Throws WorkspaceError(PATH_ESCAPE | SYMLINK_ESCAPE) on violation.
   */
  checkPath(relpath: string): Promise<string>;
}
