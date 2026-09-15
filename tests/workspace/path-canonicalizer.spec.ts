// C3 — Path canonicalizer acceptance (PHASE_0_ACCEPTANCE §3.6, PC-1..PC-10).
// Enforces WS-003 (path traversal), WS-004 (symlink escape/loop).
import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath as fsRealpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  canonicalizePath,
  resolveRealpath,
  isWithinRoot,
  relativeToRoot,
  findCaseCollision,
  detectCaseSensitivity,
  PathError,
} from '@codeforge/infrastructure';

const ROOT_POSIX = '/home/user/project';
const ROOT_WIN = 'C:/Users/user/project';

function expectPathError(fn: () => unknown, code: string): void {
  try {
    fn();
    throw new Error('expected PathError but none thrown');
  } catch (e) {
    expect(e).toBeInstanceOf(PathError);
    expect((e as PathError).code).toBe(code);
  }
}

describe('canonicalizePath — basics', () => {
  it('joins a relative path to root and uses "/" separators', () => {
    expect(canonicalizePath('src/a.ts', { root: ROOT_POSIX, platform: 'linux' })).toBe(
      '/home/user/project/src/a.ts',
    );
  });

  it('normalizes "." and redundant separators', () => {
    expect(canonicalizePath('./src//./a.ts', { root: ROOT_POSIX, platform: 'linux' })).toBe(
      '/home/user/project/src/a.ts',
    );
  });

  it('collapses interior ".." that stays within root', () => {
    expect(canonicalizePath('src/x/../a.ts', { root: ROOT_POSIX, platform: 'linux' })).toBe(
      '/home/user/project/src/a.ts',
    );
  });

  it('accepts backslash input and canonicalizes to "/"', () => {
    expect(canonicalizePath('src\\a.ts', { root: ROOT_WIN, platform: 'win32' })).toBe(
      'C:/Users/user/project/src/a.ts',
    );
  });

  it('is deterministic (PC-10): same input → same output', () => {
    const a = canonicalizePath('src/../src/a.ts', { root: ROOT_POSIX, platform: 'linux' });
    const b = canonicalizePath('src/../src/a.ts', { root: ROOT_POSIX, platform: 'linux' });
    expect(a).toBe(b);
  });
});

describe('canonicalizePath — PC-1 traversal, PC-2 absolute escape', () => {
  it('PC-1: rejects ".." escape above root', () => {
    expectPathError(
      () => canonicalizePath('../../etc/passwd', { root: ROOT_POSIX, platform: 'linux' }),
      'PATH_ESCAPE',
    );
  });

  it('PC-1: rejects deep ".." that climbs out', () => {
    expectPathError(
      () => canonicalizePath('src/../../../outside', { root: ROOT_POSIX, platform: 'linux' }),
      'PATH_ESCAPE',
    );
  });

  it('PC-2: rejects absolute path outside root', () => {
    expectPathError(
      () => canonicalizePath('/etc/passwd', { root: ROOT_POSIX, platform: 'linux' }),
      'PATH_ESCAPE',
    );
  });

  it('PC-2: rejects sibling directory', () => {
    expectPathError(
      () => canonicalizePath('/home/user/other', { root: ROOT_POSIX, platform: 'linux' }),
      'PATH_ESCAPE',
    );
  });

  it('accepts an absolute path that is inside root', () => {
    expect(
      canonicalizePath('/home/user/project/src/a.ts', { root: ROOT_POSIX, platform: 'linux' }),
    ).toBe('/home/user/project/src/a.ts');
  });
});

describe('canonicalizePath — PC-5 null byte', () => {
  it('PC-5: rejects NUL byte in path', () => {
    expectPathError(
      () => canonicalizePath('src/a\0b.ts', { root: ROOT_POSIX, platform: 'linux' }),
      'NULL_BYTE',
    );
  });
});

describe('canonicalizePath — PC-6 UNC, PC-7 long path (Windows policy)', () => {
  it('PC-6: rejects UNC path on Windows', () => {
    expectPathError(
      () => canonicalizePath('\\\\server\\share\\f.ts', { root: ROOT_WIN, platform: 'win32' }),
      'UNC_PATH',
    );
  });

  it('PC-7: rejects long-path prefix on Windows', () => {
    expectPathError(
      () => canonicalizePath('\\\\?\\C:\\x', { root: ROOT_WIN, platform: 'win32' }),
      'LONG_PATH_PREFIX',
    );
  });

  it('rejects Windows reserved device name', () => {
    expectPathError(
      () => canonicalizePath('src/CON', { root: ROOT_WIN, platform: 'win32' }),
      'RESERVED_NAME',
    );
  });

  it('rejects reserved name with extension (NUL.txt)', () => {
    expectPathError(
      () => canonicalizePath('NUL.txt', { root: ROOT_WIN, platform: 'win32' }),
      'RESERVED_NAME',
    );
  });

  it('allows reserved-like names on Linux', () => {
    expect(canonicalizePath('src/CON', { root: ROOT_POSIX, platform: 'linux' })).toBe(
      '/home/user/project/src/CON',
    );
  });
});

describe('canonicalizePath — PC-8/PC-9 separators & case boundary', () => {
  it('PC-9: separator normalization both ways', () => {
    expect(canonicalizePath('a\\b/c', { root: ROOT_WIN, platform: 'win32' })).toBe(
      'C:/Users/user/project/a/b/c',
    );
  });

  it('PC-8: boundary is case-insensitive on Windows', () => {
    // Same logical path with different case of root drive should still be within root.
    expect(isWithinRoot('c:/Users/user/project/a.ts', ROOT_WIN, 'win32')).toBe(true);
  });

  it('PC-8: boundary is case-sensitive on Linux', () => {
    expect(isWithinRoot('/home/user/Project/a.ts', ROOT_POSIX, 'linux')).toBe(false);
    expect(isWithinRoot('/home/user/project/a.ts', ROOT_POSIX, 'linux')).toBe(true);
  });
});

describe('relativeToRoot', () => {
  it('returns "" for the root itself', () => {
    expect(relativeToRoot('/home/user/project', ROOT_POSIX, 'linux')).toBe('');
  });

  it('returns canonical relative path', () => {
    expect(relativeToRoot('/home/user/project/src/a.ts', ROOT_POSIX, 'linux')).toBe('src/a.ts');
  });

  it('rejects a path outside root', () => {
    expectPathError(() => relativeToRoot('/etc/x', ROOT_POSIX, 'linux'), 'PATH_ESCAPE');
  });
});

describe('findCaseCollision (WORKSPACE_SPEC §3.3)', () => {
  it('detects two paths differing only by case', () => {
    expect(findCaseCollision(['src/Foo.ts', 'src/foo.ts'])).toEqual(['src/Foo.ts', 'src/foo.ts']);
  });

  it('returns null when no collision', () => {
    expect(findCaseCollision(['src/a.ts', 'src/b.ts', 'src/A.md'])).toBeNull();
  });

  it('does not flag identical paths', () => {
    expect(findCaseCollision(['src/a.ts', 'src/a.ts'])).toBeNull();
  });
});

describe('detectCaseSensitivity', () => {
  it('returns a boolean for the OS temp dir', async () => {
    const result = await detectCaseSensitivity();
    expect(typeof result).toBe('boolean');
  });
});

describe('resolveRealpath — PC-3 symlink escape, PC-4 loop', () => {
  it('PC-3: rejects symlink whose target is outside root', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'cf2-rp-'));
    const root = join(parent, 'root');
    const outside = join(parent, 'outside');
    await mkdir(root, { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, 'secret.txt'), 'x');

    let symlinkCreated = true;
    try {
      await symlink(outside, join(root, 'evil'), 'dir');
    } catch {
      symlinkCreated = false; // Windows without Dev Mode
    }

    try {
      if (!symlinkCreated) return; // skip on platforms without symlink support
      const canonicalRoot = (await fsRealpath(root)).replace(/\\/g, '/');
      await expect(
        resolveRealpath('evil/secret.txt', { root: canonicalRoot }),
      ).rejects.toMatchObject({ code: 'SYMLINK_ESCAPE' });
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('resolves an internal symlink that stays within root', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'cf2-rp-'));
    const root = join(parent, 'root');
    await mkdir(join(root, 'real'), { recursive: true });
    await writeFile(join(root, 'real', 'a.txt'), 'x');

    let symlinkCreated = true;
    try {
      await symlink(join(root, 'real'), join(root, 'link'), 'dir');
    } catch {
      symlinkCreated = false;
    }

    try {
      if (!symlinkCreated) return;
      const canonicalRoot = (await fsRealpath(root)).replace(/\\/g, '/');
      const resolved = await resolveRealpath('link/a.txt', { root: canonicalRoot });
      expect(resolved.endsWith('/real/a.txt')).toBe(true);
      expect(isWithinRoot(resolved, canonicalRoot)).toBe(true);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('PC-4: rejects a symlink loop', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'cf2-rp-'));
    const root = join(parent, 'root');
    await mkdir(root, { recursive: true });

    let symlinkCreated = true;
    try {
      await symlink(join(root, 'b'), join(root, 'a'), 'dir');
      await symlink(join(root, 'a'), join(root, 'b'), 'dir');
    } catch {
      symlinkCreated = false;
    }

    try {
      if (!symlinkCreated) return;
      const canonicalRoot = (await fsRealpath(root)).replace(/\\/g, '/');
      await expect(resolveRealpath('a/x.txt', { root: canonicalRoot })).rejects.toMatchObject({
        code: expect.stringMatching(/SYMLINK_LOOP|NOT_FOUND/),
      });
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });
});
