// Canonical line format — WORKSPACE_SPEC §6.3, §7.4 (v020).
//
// Format (unified for all entry types):
//   <type>\t<relpath>\t<payload>\n
//
//   type    = FILE | SYMLINK | DIR
//   relpath = canonical relative path, '/'-separated, UTF-8, NFC-normalized, ESCAPED
//   payload = FILE:    "<size>\0<sha256hex>"
//             SYMLINK: "<target>"           (target string, escaped)
//             DIR:     ""                   (empty; only for empty directories)
//   terminator = \n
//
// Note on §6.2 vs §6.3: §6.2 step 4 sketches a "\0"-separated form; §6.3 defines the
// authoritative tab-separated line with a bounded payload. We follow §6.3 (the detailed
// spec with a field table) — this is also consistent with v020 ("tab separator, not space").
//
// Escape scheme (§7.4), applied to relpath and symlink target so tab/newline/nul in
// names cannot break the line grammar:
//   \\  -> \\\\   (must be first)
//   \n  -> \\n
//   \t  -> \\t
//   \0  -> \\0

export type EntryType = 'FILE' | 'SYMLINK' | 'DIR';

/** Escape control/separator chars in a path or target so the line grammar is unambiguous. */
export function escapeField(s: string): string {
  let out = '';
  for (const ch of s) {
    switch (ch) {
      case '\\':
        out += '\\\\';
        break;
      case '\n':
        out += '\\n';
        break;
      case '\t':
        out += '\\t';
        break;
      case '\0':
        out += '\\0';
        break;
      default:
        out += ch;
    }
  }
  return out;
}

/** NFC-normalize a relative path (WORKSPACE_SPEC §6.3: relpath is NFC). */
export function nfc(relpath: string): string {
  return relpath.normalize('NFC');
}

export function fileLine(relpath: string, size: number, sha256hex: string): string {
  return `FILE\t${escapeField(nfc(relpath))}\t${size}\0${sha256hex}\n`;
}

export function symlinkLine(relpath: string, target: string): string {
  return `SYMLINK\t${escapeField(nfc(relpath))}\t${escapeField(target)}\n`;
}

export function dirLine(relpath: string): string {
  return `DIR\t${escapeField(nfc(relpath))}\t\n`;
}
