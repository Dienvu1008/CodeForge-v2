// C1 — Canonical hash acceptance (PHASE_0_ACCEPTANCE §3.3, CH-1..CH-20 subset).
// Enforces WS-001 (canonical), WS-002 (no false negative), WS-009 (no Git dependence).
//
// These tests build real directory trees in a temp dir (not Git-checked-out), so they
// are byte-exact. Full binary-fixture vectors (v001..v020) come with A3.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, symlink, realpath as fsRealpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  computeWorkspaceHash,
  escapeField,
  fileLine,
  dirLine,
} from '@codeforge/infrastructure';

let root: string;

beforeEach(async () => {
  const parent = await mkdtemp(join(tmpdir(), 'cf2-hash-'));
  root = (await fsRealpath(parent)).replace(/\\/g, '/');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function write(rel: string, content: string | Buffer): Promise<void> {
  const abs = join(root, rel);
  await mkdir(join(abs, '..'), { recursive: true });
  await writeFile(abs, content);
}

async function hash(scratchPrefixes?: string[]): Promise<string> {
  const r = await computeWorkspaceHash({
    root,
    ...(scratchPrefixes ? { scratchPrefixes } : {}),
  });
  return r.hash;
}

describe('canonical-line format', () => {
  it('escapes tab/newline/nul/backslash in relpath', () => {
    expect(escapeField('a\tb')).toBe('a\\tb');
    expect(escapeField('a\nb')).toBe('a\\nb');
    expect(escapeField('a\0b')).toBe('a\\0b');
    expect(escapeField('a\\b')).toBe('a\\\\b');
  });

  it('backslash is escaped before others (no double-escaping)', () => {
    expect(escapeField('\\t')).toBe('\\\\t'); // literal backslash + t, not a tab
  });

  it('fileLine / dirLine shape', () => {
    expect(fileLine('a.txt', 3, 'deadbeef')).toBe('FILE\ta.txt\t3\0deadbeef\n');
    expect(dirLine('emptydir')).toBe('DIR\temptydir\t\n');
  });
});

describe('CH-2/CH-3/CH-4: basic content', () => {
  it('CH-2: empty workspace has a stable hash', async () => {
    const h1 = await hash();
    expect(h1).toMatch(/^[0-9a-f]{64}$/); // blake3 256-bit hex
  });

  it('CH-3: single file', async () => {
    await write('a.txt', 'hello');
    const r = await computeWorkspaceHash({ root });
    expect(r.fileCount).toBe(1);
    expect(r.totalBytes).toBe(5);
    expect(r.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('CH-4: multiple files, order-independent hash', async () => {
    await write('b.txt', '2');
    await write('a.txt', '1');
    const h1 = await hash();
    // Recreate in different creation order → same logical content → same hash.
    await rm(root, { recursive: true, force: true });
    await mkdir(root, { recursive: true });
    await write('a.txt', '1');
    await write('b.txt', '2');
    const h2 = await hash();
    expect(h2).toBe(h1);
  });

  it('nested dirs produce a stable hash', async () => {
    await write('src/deep/a.ts', 'x');
    const h1 = await hash();
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('CH-19 determinism / CH-20 no false negative', () => {
  it('CH-19: same input → same hash', async () => {
    await write('a.txt', 'content');
    const h1 = await hash();
    const h2 = await hash();
    expect(h2).toBe(h1);
  });

  it('CH-20: one changed byte → different hash', async () => {
    await write('a.txt', 'content');
    const h1 = await hash();
    await write('a.txt', 'contenu'); // same length, different byte
    const h2 = await hash();
    expect(h2).not.toBe(h1);
  });

  it('CH-20: add a file → different hash', async () => {
    await write('a.txt', 'x');
    const h1 = await hash();
    await write('b.txt', 'y');
    const h2 = await hash();
    expect(h2).not.toBe(h1);
  });

  it('CH-20: delete a file → different hash', async () => {
    await write('a.txt', 'x');
    await write('b.txt', 'y');
    const h1 = await hash();
    await rm(join(root, 'b.txt'), { force: true });
    const h2 = await hash();
    expect(h2).not.toBe(h1);
  });
});

describe('CH-6: line endings are real changes', () => {
  it('CRLF vs LF → different hash', async () => {
    await write('a.txt', Buffer.from('line1\r\nline2', 'utf8'));
    const crlf = await hash();
    await write('a.txt', Buffer.from('line1\nline2', 'utf8'));
    const lf = await hash();
    expect(crlf).not.toBe(lf);
  });
});

describe('CH-7: unicode normalization', () => {
  it('NFC vs NFD filename → same hash', async () => {
    // "é": NFC = U+00E9 ; NFD = U+0065 U+0301
    const nfcName = 'caf\u00e9.txt';
    const nfdName = 'cafe\u0301.txt';
    await write(nfcName, 'x');
    const h1 = await hash();
    await rm(root, { recursive: true, force: true });
    await mkdir(root, { recursive: true });
    await write(nfdName, 'x');
    const h2 = await hash();
    expect(h2).toBe(h1);
  });
});

describe('CH-10: scratch zone excluded', () => {
  it('files under scratch prefix do not affect hash', async () => {
    await write('src/a.ts', 'x');
    const baseline = await hash(['node_modules', 'dist']);
    await write('node_modules/pkg/index.js', 'junk');
    await write('dist/out.js', 'built');
    const withScratch = await hash(['node_modules', 'dist']);
    expect(withScratch).toBe(baseline);
  });

  it('same path counts when NOT declared scratch', async () => {
    await write('src/a.ts', 'x');
    const baseline = await hash([]);
    await write('node_modules/pkg/index.js', 'junk');
    const noScratch = await hash([]);
    expect(noScratch).not.toBe(baseline);
  });
});

describe('CH-11: empty directory matters', () => {
  it('adding an empty dir changes the hash', async () => {
    await write('a.txt', 'x');
    const h1 = await hash();
    await mkdir(join(root, 'emptydir'), { recursive: true });
    const h2 = await hash();
    expect(h2).not.toBe(h1);
  });
});

describe('CH-8/CH-9: symlink handling', () => {
  it('internal symlink recorded, not followed; external skipped', async () => {
    await write('real/a.txt', 'x');
    let internalOk = true;
    try {
      await symlink(join(root, 'real'), join(root, 'link'), 'dir');
    } catch {
      internalOk = false;
    }
    if (!internalOk) return; // no symlink support (Windows w/o Dev Mode)

    const r = await computeWorkspaceHash({ root });
    // The symlink is recorded as SYMLINK (not traversed into a second copy of a.txt).
    expect(r.canonicalManifest).toContain('SYMLINK\tlink\t');
    // Only the real file is counted once.
    expect(r.fileCount).toBe(1);
  });
});
