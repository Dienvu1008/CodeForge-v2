// Lexical path canonicalization — WORKSPACE_SPEC §3, PLATFORM_SUPPORT §5.
//
// "Lexical" = string-level only, no filesystem access. Deterministic.
// Realpath/symlink resolution (which touches the FS) lives in `realpath.ts`.
//
// canonical(path) = normalize(absolutize(path, root)) with boundary + platform checks.
// Internal canonical form ALWAYS uses '/' separators (WORKSPACE_SPEC §3.2).
//
// Enforces: WS-003 (no `..`/absolute/sibling escape), null-byte reject,
// Windows UNC / long-path / reserved-name reject (PLATFORM_SUPPORT §5.3).

import { PathError } from './errors.js';

export interface CanonicalizeOptions {
  /** Canonical workspace root, '/'-separated, no trailing slash (except filesystem root). */
  readonly root: string;
  /** OS family deciding platform rules. Defaults to current process platform. */
  readonly platform?: 'win32' | 'linux';
}

// Windows reserved device names (case-insensitive), optionally with an extension.
const WIN_RESERVED = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);

/** Convert any separators to '/'. */
export function toCanonicalSeparators(p: string): string {
  return p.replace(/\\/g, '/');
}

/** True if `p` is absolute in either POSIX or Windows sense. */
function isAbsolute(p: string, platform: 'win32' | 'linux'): boolean {
  if (p.startsWith('/')) return true;
  if (platform === 'win32') {
    // Drive-absolute: C:/ or C:\  (after separator normalization: C:/)
    if (/^[A-Za-z]:\//.test(p)) return true;
    // Drive-relative without slash is treated as absolute-ish drive ref: C:foo
    if (/^[A-Za-z]:/.test(p)) return true;
  }
  return false;
}

/**
 * Collapse '.' and '..' segments lexically. Returns segments.
 * Throws PATH_ESCAPE if '..' would rise above the root of the given path.
 */
function normalizeSegments(segments: string[], pathForError: string): string[] {
  const out: string[] = [];
  for (const seg of segments) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length === 0) {
        throw new PathError('PATH_ESCAPE', pathForError, `escapes above root: ${pathForError}`);
      }
      out.pop();
      continue;
    }
    out.push(seg);
  }
  return out;
}

function assertNoNullByte(p: string): void {
  if (p.includes('\0')) {
    throw new PathError('NULL_BYTE', p, 'path contains NUL byte');
  }
}

function assertWindowsPolicy(rawInput: string, platform: 'win32' | 'linux'): void {
  if (platform !== 'win32') return;
  // UNC: \\server\share  (raw, before normalization) or //server/share
  const normalizedSep = toCanonicalSeparators(rawInput);
  if (/^\/\/[^/]/.test(normalizedSep)) {
    // But allow long-path prefix detection below to give a more specific error.
    if (!normalizedSep.startsWith('//?/')) {
      throw new PathError('UNC_PATH', rawInput, 'UNC path not allowed');
    }
  }
  // Long-path prefix: \\?\ (normalized: //?/)
  if (normalizedSep.startsWith('//?/')) {
    throw new PathError('LONG_PATH_PREFIX', rawInput, 'long-path prefix not allowed');
  }
}

function assertReservedNames(segments: string[], platform: 'win32' | 'linux', pathForError: string): void {
  if (platform !== 'win32') return;
  for (const seg of segments) {
    const base = seg.split('.')[0] ?? seg;
    if (WIN_RESERVED.has(base.toUpperCase())) {
      throw new PathError('RESERVED_NAME', pathForError, `reserved device name: ${seg}`);
    }
  }
}

/**
 * Canonicalize a path lexically against a workspace root.
 *
 * Returns a canonical absolute path, '/'-separated. The result is guaranteed to be
 * inside `root` (or equal to it). Does NOT touch the filesystem or resolve symlinks.
 */
export function canonicalizePath(input: string, opts: CanonicalizeOptions): string {
  const platform = opts.platform ?? (process.platform === 'win32' ? 'win32' : 'linux');

  assertNoNullByte(input);
  assertWindowsPolicy(input, platform);

  const root = toCanonicalSeparators(opts.root);
  const normalizedInput = toCanonicalSeparators(input);

  // Build an absolute path string.
  let absolute: string;
  if (isAbsolute(normalizedInput, platform)) {
    absolute = normalizedInput;
  } else {
    absolute = `${root}/${normalizedInput}`;
  }

  // Split off a leading anchor so `..` normalization cannot rise above it.
  // POSIX anchor = '/'. Windows drive anchor = 'C:/'.
  let anchor = '';
  let rest = absolute;
  const driveMatch = /^([A-Za-z]:)\/?/.exec(absolute);
  if (platform === 'win32' && driveMatch) {
    anchor = `${driveMatch[1]}/`;
    rest = absolute.slice(driveMatch[0].length);
  } else if (absolute.startsWith('/')) {
    anchor = '/';
    rest = absolute.slice(1);
  }

  const segments = normalizeSegments(rest.split('/'), input);
  assertReservedNames(segments, platform, input);

  const canonical = anchor + segments.join('/');

  // Boundary check: result must be within root (WS-003).
  assertWithinRoot(canonical, root, platform, input);

  return canonical;
}

/** True if `child` is `root` or a descendant of `root`, comparing lexically. */
export function isWithinRoot(
  child: string,
  root: string,
  platform: 'win32' | 'linux' = process.platform === 'win32' ? 'win32' : 'linux',
): boolean {
  const c = normalizeForCompare(toCanonicalSeparators(child), platform);
  const r = normalizeForCompare(stripTrailingSlash(toCanonicalSeparators(root)), platform);
  if (c === r) return true;
  return c.startsWith(`${r}/`);
}

function assertWithinRoot(
  canonical: string,
  root: string,
  platform: 'win32' | 'linux',
  pathForError: string,
): void {
  if (!isWithinRoot(canonical, root, platform)) {
    throw new PathError('PATH_ESCAPE', pathForError, `resolves outside root: ${canonical}`);
  }
}

function stripTrailingSlash(p: string): string {
  if (p.length > 1 && p.endsWith('/')) return p.slice(0, -1);
  return p;
}

/** Case-fold on case-insensitive platforms so boundary comparison is correct. */
function normalizeForCompare(p: string, platform: 'win32' | 'linux'): string {
  return platform === 'win32' ? p.toLowerCase() : p;
}

/** Relative canonical path of `child` under `root` ('/'-separated, no leading slash). */
export function relativeToRoot(
  child: string,
  root: string,
  platform: 'win32' | 'linux' = process.platform === 'win32' ? 'win32' : 'linux',
): string {
  if (!isWithinRoot(child, root, platform)) {
    throw new PathError('PATH_ESCAPE', child, `not under root: ${child}`);
  }
  const c = toCanonicalSeparators(child);
  const r = stripTrailingSlash(toCanonicalSeparators(root));
  if (normalizeForCompare(c, platform) === normalizeForCompare(r, platform)) return '';
  return c.slice(r.length + 1);
}
