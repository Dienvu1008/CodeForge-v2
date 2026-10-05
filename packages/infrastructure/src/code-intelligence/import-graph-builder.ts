// ImportGraphBuilder — P6-IG1. Build an import dependency graph via Tree-sitter.
//
// Parses import/export/require statements per file and resolves RELATIVE specifiers
// (./ and ../) to canonical project-relative paths, producing a directed graph:
//   edges:        file -> set of files it imports
//   reverseEdges: file -> set of files that import it   (used by AffectedSetComputer)
//
// Scope (roadmap §4.3, §7):
//   - Relative specifiers only. Bare/package specifiers (e.g. 'react', 'node:fs')
//     and absolute specifiers are recorded as unresolved and excluded from edges.
//   - TypeScript / JavaScript supported now. Other languages plug in via LANGUAGE_PACKS
//     (see "Adding a language" below) once a compatible grammar is available.
//
// Adding a language:
//   Add one entry to LANGUAGE_PACKS with:
//     - importQuery:  a Tree-sitter query whose @path capture is the specifier node
//                     (its .text is the raw specifier string, quotes already stripped
//                      when the grammar exposes a string_fragment child).
//     - extensions:   candidate file extensions tried during resolution.
//     - indexFiles:   candidate index basenames tried when a specifier points to a dir.
//   No changes to the graph algorithm, resolver, or downstream consumers are needed.
//   Languages whose grammar fails to load degrade gracefully (that file yields no edges).
import type { TreeSitterAdapter, SyntaxMatch, SyntaxNode } from './tree-sitter-adapter.js';

// ── Public types ──────────────────────────────────────────────────────────────

export interface ImportEdge {
  /** Importing file, canonical project-relative ('/'-separated). */
  readonly from: string;
  /** Raw specifier as written in source (e.g. './foo', '../bar/baz', 'react'). */
  readonly specifier: string;
  /** Resolved target file (canonical project-relative), or null if unresolved. */
  readonly to: string | null;
}

export interface ImportGraph {
  /** file -> set of files it imports (resolved relative specifiers only). */
  readonly edges: ReadonlyMap<string, ReadonlySet<string>>;
  /** file -> set of files that import it (reverse of `edges`). */
  readonly reverseEdges: ReadonlyMap<string, ReadonlySet<string>>;
  /** All edges including unresolved ones (for diagnostics). */
  readonly allEdges: readonly ImportEdge[];
  /**
   * Resolve a specifier written in `fromFile` to a canonical project-relative path.
   * Returns null for bare/package/absolute specifiers or when no candidate matches
   * the known file set.
   */
  resolve(fromFile: string, specifier: string): string | null;
}

// ── Language packs ──────────────────────────────────────────────────────────────

interface LanguagePack {
  readonly importQuery: string;
  readonly extensions:  readonly string[];
  readonly indexFiles:  readonly string[];
}

// TypeScript / JavaScript share AST shape for imports (string_fragment holds the path).
// Captures the specifier node (@path) for: import/export-from, require(), dynamic import().
const TS_JS_IMPORT_QUERY = [
  // import ... from '...'   and   export ... from '...'   and   export * from '...'
  '(import_statement source: (string (string_fragment) @path))',
  '(export_statement source: (string (string_fragment) @path))',
  // require('...')  — callee identifier named "require"
  '(call_expression function: (identifier) @_req arguments: (arguments (string (string_fragment) @path)) (#eq? @_req "require"))',
  // dynamic import('...')  — callee is the `import` keyword
  '(call_expression function: (import) arguments: (arguments (string (string_fragment) @path)))',
].join('\n');

const TS_EXTENSIONS = ['.ts', '.tsx', '.d.ts', '.js', '.jsx', '.mjs', '.cjs'];
const TS_INDEX = ['index.ts', 'index.tsx', 'index.js', 'index.jsx', 'index.mjs', 'index.cjs'];

const LANGUAGE_PACKS: Readonly<Record<string, LanguagePack>> = {
  typescript: { importQuery: TS_JS_IMPORT_QUERY, extensions: TS_EXTENSIONS, indexFiles: TS_INDEX },
  tsx:        { importQuery: TS_JS_IMPORT_QUERY, extensions: TS_EXTENSIONS, indexFiles: TS_INDEX },
  javascript: { importQuery: TS_JS_IMPORT_QUERY, extensions: TS_EXTENSIONS, indexFiles: TS_INDEX },
  // Dart intentionally omitted until a grammar compatible with the pinned
  // web-tree-sitter runtime is available (grammar is language version 15; runtime
  // supports 13–14). Files in an unsupported language yield no edges (graceful skip).
};

/** Infer a language id from a file extension. Returns null if unknown. */
function languageForFile(path: string): string | null {
  const lower = path.toLowerCase();
  if (lower.endsWith('.tsx')) return 'tsx';
  if (lower.endsWith('.ts'))  return 'typescript';
  if (lower.endsWith('.mts')) return 'typescript';
  if (lower.endsWith('.cts')) return 'typescript';
  if (lower.endsWith('.jsx')) return 'javascript';
  if (lower.endsWith('.js'))  return 'javascript';
  if (lower.endsWith('.mjs')) return 'javascript';
  if (lower.endsWith('.cjs')) return 'javascript';
  return null;
}

// ── ImportGraphBuilder ───────────────────────────────────────────────────────────

export interface BuildInput {
  /** Canonical project-relative path ('/'-separated) -> source content. */
  readonly files: ReadonlyMap<string, string>;
}

export class ImportGraphBuilder {
  constructor(private readonly adapter: TreeSitterAdapter) {}

  /**
   * Build an import graph from a map of (canonical relpath -> content).
   * Only files whose language has a pack AND whose grammar loads contribute edges;
   * any file that fails to parse is skipped (its node still appears with no edges).
   */
  async build(input: BuildInput): Promise<ImportGraph> {
    const knownFiles = new Set(input.files.keys());
    const allEdges: ImportEdge[] = [];
    const edges = new Map<string, Set<string>>();
    const reverseEdges = new Map<string, Set<string>>();

    // Ensure every known file appears as a node even with no outgoing edges.
    for (const file of knownFiles) {
      if (!edges.has(file)) edges.set(file, new Set());
    }

    for (const [file, content] of input.files) {
      const language = languageForFile(file);
      if (language === null) continue;
      const pack = LANGUAGE_PACKS[language];
      if (pack === undefined) continue; // language known but not yet supported

      let matches: SyntaxMatch[];
      try {
        matches = await this.adapter.queryText(content, language, pack.importQuery);
      } catch {
        // Grammar failed to load / parse — graceful skip for this file.
        continue;
      }

      for (const specifier of collectSpecifiers(matches)) {
        const to = resolveSpecifier(file, specifier, knownFiles, pack);
        allEdges.push({ from: file, specifier, to });
        if (to !== null) {
          addEdge(edges, file, to);
          addEdge(reverseEdges, to, file);
        }
      }
    }

    return {
      edges,
      reverseEdges,
      allEdges,
      resolve(fromFile: string, specifier: string): string | null {
        const language = languageForFile(fromFile);
        const pack = language === null ? undefined : LANGUAGE_PACKS[language];
        if (pack === undefined) return null;
        return resolveSpecifier(fromFile, specifier, knownFiles, pack);
      },
    };
  }
}

// ── helpers ────────────────────────────────────────────────────────────────────

function collectSpecifiers(matches: readonly SyntaxMatch[]): string[] {
  const specs: string[] = [];
  for (const match of matches) {
    for (const cap of match.captures) {
      if (cap.name === 'path') specs.push(unquote(cap.node));
    }
  }
  return specs;
}

/** string_fragment text has no quotes; a raw string node would — strip defensively. */
function unquote(node: SyntaxNode): string {
  const t = node.text;
  if (t.length >= 2 && (t[0] === '"' || t[0] === "'" || t[0] === '`')) {
    return t.slice(1, -1);
  }
  return t;
}

function addEdge(map: Map<string, Set<string>>, key: string, value: string): void {
  let set = map.get(key);
  if (set === undefined) {
    set = new Set();
    map.set(key, set);
  }
  set.add(value);
}

/**
 * Resolve a relative specifier to a canonical project-relative path that exists in
 * `knownFiles`. Returns null for bare/package/absolute specifiers or no match.
 */
function resolveSpecifier(
  fromFile: string,
  specifier: string,
  knownFiles: ReadonlySet<string>,
  pack: LanguagePack,
): string | null {
  // Only relative specifiers are in scope.
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) return null;

  const baseDir = dirname(fromFile);
  const joined = normalizeRelative(`${baseDir}/${specifier}`);
  if (joined === null) return null; // escaped above project root

  // 1. Exact path as written (specifier already had an extension).
  if (knownFiles.has(joined)) return joined;

  // 2. Append candidate extensions.
  for (const ext of pack.extensions) {
    const cand = joined + ext;
    if (knownFiles.has(cand)) return cand;
  }

  // 3. Directory import -> index file.
  for (const idx of pack.indexFiles) {
    const cand = `${joined}/${idx}`;
    if (knownFiles.has(cand)) return cand;
  }

  return null;
}

/** POSIX-style dirname on a '/'-separated path. */
function dirname(path: string): string {
  const i = path.lastIndexOf('/');
  return i <= 0 ? '' : path.slice(0, i);
}

/**
 * Collapse '.' and '..' on a '/'-separated path. Returns null if it rises above
 * the project root (which would be an out-of-tree import).
 */
function normalizeRelative(path: string): string | null {
  const out: string[] = [];
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length === 0) return null;
      out.pop();
      continue;
    }
    out.push(seg);
  }
  return out.join('/');
}
