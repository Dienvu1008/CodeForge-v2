/*
 * Copyright 2026 DienVu (Dienvu1008)
 * SPDX-License-Identifier: Apache-2.0
 */

// import-wiring-hint.ts (P12.30) — PURE, DETERMINISTIC cross-file wiring hint for the executor
// prompt. The dominant failure mode of 7-9B local models is writing each file correctly in
// isolation but forgetting to wire imports/requires between them (e.g. a class defined in
// models/todo.dart is used in services/todo_service.dart without an import statement).
//
// This module computes a compact, factual IMPORT_REMINDER section from the workspace files the
// agent has already written in this task run:
//   "In todo_service.dart you use Todo but it is not imported. Check: import './models/todo.dart'"
// It is DETERMINISTIC (same inputs → same hint), PURE (no I/O), and CHEAP (simple regex, no AST).
// It fires only when there are cross-file wiring gaps — returns '' when everything looks wired.
//
// Design:
//   - Only scans changed/written paths (not the whole workspace — too noisy for large repos).
//   - Extracts the set of USED symbol names per file (class names, function calls, identifiers).
//   - Extracts the set of DEFINED symbol names per file.
//   - For each used-but-not-defined-in-same-file name, looks for a definition in another file.
//   - If found: emits one hint line suggesting the import.
//   - Capped at 5 hints, one line each — stays compact.
//
// Language coverage: JS/TS (require/import), Dart (import), Python (import), Rust (use/mod),
//   C++ (#include), MQL5 (#include). Go is intentionally skipped (same-package, no imports needed).
//
// This is NOT a full semantic analyser. It will occasionally produce false positives (a symbol
// correctly imported via a wildcard or re-export). That is acceptable: a spurious "check your
// imports" is far less harmful than a missed import that causes a compile error.

/** A single cross-file wiring hint. */
export interface WiringHint {
  /** The file that has the unresolved reference. */
  readonly file: string;
  /** The symbol name that appears unresolved. */
  readonly symbol: string;
  /** The file that defines the symbol (best candidate). */
  readonly definedIn: string;
  /** A language-appropriate import suggestion. */
  readonly suggestion: string;
}

// ── Language classifiers ──────────────────────────────────────────────────────

type LangKind = 'ts_js' | 'dart' | 'python' | 'rust' | 'cpp' | 'unknown';

function langOf(path: string): LangKind {
  const ext = path.toLowerCase().split('.').pop() ?? '';
  if (ext === 'ts' || ext === 'tsx' || ext === 'js' || ext === 'jsx' || ext === 'mjs') return 'ts_js';
  if (ext === 'dart') return 'dart';
  if (ext === 'py') return 'python';
  if (ext === 'rs') return 'rust';
  if (ext === 'cpp' || ext === 'cc' || ext === 'cxx' || ext === 'hpp' || ext === 'h' || ext === 'mq5' || ext === 'mqh') return 'cpp';
  return 'unknown';
}

// ── Symbol extraction ─────────────────────────────────────────────────────────

/** Extract names that look like top-level definitions (class, function, type, const, fn, def…). */
function extractDefinitions(content: string, lang: LangKind): Set<string> {
  const defs = new Set<string>();
  const patterns: RegExp[] = [];
  if (lang === 'ts_js') {
    patterns.push(
      /(?:^|[\s;{])(class|function|const|let|var|interface|type|enum)\s+([A-Z][A-Za-z0-9_]*)/gm,
      /(?:^|[\s;])exports?\.[A-Za-z0-9_]+\s*=\s*(?:class|function)\s+([A-Z][A-Za-z0-9_]*)/gm,
      /module\.exports\s*=\s*\{([^}]+)\}/gm,
    );
  } else if (lang === 'dart') {
    patterns.push(/(?:class|mixin|extension|enum|typedef)\s+([A-Z][A-Za-z0-9_]*)/gm);
    patterns.push(/^(?:int|double|String|bool|void|List|Map|Future)\s+([a-z][A-Za-z0-9_]*)\s*\(/gm);
  } else if (lang === 'python') {
    patterns.push(/^(?:class|def|async\s+def)\s+([A-Za-z_][A-Za-z0-9_]*)/gm);
  } else if (lang === 'rust') {
    patterns.push(/^(?:pub\s+)?(?:fn|struct|enum|trait|type|const|static|mod)\s+([a-z_A-Z][A-Za-z0-9_]*)/gm);
  } else if (lang === 'cpp') {
    patterns.push(/^(?:class|struct|enum(?:\s+class)?)\s+([A-Z][A-Za-z0-9_]*)/gm);
    patterns.push(/^\s*(?:int|void|bool|float|double|auto)\s+([a-z][A-Za-z0-9_]*)\s*\(/gm);
  }
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    re.lastIndex = 0;
    while ((m = re.exec(content)) !== null) {
      const cap = m[2] ?? m[1];
      if (cap !== undefined && cap.length > 1) defs.add(cap.trim());
    }
  }
  return defs;
}

/** Extract names that appear to be USED but not locally defined (class instantiations, type refs…). */
function extractUses(content: string, lang: LangKind): Set<string> {
  const uses = new Set<string>();
  if (lang === 'ts_js' || lang === 'dart' || lang === 'python' || lang === 'cpp') {
    // Capital-letter names used as type/class/constructor — strong signal
    const re = /\b([A-Z][A-Za-z0-9_]{1,})\b/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) uses.add(m[1]!);
  }
  if (lang === 'rust') {
    // Lowercase function/type names after :: or used directly
    const re = /\b([a-z][A-Za-z0-9_]{2,})\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) uses.add(m[1]!);
  }
  return uses;
}

/** Check whether a file already imports a given symbol name (heuristic — not full parse). */
function alreadyImported(content: string, symbol: string, lang: LangKind, definedInPath?: string): boolean {
  if (lang === 'ts_js') {
    // Check if there's any require/import that mentions the symbol or the file it's defined in
    const importLines = content.split('\n').filter((l) =>
      l.includes('require(') || l.includes('import ')
    );
    return importLines.some((l) =>
      l.includes(symbol) || (definedInPath !== undefined && l.includes(definedInPath.split('/').pop()!.replace(/\.[^.]+$/, '')))
    );
  }
  if (lang === 'dart') {
    // Dart: check if ANY import line references the file that defines the symbol
    const importLines = content.split('\n').filter((l) => l.trim().startsWith('import '));
    if (definedInPath !== undefined) {
      const defBase = definedInPath.split('/').pop()!;
      if (importLines.some((l) => l.includes(defBase))) return true;
    }
    // Also: if the symbol appears on an import line (e.g. show/hide)
    return importLines.some((l) => l.includes(symbol));
  }
  if (lang === 'python') return new RegExp(`(?:from|import)\\s+.*\\b${symbol}\\b`).test(content);
  if (lang === 'rust') return new RegExp(`use\\s+.*\\b${symbol}\\b|mod\\s+${symbol}`).test(content);
  if (lang === 'cpp') {
    const defBase = definedInPath?.split('/').pop() ?? symbol;
    return new RegExp(`#include.*(?:${defBase}|${symbol})`, 'i').test(content);
  }
  return false;
}

/** Build a language-appropriate import suggestion string. */
function importSuggestion(
  usingFile: string, definingFile: string, symbol: string, lang: LangKind,
): string {
  // Make a relative path from usingFile → definingFile (simple — no full path resolution).
  const defBase = definingFile.split('/').pop()!;
  const defNoExt = defBase.replace(/\.[^.]+$/, '');
  if (lang === 'ts_js') {
    const rel = relPath(usingFile, definingFile);
    return `add: const { ${symbol} } = require('${rel}');  or  import { ${symbol} } from '${rel}';`;
  }
  if (lang === 'dart') {
    const rel = relPath(usingFile, definingFile);
    return `add: import '${rel}';  at the top of ${usingFile.split('/').pop()}`;
  }
  if (lang === 'python') {
    const parts = definingFile.replace(/\//g, '.').replace(/\.py$/, '');
    return `add: from ${parts} import ${symbol}`;
  }
  if (lang === 'rust') {
    return `add: use crate::${defNoExt}::${symbol};  or  mod ${defNoExt};`;
  }
  if (lang === 'cpp') {
    return `add: #include "${defBase}"  at the top of ${usingFile.split('/').pop()}`;
  }
  return `import ${symbol} from ${defBase}`;
}

/** Minimal relative path from one workspace-relative path to another (forward slashes). */
function relPath(from: string, to: string): string {
  const fromParts = from.split('/').slice(0, -1); // dir of from
  const toParts = to.split('/');
  let common = 0;
  while (common < fromParts.length && common < toParts.length && fromParts[common] === toParts[common]) common++;
  const up = fromParts.length - common;
  const rel = [...Array(up).fill('..'), ...toParts.slice(common)].join('/');
  return rel.startsWith('.') ? rel : './' + rel;
}

// ── Main export ────────────────────────────────────────────────────────────────

export interface WiringHintOptions {
  /** The workspace files involved in this task run (path → content). */
  readonly workspaceFiles: ReadonlyMap<string, string>;
  /** Paths the agent has written/changed in this task run. Only these are checked. */
  readonly changedPaths: readonly string[];
  /** Maximum hints to emit (default 5 — keep prompt compact). */
  readonly maxHints?: number;
}

/**
 * Compute cross-file wiring hints for the executor prompt. Pure + deterministic.
 * Returns a concise multi-line hint string, or '' when nothing actionable is found.
 * Called once per task run (before the tool-call loop starts).
 */
export function computeWiringHints(opts: WiringHintOptions): string {
  const maxHints = opts.maxHints ?? 5;
  const changed = opts.changedPaths.filter((p) => langOf(p) !== 'unknown');
  if (changed.length === 0) return '';

  // Build a map of symbol → file that defines it, across ALL workspace files (not just changed).
  const defMap = new Map<string, string>(); // symbol → first file that defines it
  for (const [path, content] of opts.workspaceFiles) {
    const lang = langOf(path);
    if (lang === 'unknown') continue;
    for (const sym of extractDefinitions(content, lang)) {
      if (!defMap.has(sym)) defMap.set(sym, path);
    }
  }

  if (defMap.size === 0) return '';

  const hints: WiringHint[] = [];

  for (const changedPath of changed) {
    if (hints.length >= maxHints) break;
    const content = opts.workspaceFiles.get(changedPath);
    if (content === undefined) continue;
    const lang = langOf(changedPath);
    const localDefs = extractDefinitions(content, lang);
    const uses = extractUses(content, lang);

    for (const sym of uses) {
      if (hints.length >= maxHints) break;
      if (localDefs.has(sym)) continue; // defined locally — not a gap
      const definedIn = defMap.get(sym);
      if (definedIn === undefined || definedIn === changedPath) continue;
      if (alreadyImported(content, sym, lang, definedIn)) continue; // already imported
      hints.push({
        file: changedPath,
        symbol: sym,
        definedIn,
        suggestion: importSuggestion(changedPath, definedIn, sym, lang),
      });
    }
  }

  // P12.34: Dart/Flutter package dependency check. If a changed .dart file imports
  // `package:X/...` but `X` is not listed in pubspec.yaml dependencies, the import will fail to
  // resolve (uri_does_not_exist). This catches the common "model uses hive/sqflite/etc. without
  // adding it to pubspec.yaml" failure. Pure + deterministic.
  const pubspec = opts.workspaceFiles.get('pubspec.yaml') ?? opts.workspaceFiles.get('pubspec.yml');
  if (pubspec !== undefined) {
    const declaredDeps = extractPubspecDeps(pubspec);
    if (declaredDeps.size > 0) {
      for (const changedPath of changed) {
        if (hints.length >= maxHints) break;
        if (langOf(changedPath) !== 'dart') continue;
        const content = opts.workspaceFiles.get(changedPath);
        if (content === undefined) continue;
        for (const pkg of extractDartPackageImports(content)) {
          if (hints.length >= maxHints) break;
          if (!declaredDeps.has(pkg)) {
            hints.push({
              file: changedPath,
              symbol: pkg,
              definedIn: 'pubspec.yaml',
              suggestion: `add '${pkg}' under dependencies: in pubspec.yaml and run 'flutter pub get'`,
            });
          }
        }
      }
    }
  }

  if (hints.length === 0) return '';

  const lines = [
    'Cross-file wiring check (deterministic — verify these before declaring done):',
    ...hints.map((h) =>
      `  • ${h.file.split('/').pop()} uses \`${h.symbol}\` but it appears not imported from ${h.definedIn.split('/').pop()}. → ${h.suggestion}`,
    ),
  ];
  return lines.join('\n');
}

/** Extract declared dependency names from a pubspec.yaml content (dependencies + dev_dependencies). */
function extractPubspecDeps(content: string): Set<string> {
  const deps = new Set<string>();
  const sections = content.match(/(?:dependencies|dev_dependencies):\s*\n([\s\S]*?)(?=\n\S|\n$|$)/g);
  if (sections === null) return deps;
  for (const sec of sections) {
    const lines = sec.split('\n').slice(1); // skip the header line
    for (const line of lines) {
      const m = line.match(/^\s+([a-z_][a-z0-9_]*):/i);
      if (m) deps.add(m[1]!.toLowerCase());
    }
  }
  return deps;
}

/** Extract package names from `package:X/...` import directives in Dart source. */
function extractDartPackageImports(content: string): string[] {
  const out: string[] = [];
  for (const line of content.split('\n')) {
    const m = line.match(/import\s+['"]package:([a-z_][a-z0-9_]*)\//i);
    if (m) out.push(m[1]!.toLowerCase());
  }
  return [...new Set(out)];
}
