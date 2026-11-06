/*
 * Copyright 2026 DienVu (Dienvu1008)
 * SPDX-License-Identifier: Apache-2.0
 */

// kernel-gap-closure — Shell_Classifier (TG-011, TG-012, SE-011). Design C2.
//
// Pure functions: no I/O, no clock, no random source, no environment access (Requirement 10.1).
// They map a `run_command` invocation (command + args) to a risk class and extract the arguments
// the executor must boundary-check. These are HEURISTICS over argv, not an OS sandbox: interpreters
// (`node -e`, `python -c`, `npm run <script>`) open paths internally and are invisible here.

/** A normalised `run_command` call. `args` never includes the command name. */
export interface ShellInvocation {
  readonly name: string;
  readonly args: readonly string[];
}

export type ShellRisk = 'SYSTEM' | 'DESTRUCTIVE' | 'NETWORK' | 'PACKAGE_INSTALL';

/** Commands that are DESTRUCTIVE by name (`mkfs.<fs>` is handled by prefix). */
export const DESTRUCTIVE_COMMANDS: ReadonlySet<string> = new Set([
  'rm', 'rmdir', 'del', 'erase', 'rd', 'remove-item', 'shred', 'dd', 'format', 'mkfs',
]);

/** Commands that are NETWORK by name. */
export const NETWORK_COMMANDS: ReadonlySet<string> = new Set([
  'curl', 'wget', 'ssh', 'scp', 'sftp', 'nc', 'ncat', 'netcat', 'telnet', 'ftp',
  'invoke-webrequest', 'iwr', 'invoke-restmethod', 'irm',
]);

/** Commands whose file arguments are written/removed: the Protected_Path rule applies to them. */
export const MUTATING_PATH_COMMANDS: ReadonlySet<string> = new Set([
  'rm', 'rmdir', 'del', 'erase', 'rd', 'mv', 'move', 'cp', 'copy', 'shred', 'dd',
  'tee', 'touch', 'mkdir', 'chmod', 'chown',
]);

/** Commands that only print their arguments: an unresolved `$VAR` there is harmless. */
export const ENV_EXPANSION_EXEMPT_COMMANDS: ReadonlySet<string> = new Set(['echo', 'printf']);

const EXECUTABLE_EXTENSION = /\.(?:exe|cmd|bat|ps1)$/;

/** Directory prefix removed, lower-cased, `.exe|.cmd|.bat|.ps1` removed. */
function toCommandName(token: string): string {
  const base = token.slice(Math.max(token.lastIndexOf('/'), token.lastIndexOf('\\')) + 1);
  return base.toLowerCase().replace(EXECUTABLE_EXTENSION, '');
}

/**
 * Normalise a `run_command` call. A `command` that contains whitespace is split into a leading
 * token plus extra tokens, which are prepended to `args` (classification only; the allowlist check
 * still rejects such a command).
 */
export function normalizeInvocation(command: string, args?: readonly string[]): ShellInvocation {
  const tokens = String(command ?? '').trim().split(/\s+/).filter((t) => t !== '');
  const extra = tokens.slice(1);
  const given = Array.isArray(args) ? args.filter((a): a is string => typeof a === 'string') : [];
  return { name: toCommandName(tokens[0] ?? ''), args: [...extra, ...given] };
}

// ── classification ──────────────────────────────────────────────────────────────────────────────

const GIT_VALUE_OPTIONS: ReadonlySet<string> = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace']);
const GIT_DESTRUCTIVE_SUBCOMMANDS: ReadonlySet<string> = new Set(['rm', 'clean', 'restore']);
const GIT_NETWORK_SUBCOMMANDS: ReadonlySet<string> = new Set(['clone', 'fetch', 'pull', 'push', 'ls-remote']);

const NODE_PACKAGE_MANAGERS: ReadonlySet<string> = new Set(['npm', 'pnpm', 'yarn']);
const NODE_INSTALL_WORDS: ReadonlySet<string> = new Set(['install', 'i', 'add', 'ci', 'update', 'upgrade']);
/** First subcommands that run code, never install or publish (`npm run add` is not an install). */
const NODE_RUN_WORDS: ReadonlySet<string> = new Set(['run', 'run-script', 'test', 't', 'exec', 'x']);

function isRecursiveFlag(arg: string): boolean {
  return arg === '-R' || arg === '-r' || arg === '--recursive' || /^-[A-Za-z]*[Rr][A-Za-z]*$/.test(arg);
}

/** Splits git args into `{ sub, rest }`, skipping global options (and the value of those that take one). */
function gitSubcommand(args: readonly string[]): { sub: string; rest: readonly string[] } | null {
  for (let i = 0; i < args.length; i++) {
    const t = args[i] as string;
    if (GIT_VALUE_OPTIONS.has(t)) { i++; continue; }
    if (t.startsWith('-')) continue;
    return { sub: t, rest: args.slice(i + 1) };
  }
  return null;
}

/** Non-flag arguments before a `--` separator. */
function wordsBeforeDoubleDash(args: readonly string[]): string[] {
  const out: string[] = [];
  for (const a of args) {
    if (a === '--') break;
    if (!a.startsWith('-')) out.push(a);
  }
  return out;
}

/** First non-flag argument, ignoring `+toolchain` selectors. */
function firstWord(args: readonly string[]): string | undefined {
  return args.find((a) => !a.startsWith('-') && !a.startsWith('+'));
}

function classifyDestructive(inv: ShellInvocation): boolean {
  const { name, args } = inv;
  if (DESTRUCTIVE_COMMANDS.has(name) || name.startsWith('mkfs.')) return true;
  if (name === 'chmod' || name === 'chown') return args.some(isRecursiveFlag);
  if (name === 'find') {
    return args.some((a) => a === '-delete' || a === '-exec' || a === '-execdir' || a === '-ok' || a === '-okdir');
  }
  if (name === 'git') {
    const g = gitSubcommand(args);
    if (g === null) return false;
    if (GIT_DESTRUCTIVE_SUBCOMMANDS.has(g.sub)) return true;
    if (g.sub === 'reset') return g.rest.includes('--hard');
    if (g.sub === 'checkout') return g.rest.includes('--');
  }
  return false;
}

function classifyNetwork(inv: ShellInvocation): boolean {
  const { name, args } = inv;
  if (NETWORK_COMMANDS.has(name)) return true;
  if (name === 'git') {
    const g = gitSubcommand(args);
    return g !== null && GIT_NETWORK_SUBCOMMANDS.has(g.sub);
  }
  if (NODE_PACKAGE_MANAGERS.has(name)) {
    const words = wordsBeforeDoubleDash(args);
    return !NODE_RUN_WORDS.has(words[0] ?? '') && words.includes('publish');
  }
  return false;
}

function classifyPackageInstall(inv: ShellInvocation): boolean {
  const { name, args } = inv;
  if (NODE_PACKAGE_MANAGERS.has(name)) {
    const words = wordsBeforeDoubleDash(args);
    if (NODE_RUN_WORDS.has(words[0] ?? '')) return false;
    if (name === 'yarn' && words.length === 0) return true;
    return words.some((w) => NODE_INSTALL_WORDS.has(w));
  }
  if (name === 'pip' || name === 'pip3') return wordsBeforeDoubleDash(args).includes('install');
  if (name === 'python' || name === 'python3') {
    const m = args.indexOf('-m');
    return m >= 0 && args[m + 1] === 'pip' && args.slice(m + 2).some((a) => a === 'install');
  }
  if (name === 'cargo') {
    const w = firstWord(args);
    return w === 'add' || w === 'install';
  }
  if (name === 'go') {
    const w = firstWord(args);
    return w === 'get' || w === 'install';
  }
  if (name === 'gem') return firstWord(args) === 'install';
  return false;
}

/** Priority when several classes match: DESTRUCTIVE, NETWORK, PACKAGE_INSTALL, SYSTEM. */
export function classifyShellInvocation(inv: ShellInvocation): ShellRisk {
  if (classifyDestructive(inv)) return 'DESTRUCTIVE';
  if (classifyNetwork(inv)) return 'NETWORK';
  if (classifyPackageInstall(inv)) return 'PACKAGE_INSTALL';
  return 'SYSTEM';
}

// ── argument extraction ─────────────────────────────────────────────────────────────────────────

export interface ShellArgumentView {
  /** Path_Like_Arguments (the value after the first `=` for `name=value`): boundary-checked. */
  readonly pathLike: readonly string[];
  /** Subset of `pathLike` that contains an environment expansion (`$NAME`, `${`, `$(`, `%NAME%`). */
  readonly envExpansions: readonly string[];
  /** File_Candidate_Arguments: access-checked (sensitive, protected, test baseline). */
  readonly fileCandidates: readonly string[];
}

const SHELL_META = /[;|&<>`'"]/;
const URL_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;
const ENV_EXPANSION = /\$(?:[A-Za-z_]|\{|\()|%[A-Za-z_][A-Za-z0-9_]*%/;

/** No whitespace, no shell metacharacter, not a URL, not empty. */
function isPlainToken(value: string): boolean {
  return value !== '' && !/\s/.test(value) && !SHELL_META.test(value) && !URL_SCHEME.test(value);
}

function isPathLike(value: string): boolean {
  if (!isPlainToken(value)) return false;
  return (
    value.includes('/') ||
    value.includes('\\') ||
    value === '..' ||
    value.startsWith('~') ||
    /^[A-Za-z]:/.test(value) ||
    ENV_EXPANSION.test(value)
  );
}

export function extractShellArguments(inv: ShellInvocation): ShellArgumentView {
  const pathLike: string[] = [];
  const envExpansions: string[] = [];
  const fileCandidates: string[] = [];

  for (const arg of inv.args) {
    const eq = arg.indexOf('=');
    let value: string | null;
    if (eq > 0) value = arg.slice(eq + 1);
    else value = arg.startsWith('-') ? null : arg;
    if (value === null) continue;

    if (isPathLike(value)) {
      pathLike.push(value);
      if (ENV_EXPANSION.test(value)) envExpansions.push(value);
    }
    if (isPlainToken(value)) fileCandidates.push(value);
  }

  return { pathLike, envExpansions, fileCandidates };
}
