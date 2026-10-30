/*
 * Copyright 2026 DienVu (Dienvu1008)
 * SPDX-License-Identifier: Apache-2.0
 */

// language-inference.ts (P12.24) — PURE, DETERMINISTIC inference of the target language/framework
// for a planning goal, so the Planner stops defaulting to TypeScript. No I/O, no randomness: it
// looks at (1) the EXISTING workspace (manifest files + source extensions — strong evidence) and
// (2) KEYWORDS in the goal text (weaker evidence). Workspace wins over the goal, because editing an
// existing Dart/Rust/Go project in another language would be wrong.
//
// The result is an advisory HINT surfaced into the planning prompt. It never forces a plan — a
// goal can still ask to ADD a different language — but it removes the silent TS bias (the few-shot
// example + the default expert persona) that made "build a Flutter todo app" come out as .ts files.

/** A detected language id. 'unknown' when nothing is recognised (prompt then stays neutral). */
export type LanguageId =
  | 'typescript' | 'javascript' | 'python' | 'dart' | 'rust' | 'go' | 'cpp' | 'c' | 'mql5'
  | 'java' | 'csharp' | 'ruby' | 'php' | 'unknown';

/** Where a hint came from, for provenance + confidence ordering. */
export type LanguageSource = 'workspace_manifest' | 'workspace_files' | 'goal_keyword' | 'none';

export interface LanguageHint {
  readonly language: LanguageId;
  /** Optional framework when strongly implied (e.g. dart → 'flutter'). */
  readonly framework?: string;
  /** How sure we are: manifest > files > keyword > none. */
  readonly confidence: 'high' | 'medium' | 'low' | 'none';
  readonly source: LanguageSource;
  /** Human-readable justification for the planning prompt / audit. */
  readonly rationale: string;
}

/** A manifest filename (exact, lowercased) → language/framework. Highest confidence. */
const MANIFEST_SIGNALS: ReadonlyArray<{ file: string; language: LanguageId; framework?: string }> = [
  { file: 'pubspec.yaml', language: 'dart', framework: 'flutter' },
  { file: 'cargo.toml', language: 'rust' },
  { file: 'go.mod', language: 'go' },
  { file: 'pyproject.toml', language: 'python' },
  { file: 'requirements.txt', language: 'python' },
  { file: 'setup.py', language: 'python' },
  { file: 'pipfile', language: 'python' },
  { file: 'cmakelists.txt', language: 'cpp' },
  { file: 'package.json', language: 'typescript' }, // ts/js — refined by tsconfig below
  { file: 'tsconfig.json', language: 'typescript' },
  { file: 'go.sum', language: 'go' },
  { file: 'gemfile', language: 'ruby' },
  { file: 'composer.json', language: 'php' },
  { file: 'pom.xml', language: 'java' },
  { file: 'build.gradle', language: 'java' },
];

/** Source-file extension (lowercased, incl. dot) → language. Medium confidence. */
const EXTENSION_SIGNALS: Readonly<Record<string, LanguageId>> = {
  '.dart': 'dart', '.rs': 'rust', '.go': 'go', '.py': 'python',
  '.cpp': 'cpp', '.cc': 'cpp', '.cxx': 'cpp', '.hpp': 'cpp', '.h': 'c', '.c': 'c',
  '.mq5': 'mql5', '.mqh': 'mql5',
  '.ts': 'typescript', '.tsx': 'typescript', '.js': 'javascript', '.jsx': 'javascript',
  '.java': 'java', '.cs': 'csharp', '.rb': 'ruby', '.php': 'php',
};

/** Goal-text keyword → language/framework. Lowest confidence (ordered: first match wins). */
const KEYWORD_SIGNALS: ReadonlyArray<{ re: RegExp; language: LanguageId; framework?: string }> = [
  { re: /\bflutter\b/i, language: 'dart', framework: 'flutter' },
  { re: /\bdart\b/i, language: 'dart' },
  { re: /\brust\b|\bcargo\b/i, language: 'rust' },
  { re: /\bgolang\b|\bgo\s+(module|program|app|service)\b/i, language: 'go' },
  { re: /\bpython\b|\bdjango\b|\bflask\b|\bfastapi\b|\bpytest\b/i, language: 'python' },
  { re: /\bmql5\b|\bmetatrader\b|\bmt5\b|\bexpert\s+advisor\b/i, language: 'mql5' },
  { re: /\bc\+\+\b|\bcpp\b/i, language: 'cpp' },
  { re: /\bgo\b/i, language: 'go' }, // bare "go" last — avoids matching "go to"
  { re: /\btypescript\b|\bnode(\.js)?\b|\bnest(js)?\b|\bexpress\b/i, language: 'typescript' },
  { re: /\bjavascript\b|\breact\b|\bvue\b/i, language: 'javascript' },
  { re: /\bjava\b|\bspring\b/i, language: 'java' },
  { re: /\bc#\b|\bcsharp\b|\b\.net\b|\bdotnet\b/i, language: 'csharp' },
  { re: /\bruby\b|\brails\b/i, language: 'ruby' },
  { re: /\bphp\b|\blaravel\b/i, language: 'php' },
];

const LANGUAGE_LABEL: Readonly<Record<LanguageId, string>> = {
  typescript: 'TypeScript', javascript: 'JavaScript', python: 'Python', dart: 'Dart',
  rust: 'Rust', go: 'Go', cpp: 'C++', c: 'C', mql5: 'MQL5', java: 'Java',
  csharp: 'C#', ruby: 'Ruby', php: 'PHP', unknown: 'the appropriate language',
};

/** The conventional project layout to mention in the prompt, per language. */
const LANGUAGE_LAYOUT: Readonly<Partial<Record<LanguageId, string>>> = {
  dart: 'a Dart/Flutter project (pubspec.yaml at the root, source under lib/*.dart, tests under test/)',
  rust: 'a Cargo project (Cargo.toml at the root, source under src/*.rs)',
  go: 'a Go module (go.mod at the root, package files as *.go)',
  python: 'a Python project (modules as *.py, dependencies in requirements.txt or pyproject.toml)',
  cpp: 'a C++ project (source *.cpp/*.hpp, a CMakeLists.txt or Makefile to build)',
  mql5: 'an MQL5 project (*.mq5 for programs/Expert Advisors, *.mqh for includes)',
  typescript: 'a TypeScript project (package.json at the root, source *.ts, a tsconfig.json)',
  javascript: 'a JavaScript project (package.json at the root, source *.js)',
};

const NONE: LanguageHint = {
  language: 'unknown', confidence: 'none', source: 'none',
  rationale: 'No language signal in the goal or workspace.',
};

/** Lowercased basename of a '/'- or '\\'-separated path. */
function basename(path: string): string {
  const parts = path.split(/[\\/]/);
  return (parts[parts.length - 1] ?? '').toLowerCase();
}

/** Lowercased extension (incl. dot) of a path, or '' when none. */
function extname(path: string): string {
  const base = basename(path);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot) : '';
}

/**
 * Infer the target language from the existing workspace first, then the goal text.
 *
 * Precedence:
 *   1. A manifest file in the workspace (pubspec.yaml, Cargo.toml, go.mod, …) → HIGH.
 *      tsconfig.json upgrades a bare package.json from js to ts.
 *   2. The dominant source-file extension in the workspace → MEDIUM.
 *   3. A keyword in the goal text → LOW.
 *   4. Nothing → 'unknown'/none (the prompt stays language-neutral).
 *
 * Pure + deterministic: same inputs → same hint.
 */
export function inferLanguage(goalText: string, workspacePaths: readonly string[]): LanguageHint {
  const bases = new Set(workspacePaths.map(basename));

  // 1. Manifest files (strongest). Scan in declared order so the most specific wins; but let a
  //    tsconfig.json present alongside package.json keep 'typescript' (already the mapping).
  for (const sig of MANIFEST_SIGNALS) {
    if (bases.has(sig.file)) {
      return {
        language: sig.language,
        ...(sig.framework !== undefined ? { framework: sig.framework } : {}),
        confidence: 'high',
        source: 'workspace_manifest',
        rationale: `Workspace contains ${sig.file} → ${LANGUAGE_LABEL[sig.language]}${sig.framework ? ' (' + sig.framework + ')' : ''}.`,
      };
    }
  }

  // 2. Dominant source extension across workspace files (ignore manifests/configs handled above).
  const extCount = new Map<LanguageId, number>();
  for (const p of workspacePaths) {
    const lang = EXTENSION_SIGNALS[extname(p)];
    if (lang !== undefined) extCount.set(lang, (extCount.get(lang) ?? 0) + 1);
  }
  if (extCount.size > 0) {
    // Highest count wins; ties broken by a stable language order for determinism.
    const sorted = [...extCount.entries()].sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]));
    const [lang, count] = sorted[0]!;
    return {
      language: lang,
      confidence: 'medium',
      source: 'workspace_files',
      rationale: `Workspace is dominated by ${LANGUAGE_LABEL[lang]} source files (${count} file${count === 1 ? '' : 's'}).`,
    };
  }

  // 3. Goal keywords (weakest). First match in declared order wins.
  for (const sig of KEYWORD_SIGNALS) {
    if (sig.re.test(goalText)) {
      return {
        language: sig.language,
        ...(sig.framework !== undefined ? { framework: sig.framework } : {}),
        confidence: 'low',
        source: 'goal_keyword',
        rationale: `Goal text mentions ${LANGUAGE_LABEL[sig.language]}${sig.framework ? ' (' + sig.framework + ')' : ''}.`,
      };
    }
  }

  return NONE;
}

/**
 * Render a short, TRUSTED prompt section telling the planner which language/framework to target.
 * Returns '' when there is no usable signal (keeps the prompt language-neutral — no TS default).
 */
export function renderLanguageDirective(hint: LanguageHint): string {
  if (hint.language === 'unknown' || hint.confidence === 'none') return '';
  const label = LANGUAGE_LABEL[hint.language];
  const fw = hint.framework !== undefined ? ` using ${hint.framework}` : '';
  const layout = LANGUAGE_LAYOUT[hint.language];
  const lines = [
    `Target language: ${label}${fw}. (${hint.rationale})`,
    `Decompose and name files for ${label}${fw} — do NOT default to another language such as TypeScript.`,
  ];
  if (layout !== undefined) lines.push(`Follow the conventional layout: ${layout}.`);
  if (hint.confidence === 'low') {
    lines.push('This was inferred from the goal text only; if the goal clearly means a different language, follow the goal.');
  }
  return lines.join('\n');
}
