// The 20 canonical workspace vectors (A3) — WORKSPACE_SPEC §7.1, §7.4.
import type { WorkspaceVector } from './types.js';

const enc = (s: string): string => Buffer.from(s, 'utf8').toString('base64');
const bytes = (...b: number[]): string => Buffer.from(b).toString('base64');

// Deterministic pseudo-content for bulk vectors (no randomness).
function repeatContent(seed: string, n: number): string {
  let s = '';
  for (let i = 0; i < n; i++) s += `${seed}${i}\n`;
  return s;
}

export const VECTORS: readonly WorkspaceVector[] = [
  {
    id: 'v001-empty',
    notes: 'empty workspace (no entries)',
    entries: [],
  },
  {
    id: 'v002-single-file',
    notes: 'single ASCII file',
    entries: [{ kind: 'file', path: 'a.txt', base64: enc('hello') }],
  },
  {
    id: 'v003-multiple-files',
    notes: 'multiple files at root',
    entries: [
      { kind: 'file', path: 'a.txt', base64: enc('alpha') },
      { kind: 'file', path: 'b.txt', base64: enc('bravo') },
      { kind: 'file', path: 'c.txt', base64: enc('charlie') },
    ],
  },
  {
    id: 'v004-nested-dirs',
    notes: 'nested directories with files',
    entries: [
      { kind: 'file', path: 'src/index.ts', base64: enc('export {};\n') },
      { kind: 'file', path: 'src/lib/util.ts', base64: enc('export const x = 1;\n') },
      { kind: 'file', path: 'README.md', base64: enc('# title\n') },
    ],
  },
  {
    id: 'v005-line-endings-crlf',
    notes: 'file with CRLF line endings',
    entries: [{ kind: 'file', path: 'a.txt', base64: bytes(0x6c, 0x31, 0x0d, 0x0a, 0x6c, 0x32) }], // "l1\r\nl2"
  },
  {
    id: 'v006-line-endings-lf',
    notes: 'file with LF line endings (must differ from v005)',
    entries: [{ kind: 'file', path: 'a.txt', base64: bytes(0x6c, 0x31, 0x0a, 0x6c, 0x32) }], // "l1\nl2"
  },
  {
    id: 'v007-line-endings-mixed',
    notes: 'file with mixed CRLF and LF',
    entries: [{ kind: 'file', path: 'a.txt', base64: bytes(0x6c, 0x31, 0x0d, 0x0a, 0x6c, 0x32, 0x0a, 0x6c, 0x33) }], // "l1\r\nl2\nl3"
  },
  {
    id: 'v008-unicode-nfc',
    notes: 'NFC filename (café.txt composed) — same hash as v009',
    entries: [{ kind: 'file', path: 'caf\u00e9.txt', base64: enc('x') }],
  },
  {
    id: 'v009-unicode-nfd',
    notes: 'NFD filename (café.txt decomposed) — same hash as v008 after NFC',
    entries: [{ kind: 'file', path: 'cafe\u0301.txt', base64: enc('x') }],
  },
  {
    id: 'v010-symlink-internal',
    notes: 'symlink pointing inside root — recorded, not followed',
    requiresSymlink: true,
    platforms: ['linux', 'win32'],
    entries: [
      { kind: 'file', path: 'real/a.txt', base64: enc('x') },
      { kind: 'symlink', path: 'link', target: 'real', type: 'dir' },
    ],
  },
  {
    id: 'v011-symlink-external',
    notes: 'symlink pointing outside root — skipped with warning',
    requiresSymlink: true,
    platforms: ['linux', 'win32'],
    entries: [
      { kind: 'file', path: 'a.txt', base64: enc('x') },
      { kind: 'symlink', path: 'escape', target: '__OUTSIDE__', external: true, type: 'dir' },
    ],
  },
  {
    id: 'v012-scratch-zone',
    notes: 'node_modules excluded via scratch prefix',
    scratchPrefixes: ['node_modules'],
    entries: [
      { kind: 'file', path: 'src/a.ts', base64: enc('x') },
      { kind: 'file', path: 'node_modules/pkg/index.js', base64: enc('junk') },
    ],
  },
  {
    id: 'v013-empty-directory',
    notes: 'empty directory is included in the hash',
    entries: [
      { kind: 'file', path: 'a.txt', base64: enc('x') },
      { kind: 'dir', path: 'emptydir' },
    ],
  },
  {
    id: 'v014-file-with-spaces',
    notes: 'filename containing spaces',
    entries: [{ kind: 'file', path: 'my file.txt', base64: enc('x') }],
  },
  {
    id: 'v015-file-with-unicode-name',
    notes: 'unicode (CJK) filename',
    entries: [{ kind: 'file', path: '\u65e5\u672c\u8a9e.txt', base64: enc('x') }],
  },
  {
    id: 'v016-case-collision',
    notes: 'Foo.ts + foo.ts — only creatable on case-sensitive FS (linux)',
    platforms: ['linux'],
    entries: [
      { kind: 'file', path: 'Foo.ts', base64: enc('upper') },
      { kind: 'file', path: 'foo.ts', base64: enc('lower') },
    ],
  },
  {
    id: 'v017-large-file',
    notes: '2 MB file — streaming hash, no OOM',
    entries: [{ kind: 'file', path: 'big.bin', base64: Buffer.alloc(2 * 1024 * 1024, 0x61).toString('base64') }],
  },
  {
    id: 'v018-many-files',
    notes: '500 small files',
    entries: Array.from({ length: 500 }, (_, i) => ({
      kind: 'file' as const,
      path: `f/${String(i).padStart(4, '0')}.txt`,
      base64: enc(`file ${i}\n`),
    })),
  },
  {
    id: 'v019-permissions',
    notes: 'executable bit — must NOT change hash (v1 excludes mode); linux only',
    platforms: ['linux'],
    entries: [{ kind: 'file', path: 'run.sh', base64: enc('#!/bin/sh\necho hi\n'), mode: 0o755 }],
  },
  {
    id: 'v020-special-chars',
    notes: 'filename with tab (escaped in canonical line); linux only (Windows forbids)',
    platforms: ['linux'],
    entries: [{ kind: 'file', path: 'foo\tbar.txt', base64: enc('x') }],
  },
];

export const VECTORS_BY_ID: ReadonlyMap<string, WorkspaceVector> = new Map(
  VECTORS.map((v) => [v.id, v]),
);

export { repeatContent };
