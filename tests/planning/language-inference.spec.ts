// language-inference (P12.24) — pure, deterministic target-language inference for planning.
import { describe, it, expect } from 'vitest';
import { inferLanguage, renderLanguageDirective } from '@codeforge/agent-core';

describe('inferLanguage — workspace manifest (high confidence)', () => {
  it('detects Flutter/Dart from pubspec.yaml', () => {
    const h = inferLanguage('build a todo app', ['pubspec.yaml', 'lib/main.dart']);
    expect(h.language).toBe('dart');
    expect(h.framework).toBe('flutter');
    expect(h.confidence).toBe('high');
    expect(h.source).toBe('workspace_manifest');
  });

  it('detects Rust from Cargo.toml', () => {
    expect(inferLanguage('x', ['Cargo.toml', 'src/main.rs']).language).toBe('rust');
  });

  it('detects Go from go.mod', () => {
    expect(inferLanguage('x', ['go.mod']).language).toBe('go');
  });

  it('detects Python from pyproject.toml / requirements.txt', () => {
    expect(inferLanguage('x', ['pyproject.toml']).language).toBe('python');
    expect(inferLanguage('x', ['requirements.txt']).language).toBe('python');
  });

  it('treats package.json as typescript (ts/js ecosystem)', () => {
    expect(inferLanguage('x', ['package.json']).language).toBe('typescript');
  });

  it('is path-separator and case insensitive for manifest names', () => {
    expect(inferLanguage('x', ['app\\PubSpec.yaml']).language).toBe('dart');
  });
});

describe('inferLanguage — dominant extension (medium confidence)', () => {
  it('picks the most common source extension', () => {
    const h = inferLanguage('x', ['a.dart', 'b.dart', 'c.ts']);
    expect(h.language).toBe('dart');
    expect(h.confidence).toBe('medium');
    expect(h.source).toBe('workspace_files');
  });

  it('breaks ties deterministically by language id', () => {
    // one .go and one .rs → tie (1 each) → 'go' sorts before 'rust'
    const h = inferLanguage('x', ['main.go', 'main.rs']);
    expect(h.language).toBe('go');
  });
});

describe('inferLanguage — goal keyword (low confidence)', () => {
  it('detects Flutter from the goal when the workspace is empty', () => {
    const h = inferLanguage('Tạo một ứng dụng todo với flutter/dart', []);
    expect(h.language).toBe('dart');
    expect(h.framework).toBe('flutter');
    expect(h.confidence).toBe('low');
    expect(h.source).toBe('goal_keyword');
  });

  it('detects python / rust / mql5 from keywords', () => {
    expect(inferLanguage('write a python script', []).language).toBe('python');
    expect(inferLanguage('a rust CLI tool', []).language).toBe('rust');
    expect(inferLanguage('an MQL5 expert advisor', []).language).toBe('mql5');
  });

  it('workspace evidence beats a conflicting goal keyword', () => {
    // Goal says python, but the workspace is a Dart project → workspace wins.
    const h = inferLanguage('rewrite this in python', ['pubspec.yaml']);
    expect(h.language).toBe('dart');
    expect(h.source).toBe('workspace_manifest');
  });
});

describe('inferLanguage — no signal', () => {
  it('returns unknown/none when nothing matches', () => {
    const h = inferLanguage('make it better', []);
    expect(h.language).toBe('unknown');
    expect(h.confidence).toBe('none');
  });
});

describe('renderLanguageDirective', () => {
  it('renders a Dart/Flutter directive with the layout', () => {
    const txt = renderLanguageDirective(inferLanguage('x', ['pubspec.yaml']));
    expect(txt).toContain('Dart');
    expect(txt).toContain('flutter');
    expect(txt).toContain('lib/');
    expect(txt).toContain('do NOT default to another language');
  });

  it('returns empty string when there is no usable signal (keeps prompt neutral)', () => {
    expect(renderLanguageDirective(inferLanguage('make it better', []))).toBe('');
  });

  it('adds a caveat for low-confidence (goal-only) hints', () => {
    const txt = renderLanguageDirective(inferLanguage('a python script', []));
    expect(txt).toContain('inferred from the goal text only');
  });
});
