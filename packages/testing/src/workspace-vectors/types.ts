// Workspace vector definitions (A3) — WORKSPACE_SPEC §7.
//
// A vector is a DECLARATIVE description of a workspace tree. The builder materializes it
// into a real temp directory at test time. Content is stored as base64 so fixtures are
// byte-exact and never touched by Git autocrlf (WORKSPACE_SPEC §7.1).
//
// Declarative-in-code (not committed binary files) also lets us express symlinks, empty
// dirs, permissions, and special filenames that are awkward/impossible to commit on Windows.

export type VectorPlatform = 'win32' | 'linux';

export interface VectorFileEntry {
  readonly kind: 'file';
  /** POSIX-style relative path within the workspace */
  readonly path: string;
  /** file content, base64-encoded (byte-exact) */
  readonly base64: string;
  /** optional POSIX mode (e.g. 0o755). Ignored on platforms without mode support. */
  readonly mode?: number;
}

export interface VectorDirEntry {
  readonly kind: 'dir';
  readonly path: string;
}

export interface VectorSymlinkEntry {
  readonly kind: 'symlink';
  readonly path: string;
  /** link target (POSIX-style, relative or absolute) */
  readonly target: string;
  /** if true, target points outside the workspace root (builder creates it in a sibling) */
  readonly external?: boolean;
  readonly type?: 'file' | 'dir';
}

export type VectorEntry = VectorFileEntry | VectorDirEntry | VectorSymlinkEntry;

export interface VectorExpected {
  readonly vectorId: string;
  readonly canonicalFormVersion: string;
  readonly hashAlgorithm: 'blake3' | 'sha256';
  readonly expectedHash: string;
  readonly expectedFileCount: number;
  readonly expectedBytes: number;
  readonly notes: string;
}

export interface WorkspaceVector {
  readonly id: string; // e.g. "v002-single-file"
  readonly notes: string;
  /** platforms this vector runs on. Omit = both. */
  readonly platforms?: readonly VectorPlatform[];
  /** requires symlink support (skip if unavailable) */
  readonly requiresSymlink?: boolean;
  /** scratch prefixes passed to the hasher */
  readonly scratchPrefixes?: readonly string[];
  readonly entries: readonly VectorEntry[];
  /** expected results per algorithm; filled by the expected-hash generator */
  readonly expected?: {
    readonly blake3?: Omit<VectorExpected, 'vectorId' | 'canonicalFormVersion' | 'hashAlgorithm' | 'notes'>;
  };
}
