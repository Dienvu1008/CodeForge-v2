// Path errors — WORKSPACE_SPEC §14.2, SECURITY_MODEL §6, PLATFORM_SUPPORT §5.3.
// Enforce WS-003 (path traversal), WS-004 (symlink escape / loop).

export type PathErrorCode =
  | 'PATH_ESCAPE' // resolves outside workspace root (`..`, absolute, sibling)
  | 'SYMLINK_ESCAPE' // symlink target resolves outside root
  | 'SYMLINK_LOOP' // symlink chain exceeds MAX_SYMLINK_DEPTH
  | 'NULL_BYTE' // path contains a NUL byte
  | 'UNC_PATH' // Windows UNC path `\\server\share` (out of policy)
  | 'LONG_PATH_PREFIX' // Windows long-path prefix `\\?\` (out of policy)
  | 'RESERVED_NAME' // Windows reserved device name (CON, PRN, ...)
  | 'CASE_COLLISION' // two paths differ only by case on a case-insensitive FS
  | 'NOT_FOUND'; // realpath target does not exist

export class PathError extends Error {
  public readonly code: PathErrorCode;
  public readonly path: string;

  constructor(code: PathErrorCode, path: string, message?: string) {
    super(message ?? `${code}: ${path}`);
    this.name = 'PathError';
    this.code = code;
    this.path = path;
  }
}
