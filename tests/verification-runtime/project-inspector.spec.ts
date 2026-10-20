// project-inspector (P12.25) — detects multi-language manifests from a real temp workspace.
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { inspectProject } from '@codeforge/infrastructure';

const cleanup: string[] = [];
afterEach(() => { for (const d of cleanup.splice(0)) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ } } });

function ws(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'cf-inspect-'));
  cleanup.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content, 'utf8');
  }
  return dir;
}

describe('inspectProject — multi-language manifest detection (P12.25)', () => {
  it('detects a Flutter project from pubspec.yaml with a flutter dependency', () => {
    const dir = ws({ 'pubspec.yaml': 'name: todo\ndependencies:\n  flutter:\n    sdk: flutter\n' });
    const s = inspectProject(dir);
    expect(s.hasPubspec).toBe(true);
    expect(s.isFlutter).toBe(true);
  });

  it('detects a plain Dart project (pubspec without flutter) as NOT flutter', () => {
    const dir = ws({ 'pubspec.yaml': 'name: cli\ndependencies:\n  args: ^2.0.0\n' });
    const s = inspectProject(dir);
    expect(s.hasPubspec).toBe(true);
    expect(s.isFlutter).toBe(false);
  });

  it('detects Rust (Cargo.toml) and Go (go.mod)', () => {
    expect(inspectProject(ws({ 'Cargo.toml': '[package]\nname = "x"\n' })).hasCargoToml).toBe(true);
    expect(inspectProject(ws({ 'go.mod': 'module x\n' })).hasGoMod).toBe(true);
  });

  it('detects Python and pytest (via a tests/ dir or pyproject [tool.pytest])', () => {
    const viaDir = inspectProject(ws({ 'requirements.txt': 'pytest\n', 'tests/test_x.py': '' }));
    expect(viaDir.hasPython).toBe(true);
    expect(viaDir.hasPytest).toBe(true);

    const viaCfg = inspectProject(ws({ 'pyproject.toml': '[tool.pytest.ini_options]\n' }));
    expect(viaCfg.hasPython).toBe(true);
    expect(viaCfg.hasPytest).toBe(true);
  });

  it('detects C++ (CMakeLists.txt)', () => {
    expect(inspectProject(ws({ 'CMakeLists.txt': 'project(x)\n' })).hasCMake).toBe(true);
  });

  it('an empty workspace detects no language manifests', () => {
    const s = inspectProject(ws({}));
    expect(s.hasPubspec).toBe(false);
    expect(s.hasCargoToml).toBe(false);
    expect(s.hasGoMod).toBe(false);
    expect(s.hasPython).toBe(false);
    expect(s.hasCMake).toBe(false);
  });
});
