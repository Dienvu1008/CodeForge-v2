// runtime-launch (P12.23) — pure argv/path helpers for "Start Runtime Here" (no vscode, no spawn).
import { describe, it, expect } from 'vitest';
import {
  resolveRuntimeEntry, buildRuntimeArgv, runtimeUrlForPort, resolveNodeCommand, RUNTIME_ENTRY_RELATIVE,
} from '../../packages/vscode-extension/src/runtime-launch.js';

describe('resolveRuntimeEntry', () => {
  it('prefers an explicit configured path', () => {
    expect(resolveRuntimeEntry({ configuredPath: '/opt/cf/runtime-cli.js', repoRoot: '/repo' }))
      .toBe('/opt/cf/runtime-cli.js');
  });

  it('derives the entry from the repo root when no override is set', () => {
    expect(resolveRuntimeEntry({ repoRoot: '/repo' })).toBe(`/repo/${RUNTIME_ENTRY_RELATIVE}`);
  });

  it('trims a trailing slash on the repo root', () => {
    expect(resolveRuntimeEntry({ repoRoot: '/repo/' })).toBe(`/repo/${RUNTIME_ENTRY_RELATIVE}`);
  });

  it('returns null when neither a configured path nor a repo root is available', () => {
    expect(resolveRuntimeEntry({})).toBeNull();
    expect(resolveRuntimeEntry({ configuredPath: '  ', repoRoot: '' })).toBeNull();
  });
});

describe('buildRuntimeArgv', () => {
  it('builds workspace/model/port flags as discrete argv (never shell-interpolated)', () => {
    const argv = buildRuntimeArgv({
      entryPath: '/repo/cli.js', workspace: '/my ws', model: 'qwen2.5-coder:latest', port: 9500,
    });
    expect(argv).toEqual([
      '/repo/cli.js', '--workspace', '/my ws', '--model', 'qwen2.5-coder:latest', '--port', '9500',
    ]);
  });

  it('never passes --goal (the runtime starts idle and waits for POST /goal)', () => {
    const argv = buildRuntimeArgv({ entryPath: 'c', workspace: 'w', model: 'm', port: 1 });
    expect(argv).not.toContain('--goal');
  });

  it('appends endpoint and autonomy only when provided', () => {
    const argv = buildRuntimeArgv({
      entryPath: 'c', workspace: 'w', model: 'm', port: 1,
      endpoint: 'http://localhost:11434', autonomy: 'edits',
    });
    expect(argv).toContain('--endpoint');
    expect(argv).toContain('http://localhost:11434');
    expect(argv).toContain('--autonomy');
    expect(argv).toContain('edits');
  });

  it('P12.35: passes --provider and --api-key for cloud providers', () => {
    const argv = buildRuntimeArgv({
      entryPath: 'c', workspace: 'w', model: 'llama-3.3-70b-versatile', port: 1,
      provider: 'openai-compatible',
      endpoint: 'https://api.groq.com/openai/v1',
      apiKey: 'gsk_test',
    });
    expect(argv).toContain('--provider');
    expect(argv).toContain('openai-compatible');
    expect(argv).toContain('--api-key');
    expect(argv).toContain('gsk_test');
  });

  it('P12.35: does NOT pass --provider for ollama (default, no noise)', () => {
    const argv = buildRuntimeArgv({
      entryPath: 'c', workspace: 'w', model: 'qwen2.5-coder:latest', port: 1,
      provider: 'ollama',
    });
    expect(argv).not.toContain('--provider');
    expect(argv).not.toContain('--api-key');
  });

  it('P12.35: passes --provider gemini with api-key', () => {
    const argv = buildRuntimeArgv({
      entryPath: 'c', workspace: 'w', model: 'gemini-2.0-flash-exp', port: 1,
      provider: 'gemini', apiKey: 'AIza_test',
    });
    expect(argv).toContain('gemini');
    expect(argv).toContain('AIza_test');
  });

  // Goal clarification gate — Requirement 1.6.
  const count = (argv: string[], flag: string): number => argv.filter((a) => a === flag).length;

  it('clarify: true appends --mission on --clarify on with exactly one --mission', () => {
    const argv = buildRuntimeArgv({ entryPath: 'c', workspace: 'w', model: 'm', port: 1, clarify: true });
    expect(argv.slice(-4)).toEqual(['--mission', 'on', '--clarify', 'on']);
    expect(count(argv, '--mission')).toBe(1);
    expect(count(argv, '--clarify')).toBe(1);
  });

  it('clarify: false or omitted adds neither --clarify nor --mission', () => {
    for (const clarify of [false, undefined]) {
      const argv = buildRuntimeArgv({ entryPath: 'c', workspace: 'w', model: 'm', port: 1, clarify });
      expect(argv).not.toContain('--clarify');
      expect(argv).not.toContain('--mission');
    }
  });

  it('clarify: true never duplicates --mission (alongside all other options)', () => {
    // RuntimeLaunchSpec cannot express a pre-existing --mission, so assert the count stays 1.
    const argv = buildRuntimeArgv({
      entryPath: 'c', workspace: 'w', model: 'm', port: 1,
      endpoint: 'http://e', autonomy: 'full', provider: 'gemini', apiKey: 'k', clarify: true,
    });
    expect(count(argv, '--mission')).toBe(1);
    expect(count(argv, '--clarify')).toBe(1);
  });
});

describe('runtimeUrlForPort', () => {
  it('builds a loopback URL', () => {
    expect(runtimeUrlForPort(9500)).toBe('http://127.0.0.1:9500');
  });
});

describe('resolveNodeCommand', () => {
  it('prefers an explicit configured node path', () => {
    expect(resolveNodeCommand('/usr/bin/node')).toBe('/usr/bin/node');
  });
  it('falls back to the bare "node" command (resolved from PATH)', () => {
    expect(resolveNodeCommand()).toBe('node');
    expect(resolveNodeCommand('')).toBe('node');
    expect(resolveNodeCommand('   ')).toBe('node');
  });
});
