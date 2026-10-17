// runtime-launch (P12.23) — pure argv/path helpers for "Start Runtime Here" (no vscode, no spawn).
import { describe, it, expect } from 'vitest';
import {
  resolveRuntimeEntry, buildRuntimeArgv, runtimeUrlForPort, RUNTIME_ENTRY_RELATIVE,
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
});

describe('runtimeUrlForPort', () => {
  it('builds a loopback URL', () => {
    expect(runtimeUrlForPort(9500)).toBe('http://127.0.0.1:9500');
  });
});
