/*
 * Copyright 2026 DienVu (Dienvu1008)
 * SPDX-License-Identifier: Apache-2.0
 */

// kernel-gap-closure task 1.2 (TEST-FIRST): Shell_Classifier (design C2).
//
// Covers Properties 3, 4, 5, 7 and the classifier part of 16, plus the example list of the task.
// The module `packages/agent-core/src/tool/shell-classifier.ts` is created by task 3.2; until then
// this file fails (the imported functions/sets do not exist yet). That failure is expected.
//
// Conventions fixed here (they follow design C2 and the Glossary):
//   - `extractShellArguments(inv)` receives an invocation whose `args` exclude the command name.
//   - For a `name=value` argument `pathLike` / `envExpansions` hold the VALUE (that is what the
//     executor passes to `checkPath`), not the whole `name=value` string.
//   - `fileCandidates` are asserted only for arguments without `=` (the Glossary leaves the
//     `name=value` case for File_Candidate_Argument open).
//
// Validates: Requirements 2.1-2.6, 3.4, 3.5, 4.1-4.3, 5.1, 5.2, 10.2

import { describe, it, expect } from 'vitest';
import {
  normalizeInvocation,
  classifyShellInvocation,
  extractShellArguments,
  DESTRUCTIVE_COMMANDS,
  NETWORK_COMMANDS,
  MUTATING_PATH_COMMANDS,
  ENV_EXPANSION_EXEMPT_COMMANDS,
  type ShellInvocation,
  type ShellRisk,
} from '@codeforge/agent-core';
import {
  forAll,
  int,
  bool,
  pick,
  pathSegment,
  pathOf,
  plainArgs,
  randomCase,
  whitespace,
  type Rng,
} from '../tool/gap-closure-generators.js';

const RUNS = 150;

// ── literal command lists from the requirements (independent of the exported sets) ─────────────

const DESTRUCTIVE_NAMES = ['rm', 'rmdir', 'del', 'erase', 'rd', 'remove-item', 'shred', 'dd', 'format', 'mkfs'] as const;
const NETWORK_NAMES = [
  'curl', 'wget', 'ssh', 'scp', 'sftp', 'nc', 'ncat', 'netcat', 'telnet', 'ftp',
  'invoke-webrequest', 'iwr', 'invoke-restmethod', 'irm',
] as const;
const MUTATING_NAMES = [
  'rm', 'rmdir', 'del', 'erase', 'rd', 'mv', 'move', 'cp', 'copy', 'shred', 'dd', 'tee', 'touch', 'mkdir', 'chmod', 'chown',
] as const;

const EXTENSIONS = ['', '.exe', '.cmd', '.bat', '.ps1'] as const;

// ── helpers ─────────────────────────────────────────────────────────────────────────────────────

function inv(command: string, ...args: string[]): ShellInvocation {
  return normalizeInvocation(command, args);
}

function risk(command: string, ...args: string[]): ShellRisk {
  return classifyShellInvocation(inv(command, ...args));
}

/** Directory prefix + random case + extension around a bare lowercase name. */
function decorateName(rng: Rng, name: string): string {
  const prefix = pick(rng, [
    '',
    '',
    `${pathOf(rng, '/')}/`,
    '/usr/bin/',
    './',
    'C:\\tools\\',
    `${pathOf(rng, '\\')}\\`,
  ]);
  const ext = pick(rng, EXTENSIONS);
  return `${prefix}${randomCase(rng, `${name}${ext}`)}`;
}

/** Trailing arguments that can never be mistaken for an install/subcommand word. */
function safeTrail(rng: Rng): string[] {
  const pool = ['--verbose', '-v', '--force', '-n', '--quiet', './pkg', './src/x.js', './...'];
  const out: string[] = [];
  const n = int(rng, 0, 3);
  for (let i = 0; i < n; i++) out.push(pick(rng, pool));
  return out;
}

function insertAt<T>(rng: Rng, list: readonly T[], item: T): T[] {
  const out = [...list];
  out.splice(int(rng, 0, out.length), 0, item);
  return out;
}

// ── normalizeInvocation: examples ──────────────────────────────────────────────────────────────

describe('normalizeInvocation (examples)', () => {
  it('splits a single command string into name and args', () => {
    expect(normalizeInvocation('rm -rf ..')).toEqual({ name: 'rm', args: ['-rf', '..'] });
  });

  it('single-string form equals the split form', () => {
    expect(normalizeInvocation('rm -rf ..')).toEqual(normalizeInvocation('rm', ['-rf', '..']));
  });

  it('prepends the extra tokens of command to args', () => {
    expect(normalizeInvocation('rm -rf', ['..'])).toEqual({ name: 'rm', args: ['-rf', '..'] });
  });

  it('defaults args to an empty list', () => {
    expect(normalizeInvocation('npm')).toEqual({ name: 'npm', args: [] });
  });

  it('strips directory prefix, lower-cases and removes the extension (C:\\tools\\RM.EXE)', () => {
    expect(normalizeInvocation('C:\\tools\\RM.EXE', ['-rf', 'x']).name).toBe('rm');
    expect(normalizeInvocation('/usr/bin/Git', ['status'])).toEqual({ name: 'git', args: ['status'] });
    expect(normalizeInvocation('./node_modules/.bin/ESLINT.CMD').name).toBe('eslint');
    expect(normalizeInvocation('Remove-Item.ps1').name).toBe('remove-item');
    expect(normalizeInvocation('tool.bat').name).toBe('tool');
  });

  it('does not mutate the caller args array', () => {
    const args = ['-rf', '..'];
    normalizeInvocation('rm', args);
    expect(args).toEqual(['-rf', '..']);
  });
});

// ── exported constant sets ─────────────────────────────────────────────────────────────────────

describe('exported command sets', () => {
  it('DESTRUCTIVE_COMMANDS covers the requirement 2.1 names', () => {
    for (const n of DESTRUCTIVE_NAMES) expect(DESTRUCTIVE_COMMANDS.has(n), n).toBe(true);
  });

  it('NETWORK_COMMANDS covers the requirement 4.1 names', () => {
    for (const n of NETWORK_NAMES) expect(NETWORK_COMMANDS.has(n), n).toBe(true);
  });

  it('MUTATING_PATH_COMMANDS covers the requirement 8.2 names', () => {
    for (const n of MUTATING_NAMES) expect(MUTATING_PATH_COMMANDS.has(n), n).toBe(true);
  });

  it('ENV_EXPANSION_EXEMPT_COMMANDS is echo and printf', () => {
    expect(ENV_EXPANSION_EXEMPT_COMMANDS.has('echo')).toBe(true);
    expect(ENV_EXPANSION_EXEMPT_COMMANDS.has('printf')).toBe(true);
    expect(ENV_EXPANSION_EXEMPT_COMMANDS.has('rm')).toBe(false);
  });

  it('mv and move are not DESTRUCTIVE commands (design D-A)', () => {
    expect(DESTRUCTIVE_COMMANDS.has('mv')).toBe(false);
    expect(DESTRUCTIVE_COMMANDS.has('move')).toBe(false);
  });
});

// ── Property 3 ─────────────────────────────────────────────────────────────────────────────────

describe('Property 3: destructive and network classification is stable under name decoration', () => {
  // Feature: kernel-gap-closure, Property 3: Destructive and network classification is stable under name decoration
  // **Validates: Requirements 2.1, 2.5, 2.6, 4.1**
  const cases: ReadonlyArray<{ names: readonly string[]; expected: ShellRisk }> = [
    { names: DESTRUCTIVE_NAMES, expected: 'DESTRUCTIVE' },
    { names: NETWORK_NAMES, expected: 'NETWORK' },
  ];

  for (const { names, expected } of cases) {
    it(`${expected}: any prefix, case, extension and args; single-string form equals split form`, () => {
      forAll(0x3000 + names.length, RUNS, (rng) => {
        const name = pick(rng, names);
        const decorated = decorateName(rng, name);
        const args = plainArgs(rng);
        const split = classifyShellInvocation(normalizeInvocation(decorated, args));
        expect(split, `${decorated} ${args.join(' ')}`).toBe(expected);

        const sep = whitespace(rng);
        const joined = args.length === 0 ? decorated : `${decorated}${sep}${args.join(sep)}`;
        expect(classifyShellInvocation(normalizeInvocation(joined))).toBe(split);
      });
    });
  }

  it('mkfs.<fs> is DESTRUCTIVE (requirement 2.1)', () => {
    forAll(0x3010, RUNS, (rng) => {
      const fs = pick(rng, ['ext4', 'ext3', 'xfs', 'vfat', 'btrfs', pathSegment(rng)]);
      expect(risk(decorateName(rng, `mkfs.${fs}`).replace(/\.(exe|cmd|bat|ps1)$/i, ''), '/dev/sdb1')).toBe('DESTRUCTIVE');
    });
  });
});

// ── Property 4 ─────────────────────────────────────────────────────────────────────────────────

describe('Property 4: subcommand and flag rules classify as specified', () => {
  // Feature: kernel-gap-closure, Property 4: Subcommand and flag rules classify as specified
  // **Validates: Requirements 2.2, 2.3, 2.4, 4.2, 4.3**

  it('chmod/chown are DESTRUCTIVE exactly when a recursive flag is present', () => {
    forAll(0x4001, RUNS, (rng) => {
      const name = decorateName(rng, pick(rng, ['chmod', 'chown'] as const));
      const base = [pick(rng, ['755', 'u+x', 'root:root', 'dev']), pathSegment(rng), ...safeTrail(rng)];
      const recursive = bool(rng);
      const flag = pick(rng, ['-R', '-r', '--recursive']);
      const args = recursive ? insertAt(rng, base, flag) : base;
      expect(classifyShellInvocation(normalizeInvocation(name, args)), `${name} ${args.join(' ')}`).toBe(
        recursive ? 'DESTRUCTIVE' : 'SYSTEM',
      );
    });
  });

  it('find is DESTRUCTIVE exactly when -delete/-exec/-execdir/-ok/-okdir is present', () => {
    forAll(0x4002, RUNS, (rng) => {
      const name = decorateName(rng, 'find');
      const base = ['.', '-name', `${pathSegment(rng)}.tmp`, ...safeTrail(rng)];
      const dangerous = bool(rng);
      const flag = pick(rng, ['-delete', '-exec', '-execdir', '-ok', '-okdir']);
      const args = dangerous ? insertAt(rng, base, flag) : base;
      expect(classifyShellInvocation(normalizeInvocation(name, args)), `${name} ${args.join(' ')}`).toBe(
        dangerous ? 'DESTRUCTIVE' : 'SYSTEM',
      );
    });
  });

  // reference table: subcommand -> (extra arg that decides, class with it, class without it)
  type GitRow = { sub: string; with?: string; yes: ShellRisk; no: ShellRisk };
  const GIT_TABLE: readonly GitRow[] = [
    { sub: 'rm', yes: 'DESTRUCTIVE', no: 'DESTRUCTIVE' },
    { sub: 'clean', yes: 'DESTRUCTIVE', no: 'DESTRUCTIVE' },
    { sub: 'restore', yes: 'DESTRUCTIVE', no: 'DESTRUCTIVE' },
    { sub: 'reset', with: '--hard', yes: 'DESTRUCTIVE', no: 'SYSTEM' },
    { sub: 'checkout', with: '--', yes: 'DESTRUCTIVE', no: 'SYSTEM' },
    { sub: 'clone', yes: 'NETWORK', no: 'NETWORK' },
    { sub: 'fetch', yes: 'NETWORK', no: 'NETWORK' },
    { sub: 'pull', yes: 'NETWORK', no: 'NETWORK' },
    { sub: 'push', yes: 'NETWORK', no: 'NETWORK' },
    { sub: 'ls-remote', yes: 'NETWORK', no: 'NETWORK' },
    { sub: 'status', yes: 'SYSTEM', no: 'SYSTEM' },
    { sub: 'diff', yes: 'SYSTEM', no: 'SYSTEM' },
    { sub: 'log', yes: 'SYSTEM', no: 'SYSTEM' },
    { sub: 'add', yes: 'SYSTEM', no: 'SYSTEM' },
    { sub: 'commit', yes: 'SYSTEM', no: 'SYSTEM' },
  ];

  /** Global options (with values that look like subcommands) placed before the subcommand. */
  function globalOptions(rng: Rng): string[] {
    const trapValue = (): string => pick(rng, ['clean', 'rm', 'push', 'reset', pathSegment(rng)]);
    const out: string[] = [];
    const n = int(rng, 0, 3);
    for (let i = 0; i < n; i++) {
      switch (int(rng, 0, 5)) {
        case 0: out.push('-C', trapValue()); break;
        case 1: out.push('-c', `${pathSegment(rng)}.${pathSegment(rng)}=${trapValue()}`); break;
        case 2: out.push('--git-dir', trapValue()); break;
        case 3: out.push('--work-tree', trapValue()); break;
        case 4: out.push('--namespace', trapValue()); break;
        default: out.push('--no-pager'); break;
      }
    }
    return out;
  }

  it('git subcommands classify per the reference table, global options with values skipped', () => {
    forAll(0x4003, RUNS * 2, (rng) => {
      const row = pick(rng, GIT_TABLE);
      const withExtra = row.with !== undefined && bool(rng);
      let tail = safeTrail(rng).filter((a) => a !== '--force' && a !== '-n');
      if (withExtra && row.with !== undefined) tail = insertAt(rng, tail, row.with);
      const args = [...globalOptions(rng), row.sub, ...tail];
      const expected = withExtra ? row.yes : row.no;
      expect(
        classifyShellInvocation(normalizeInvocation(decorateName(rng, 'git'), args)),
        `git ${args.join(' ')}`,
      ).toBe(expected);
    });
  });

  it('npm/pnpm/yarn publish is NETWORK', () => {
    forAll(0x4004, RUNS, (rng) => {
      const name = decorateName(rng, pick(rng, ['npm', 'pnpm', 'yarn'] as const));
      const args = ['publish', ...safeTrail(rng)];
      expect(classifyShellInvocation(normalizeInvocation(name, args)), `${name} ${args.join(' ')}`).toBe('NETWORK');
    });
  });
});

// ── Property 5 ─────────────────────────────────────────────────────────────────────────────────

describe('Property 5: installers are PACKAGE_INSTALL and verification commands stay SYSTEM', () => {
  // Feature: kernel-gap-closure, Property 5: Installers are PACKAGE_INSTALL and verification commands stay SYSTEM
  // **Validates: Requirements 5.1, 5.2**

  function installForm(rng: Rng): { name: string; args: string[] } {
    switch (int(rng, 0, 7)) {
      case 0: return { name: pick(rng, ['npm', 'pnpm', 'yarn']), args: [pick(rng, ['install', 'i', 'add', 'ci', 'update', 'upgrade'])] };
      case 1: return { name: pick(rng, ['pip', 'pip3']), args: ['install'] };
      case 2: return { name: pick(rng, ['python', 'python3']), args: ['-m', 'pip', 'install'] };
      case 3: return { name: 'cargo', args: [pick(rng, ['add', 'install'])] };
      case 4: return { name: 'go', args: [pick(rng, ['get', 'install'])] };
      case 5: return { name: 'gem', args: ['install'] };
      case 6: return { name: 'yarn', args: [] };
      default: return { name: pick(rng, ['npm', 'pnpm', 'yarn']), args: ['--prefix', '.', pick(rng, ['install', 'add'])] };
    }
  }

  it('install forms are PACKAGE_INSTALL for any trailing arguments and name decoration', () => {
    forAll(0x5001, RUNS * 2, (rng) => {
      const form = installForm(rng);
      const args = [...form.args, ...(form.args.length === 0 ? [] : safeTrail(rng))];
      const name = decorateName(rng, form.name);
      expect(classifyShellInvocation(normalizeInvocation(name, args)), `${name} ${args.join(' ')}`).toBe('PACKAGE_INSTALL');
    });
  });

  function verificationForm(rng: Rng): { name: string; args: string[] } {
    const script = `s${pathSegment(rng)}`;
    const file = `${pathSegment(rng)}.js`;
    switch (int(rng, 0, 13)) {
      case 0: return { name: 'npm', args: ['test'] };
      case 1: return { name: 'npm', args: ['run', script] };
      case 2: return { name: 'npm', args: ['run', 'build'] };
      case 3: return { name: 'node', args: [file] };
      case 4: return { name: 'node', args: ['--test', `test/${file}`] };
      case 5: return { name: 'npx', args: ['tsx', `${pathSegment(rng)}.ts`] };
      case 6: return { name: 'go', args: ['test', './...'] };
      case 7: return { name: 'cargo', args: ['test'] };
      case 8: return { name: 'dart', args: ['test'] };
      case 9: return { name: 'python', args: ['-m', 'pytest'] };
      case 10: return { name: 'python3', args: [`${pathSegment(rng)}.py`] };
      case 11: return { name: pick(rng, ['tsc', 'eslint', 'vitest', 'jest']), args: [] };
      case 12: return { name: 'git', args: [pick(rng, ['status', 'diff', 'log', 'add', 'commit'])] };
      default: return { name: pick(rng, ['mv', 'move', 'cp', 'ls', 'cat', 'echo', 'node']), args: [pathSegment(rng)] };
    }
  }

  it('verification commands stay SYSTEM for any harmless trailing flags', () => {
    forAll(0x5002, RUNS * 2, (rng) => {
      const form = verificationForm(rng);
      const trail = safeTrail(rng).filter((a) => !(form.name === 'git' && (a === '--force' || a === '-n')));
      const args = [...form.args, ...trail];
      const name = decorateName(rng, form.name);
      expect(classifyShellInvocation(normalizeInvocation(name, args)), `${name} ${args.join(' ')}`).toBe('SYSTEM');
    });
  });
});

// ── examples ───────────────────────────────────────────────────────────────────────────────────

describe('classifyShellInvocation (examples)', () => {
  it('rm -rf .. as one string equals the split form and is DESTRUCTIVE', () => {
    const one = classifyShellInvocation(normalizeInvocation('rm -rf ..'));
    const split = classifyShellInvocation(normalizeInvocation('rm', ['-rf', '..']));
    expect(one).toBe('DESTRUCTIVE');
    expect(split).toBe('DESTRUCTIVE');
  });

  it('C:\\tools\\RM.EXE is DESTRUCTIVE', () => {
    expect(risk('C:\\tools\\RM.EXE', '-rf', 'dist')).toBe('DESTRUCTIVE');
  });

  it('rm with no arguments is DESTRUCTIVE', () => {
    expect(risk('rm')).toBe('DESTRUCTIVE');
  });

  it('git -C sub status is SYSTEM; git -C sub clean -fd is DESTRUCTIVE', () => {
    expect(risk('git', '-C', 'sub', 'status')).toBe('SYSTEM');
    expect(risk('git', '-C', 'sub', 'clean', '-fd')).toBe('DESTRUCTIVE');
  });

  it('git -C clean status is SYSTEM (the -C value is not the subcommand)', () => {
    expect(risk('git', '-C', 'clean', 'status')).toBe('SYSTEM');
  });

  it('find . -name x -delete is DESTRUCTIVE; find . -name x is SYSTEM', () => {
    expect(risk('find', '.', '-name', 'x', '-delete')).toBe('DESTRUCTIVE');
    expect(risk('find', '.', '-name', 'x')).toBe('SYSTEM');
  });

  it('npm --prefix . install is PACKAGE_INSTALL', () => {
    expect(risk('npm', '--prefix', '.', 'install')).toBe('PACKAGE_INSTALL');
  });

  it('git reset --hard and git checkout -- are DESTRUCTIVE; plain forms are SYSTEM', () => {
    expect(risk('git', 'reset', '--hard')).toBe('DESTRUCTIVE');
    expect(risk('git', 'reset', 'HEAD~1')).toBe('SYSTEM');
    expect(risk('git', 'checkout', '--', 'a.ts')).toBe('DESTRUCTIVE');
    expect(risk('git', 'checkout', 'main')).toBe('SYSTEM');
  });

  it('git clone/fetch/pull/push/ls-remote are NETWORK; npm publish is NETWORK', () => {
    for (const sub of ['clone', 'fetch', 'pull', 'push', 'ls-remote']) expect(risk('git', sub)).toBe('NETWORK');
    expect(risk('npm', 'publish')).toBe('NETWORK');
    expect(risk('pnpm', 'publish', '--access', 'public')).toBe('NETWORK');
    expect(risk('yarn', 'publish')).toBe('NETWORK');
  });

  it('curl https://example.com is NETWORK (single-string form too)', () => {
    expect(classifyShellInvocation(normalizeInvocation('curl https://example.com'))).toBe('NETWORK');
  });

  it('regression list stays SYSTEM', () => {
    expect(risk('npm', 'test')).toBe('SYSTEM');
    expect(risk('node', 'test.js')).toBe('SYSTEM');
    expect(risk('node', '--test', 'test/round.test.js')).toBe('SYSTEM');
    expect(risk('npx', 'tsx', 'test.ts')).toBe('SYSTEM');
    expect(risk('go', 'test', './...')).toBe('SYSTEM');
    expect(risk('cargo', 'test')).toBe('SYSTEM');
    expect(risk('dart', 'test')).toBe('SYSTEM');
    expect(risk('python', '-m', 'pytest')).toBe('SYSTEM');
  });

  it('mv and move stay SYSTEM (design D-A); so do cp, ls and echo', () => {
    expect(risk('mv', 'a.ts', 'b.ts')).toBe('SYSTEM');
    expect(risk('move', 'a.ts', 'b.ts')).toBe('SYSTEM');
    expect(risk('cp', 'a.ts', 'b.ts')).toBe('SYSTEM');
    expect(risk('ls', '-la')).toBe('SYSTEM');
    expect(risk('echo', 'hi')).toBe('SYSTEM');
  });

  it('DESTRUCTIVE wins over NETWORK and PACKAGE_INSTALL when several could match', () => {
    // `find ... -exec curl` : the find rule applies by name, the argument is just text.
    expect(risk('find', '.', '-exec', 'curl', '{}', ';')).toBe('DESTRUCTIVE');
  });
});

// ── Property 7 ─────────────────────────────────────────────────────────────────────────────────

describe('Property 7: argument extraction follows the definitions', () => {
  // Feature: kernel-gap-closure, Property 7: Argument extraction follows the definitions
  // **Validates: Requirements 3.4, 3.5**

  // Independent reference implementation of the Glossary definitions.
  const META = /[;|&<>`'"]/;
  const URL_RE = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;
  const ENV_RE = /\$(?:[A-Za-z_]|\{|\()|%[A-Za-z_][A-Za-z0-9_]*%/;

  function refIsFlag(arg: string): boolean {
    return arg.startsWith('-');
  }

  /** The string tested by the Path_Like_Argument definition, or null when the argument is a bare flag. */
  function refValue(arg: string): string | null {
    const eq = arg.indexOf('=');
    if (eq > 0) return arg.slice(eq + 1);
    if (refIsFlag(arg)) return null;
    return arg;
  }

  function refPathLike(value: string): boolean {
    if (value === '' || /\s/.test(value) || META.test(value) || URL_RE.test(value)) return false;
    return (
      /[\\/]/.test(value) ||
      value === '..' ||
      value.startsWith('~') ||
      /^[A-Za-z]:/.test(value) ||
      ENV_RE.test(value)
    );
  }

  function refFileCandidate(arg: string): boolean {
    return !refIsFlag(arg) && arg !== '' && !/\s/.test(arg) && !META.test(arg) && !URL_RE.test(arg);
  }

  function refView(args: readonly string[]): { pathLike: string[]; envExpansions: string[] } {
    const pathLike: string[] = [];
    for (const a of args) {
      const v = refValue(a);
      if (v !== null && refPathLike(v)) pathLike.push(v);
    }
    return { pathLike, envExpansions: pathLike.filter((v) => ENV_RE.test(v)) };
  }

  /** Argument value without `=` and without a leading `-`. */
  function valueArg(rng: Rng): string {
    const base = pathSegment(rng);
    switch (int(rng, 0, 31)) {
      case 0: return base;
      case 1: return '.';
      case 2: return '..';
      case 3: return `../${base}`;
      case 4: return `${base}/${pathSegment(rng)}`;
      case 5: return `${base}\\${pathSegment(rng)}`;
      case 6: return '~';
      case 7: return `~/${base}`;
      case 8: return `/etc/${base}`;
      case 9: return `C:\\${base}`;
      case 10: return `c:${base}`;
      case 11: return `$HOME/${base}`;
      case 12: return `\${${base.toUpperCase()}}`;
      case 13: return '$(pwd)';
      case 14: return `%TEMP%\\${base}`;
      case 15: return `$${base.toUpperCase()}`;
      case 16: return `${base} ${pathSegment(rng)}`;
      case 17: return `${base}\t${base}`;
      case 18: return `${base};${pathSegment(rng)}`;
      case 19: return `${base}|${pathSegment(rng)}`;
      case 20: return `'${base}'`;
      case 21: return `"${base}"`;
      case 22: return `${base}>${pathSegment(rng)}`;
      case 23: return '`id`';
      case 24: return `http://${base}/${pathSegment(rng)}`;
      case 25: return `https://${base}`;
      case 26: return `ftp://${base}/a b`;
      case 27: return `${base}/../${pathSegment(rng)}`;
      case 28: return `${base}/${pathSegment(rng)};${pathSegment(rng)}`;
      case 29: return `https://${base}/../${pathSegment(rng)}`;
      case 30: return `${base}&${pathSegment(rng)}/x`;
      default: return pathOf(rng, pick(rng, ['/', '\\'] as const));
    }
  }

  function anyArg(rng: Rng): string {
    switch (int(rng, 0, 4)) {
      case 0: return pick(rng, ['-rf', '-r', '--force', '--verbose', '-n', '-v']);
      case 1: return `${pick(rng, ['--out', '--prefix', 'of', 'if', 'dir'])}=${valueArg(rng)}`;
      default: return valueArg(rng);
    }
  }

  it('pathLike equals the reference for each single argument', () => {
    forAll(0x7001, RUNS * 3, (rng) => {
      const arg = anyArg(rng);
      const view = extractShellArguments({ name: 'cat', args: [arg] });
      expect(view.pathLike, JSON.stringify(arg)).toEqual(refView([arg]).pathLike);
    });
  });

  it('pathLike and envExpansions follow the reference for a whole argument list (order kept)', () => {
    forAll(0x7002, RUNS, (rng) => {
      const args: string[] = [];
      const n = int(rng, 0, 8);
      for (let i = 0; i < n; i++) args.push(anyArg(rng));
      const view = extractShellArguments({ name: pick(rng, ['cat', 'rm', 'cp', 'node']), args });
      const ref = refView(args);
      expect(view.pathLike, JSON.stringify(args)).toEqual(ref.pathLike);
      expect(view.envExpansions, JSON.stringify(args)).toEqual(ref.envExpansions);
      for (const e of view.envExpansions) expect(view.pathLike).toContain(e);
    });
  });

  it('arguments with whitespace, a shell metacharacter or a scheme:// prefix are never path-like', () => {
    forAll(0x7003, RUNS * 2, (rng) => {
      const base = pathOf(rng, '/');
      const bad = pick(rng, [
        `${base} ${pathSegment(rng)}`,
        `${base}\t${pathSegment(rng)}`,
        `${base};x`,
        `${base}|x`,
        `${base}&x`,
        `${base}>x`,
        `<${base}`,
        `\`${base}\``,
        `'${base}'`,
        `"${base}"`,
        `https://${base}`,
        `http://${base}/../x`,
        `ssh://${pathSegment(rng)}@${pathSegment(rng)}/${base}`,
        `file://${base}`,
        `$HOME/${base} x`,
        `$HOME/${base};x`,
      ]);
      const wrap = bool(rng) ? bad : `${pick(rng, ['--out', 'of', 'dir'])}=${bad}`;
      expect(extractShellArguments({ name: 'cat', args: [wrap] }).pathLike, JSON.stringify(wrap)).toEqual([]);
    });
  });

  it('name=value gives the same verdict as the bare value (and reports the value)', () => {
    forAll(0x7004, RUNS * 2, (rng) => {
      const value = valueArg(rng);
      const name = pick(rng, ['--out', '--prefix', 'of', 'if', 'dir', pathSegment(rng)]);
      const bare = extractShellArguments({ name: 'dd', args: [value] });
      const named = extractShellArguments({ name: 'dd', args: [`${name}=${value}`] });
      expect(named.pathLike, `${name}=${value}`).toEqual(bare.pathLike);
      expect(named.envExpansions, `${name}=${value}`).toEqual(bare.envExpansions);
    });
  });

  it('fileCandidates (arguments without =) equal the reference; flags are excluded', () => {
    forAll(0x7005, RUNS * 3, (rng) => {
      const arg = bool(rng, 0.2) ? pick(rng, ['-rf', '--force', '-n', '-v']) : valueArg(rng);
      const view = extractShellArguments({ name: 'cat', args: [arg] });
      expect(view.fileCandidates, JSON.stringify(arg)).toEqual(refFileCandidate(arg) ? [arg] : []);
      // every path-like non-flag argument is also a file candidate (Glossary)
      if (!arg.startsWith('-')) {
        for (const p of view.pathLike) expect(view.fileCandidates).toContain(p);
      }
    });
  });

  it('examples: rm -rf .. / cat .env / curl URL / echo $HOME', () => {
    expect(extractShellArguments(inv('rm', '-rf', '..'))).toEqual({
      pathLike: ['..'], envExpansions: [], fileCandidates: ['..'],
    });
    expect(extractShellArguments(inv('cat', '.env'))).toEqual({
      pathLike: [], envExpansions: [], fileCandidates: ['.env'],
    });
    expect(extractShellArguments(inv('curl', '-s', 'https://example.com/a/b'))).toEqual({
      pathLike: [], envExpansions: [], fileCandidates: [],
    });
    const echo = extractShellArguments(inv('echo', '$HOME/x', 'plain'));
    expect(echo.pathLike).toEqual(['$HOME/x']);
    expect(echo.envExpansions).toEqual(['$HOME/x']);
    expect(echo.fileCandidates).toEqual(['$HOME/x', 'plain']);
  });

  it('examples: --prefix=../x uses the value; message with spaces is not a candidate', () => {
    expect(extractShellArguments(inv('npm', '--prefix=../x')).pathLike).toEqual(['../x']);
    expect(extractShellArguments(inv('git', 'commit', '-m', 'fix a/b thing')).pathLike).toEqual([]);
    expect(extractShellArguments(inv('git', 'commit', '-m', 'fix a/b thing')).fileCandidates).toEqual(['commit']);
  });

  it('examples: bare names and flags are not path-like', () => {
    const view = extractShellArguments(inv('node', '--test', 'test.js', '.', '-rf'));
    expect(view.pathLike).toEqual([]);
    expect(view.fileCandidates).toEqual(['test.js', '.']);
  });
});

// ── Property 16 (classifier part) ──────────────────────────────────────────────────────────────

describe('Property 16 (classifier part): determinism', () => {
  // Feature: kernel-gap-closure, Property 16: Classification and access functions are deterministic
  // **Validates: Requirements 10.2**

  const NAMES = [...DESTRUCTIVE_NAMES, ...NETWORK_NAMES, 'git', 'npm', 'pnpm', 'yarn', 'pip', 'find', 'chmod', 'chown', 'node', 'echo', 'mv', 'cp'];
  const WORDS = ['status', 'clean', 'reset', '--hard', '--', 'install', 'publish', '-R', '-delete', '-exec', '..', '$HOME/x', 'a b', 'https://h/x', 'n=../y', '-C'];

  function randomInvocation(rng: Rng): { command: string; args: string[] } {
    const args: string[] = [];
    const n = int(rng, 0, 6);
    for (let i = 0; i < n; i++) args.push(bool(rng) ? pick(rng, WORDS) : pathSegment(rng));
    const command = decorateName(rng, pick(rng, NAMES));
    return { command: bool(rng, 0.3) && args.length > 0 && !/\s/.test(args[0] ?? ' ') ? `${command} ${args.shift()}` : command, args };
  }

  it('two calls on the same input are deeply equal and leave the input unchanged', () => {
    forAll(0x1601, RUNS, (rng) => {
      const { command, args } = randomInvocation(rng);
      const argsCopy = [...args];

      const a = normalizeInvocation(command, args);
      const b = normalizeInvocation(command, args);
      expect(b).toEqual(a);
      expect(args).toEqual(argsCopy);

      const snapshot = JSON.stringify(a);
      expect(classifyShellInvocation(a)).toBe(classifyShellInvocation(b));
      expect(extractShellArguments(a)).toEqual(extractShellArguments(b));
      expect(JSON.stringify(a)).toBe(snapshot);
    });
  });

  it('classification does not depend on call history', () => {
    forAll(0x1602, RUNS, (rng) => {
      const first = randomInvocation(rng);
      const second = randomInvocation(rng);
      const expected = classifyShellInvocation(normalizeInvocation(first.command, first.args));
      classifyShellInvocation(normalizeInvocation(second.command, second.args));
      expect(classifyShellInvocation(normalizeInvocation(first.command, first.args))).toBe(expected);
    });
  });
});
