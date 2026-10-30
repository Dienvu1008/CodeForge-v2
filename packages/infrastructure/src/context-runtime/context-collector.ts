/*
 * Copyright 2026 DienVu (Dienvu1008)
 * SPDX-License-Identifier: Apache-2.0
 */

// ContextCollector (P10.3) — the "last mile" that turns a real workspace on disk into
// the plain-data context signals the (pure) agent-core Retriever/ContextBuilder consume:
//   workspaceFiles, symbols (RetrievedSymbol[]), importReverseEdges, changedPaths.
//
// agent-core stays pure and infra-free: the Retriever already knows how to rank files by
// import distance, inject symbol definitions, and mark everything untrusted (CX-003/005).
// It just needs the raw signals. This collector produces them from the filesystem using
// the Phase-6 code-intelligence tools (SymbolExtractor + ImportGraphBuilder over a
// cross-platform tree-sitter WASM adapter), degrading gracefully when parsing is
// unavailable (then files are still provided; symbols/graph are simply empty).
//
// Bounded by design: a workspace can be huge, but the model context is small. We read a
// capped set of small text source files, skipping build output, VCS, deps, and binaries.
// The TokenBudgeter (CX-004) does the final trimming downstream; these caps just keep the
// collection cheap and avoid loading the DB / node_modules into memory.
import { readdir, readFile, stat } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { join, relative, sep, extname } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { RetrievedSymbol, ContextPlan } from '@codeforge/agent-core';
import { TreeSitterAdapter } from '../code-intelligence/tree-sitter-adapter.js';
import { SymbolExtractor } from '../code-intelligence/symbol-extractor.js';
import { ImportGraphBuilder } from '../code-intelligence/import-graph-builder.js';
import type { LspPool } from '../code-intelligence/lsp-adapter.js';

// ── Collected signals (plain data for agent-core) ────────────────────────────

export interface CollectedContext {
  /** Canonical project-relative ('/'-separated) path -> source content. */
  readonly workspaceFiles: ReadonlyMap<string, string>;
  /** Symbols across the collected files, each tagged with its file. */
  readonly symbols: readonly RetrievedSymbol[];
  /** Import graph reverse edges: file -> files that import it. */
  readonly importReverseEdges: ReadonlyMap<string, ReadonlySet<string>>;
  /** Paths considered "changed/affected" for ranking. Empty when unknown. */
  readonly changedPaths: readonly string[];
}

export interface ContextCollectorOptions {
  readonly workspaceRoot: string;
  /** Directory names skipped entirely (never descended into). */
  readonly skipDirs?: readonly string[];
  /** Max number of files to read. Default 200. */
  readonly maxFiles?: number;
  /** Max bytes per file. Larger files are skipped. Default 64 KiB. */
  readonly maxFileBytes?: number;
  /** Max total bytes across all files. Default 2 MiB. */
  readonly maxTotalBytes?: number;
  /**
   * P12.17 (opt-in): an LspPool for symbol-level cross-file precision. When provided, collect()
   * augments the import-graph reverse edges with LSP `references`: for each CHANGED TS/JS file,
   * the files that actually reference its top-level symbols become reverse-edge neighbours, so the
   * Retriever pulls the real call-sites of a changed symbol — including through package/alias
   * imports the relative-only import graph misses. Absent ⇒ behavior is byte-identical to before
   * (tree-sitter only). Any LSP failure degrades silently to the tree-sitter edges.
   */
  readonly lspPool?: LspPool;
  /** Cap on changed files probed via LSP per collect() (keeps it bounded). Default 20. */
  readonly lspMaxChangedFiles?: number;
  /** Cap on symbols probed per file via LSP references. Default 40. */
  readonly lspMaxSymbolsPerFile?: number;
}

const DEFAULT_SKIP_DIRS = new Set([
  'node_modules', '.git', '.codeforge', 'dist', 'build', 'out', 'coverage',
  '.next', '.turbo', '.cache', 'target', '__pycache__', '.venv', 'venv',
]);

// Source file extensions worth loading as context. Keeps binaries + lockfiles out.
const SOURCE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.dart', '.json', '.md', '.yaml', '.yml', '.txt', '.toml',
]);

/** tree-sitter language id for a path, or null when unsupported. */
function languageForFile(path: string): string | null {
  const lower = path.toLowerCase();
  if (lower.endsWith('.tsx')) return 'tsx';
  if (lower.endsWith('.ts') || lower.endsWith('.mts') || lower.endsWith('.cts')) return 'typescript';
  if (lower.endsWith('.jsx') || lower.endsWith('.js') || lower.endsWith('.mjs') || lower.endsWith('.cjs')) return 'javascript';
  if (lower.endsWith('.py')) return 'python';
  if (lower.endsWith('.dart')) return 'dart';
  return null;
}

/** Canonicalize an OS path (relative to root) to '/'-separated project-relative form. */
function canonical(root: string, abs: string): string {
  return relative(root, abs).split(sep).join('/');
}

export class ContextCollector {
  private readonly skipDirs: ReadonlySet<string>;
  private readonly maxFiles: number;
  private readonly maxFileBytes: number;
  private readonly maxTotalBytes: number;
  private adapter: TreeSitterAdapter | null = null;
  private treeSitterUnavailable = false;

  constructor(private readonly opts: ContextCollectorOptions) {
    this.skipDirs = opts.skipDirs !== undefined ? new Set(opts.skipDirs) : DEFAULT_SKIP_DIRS;
    this.maxFiles = opts.maxFiles ?? 200;
    this.maxFileBytes = opts.maxFileBytes ?? 64 * 1024;
    this.maxTotalBytes = opts.maxTotalBytes ?? 2 * 1024 * 1024;
  }

  /**
   * Collect context signals from the workspace. Never throws — on any error the result
   * degrades (fewer files, empty symbols/graph). `changedPaths` lets the caller mark the
   * affected set (e.g. files the current task edited); when empty the Retriever falls
   * back to import-distance / alphabetical ranking.
   */
  async collect(changedPaths: readonly string[] = [], plan?: ContextPlan): Promise<CollectedContext> {
    // P12.7: derive per-call caps from the mission's context plan. A repositoryWide plan reads as
    // broadly as the instance allows; a narrow (non-repo) plan is bounded to ~plan.maxFiles files
    // and a tighter byte ceiling, so a trivial task does not slurp the whole repo (CX-005, §34).
    // No plan ⇒ the instance defaults (unchanged behavior, fail-safe). Pure caps; the downstream
    // TokenBudgeter still trims to the policy budget.
    const caps = this.resolveCaps(plan);
    const workspaceFiles = await this.readWorkspaceFiles(caps);
    const effectiveChanged = changedPaths.filter((p) => workspaceFiles.has(p));

    // Code-intelligence over the TS/JS/… subset. Degrades to empty on any failure.
    const { symbols, importReverseEdges } = await this.analyze(workspaceFiles);

    // P12.17 (opt-in): enrich the reverse-edge graph with LSP references for the CHANGED files, so
    // the Retriever pulls the real call-sites of a changed symbol (cross-package/alias too). Pure
    // additive — never removes a tree-sitter edge; degrades silently when the pool/server is absent.
    const edges = this.opts.lspPool !== undefined && effectiveChanged.length > 0
      ? await this.augmentWithLsp(importReverseEdges, workspaceFiles, effectiveChanged)
      : importReverseEdges;

    return {
      workspaceFiles,
      symbols,
      importReverseEdges: edges,
      changedPaths: effectiveChanged,
    };
  }

  /**
   * P12.17: merge LSP `references` edges into the import-graph reverse edges. For each changed
   * TS/JS file (bounded), ask the pool's adapter for the file's top-level symbols, then the
   * references to each symbol; every referencing file becomes a reverse-edge neighbour of the
   * changed (definition) file — the same shape the Retriever already uses to expand the affected
   * set. Returns a NEW merged map; the input is never mutated. Never throws (degrade → input).
   */
  private async augmentWithLsp(
    base: ReadonlyMap<string, ReadonlySet<string>>,
    files: ReadonlyMap<string, string>,
    changed: readonly string[],
  ): Promise<ReadonlyMap<string, ReadonlySet<string>>> {
    const pool = this.opts.lspPool;
    if (pool === undefined) return base;
    const maxFiles   = this.opts.lspMaxChangedFiles ?? 20;
    const maxSymbols = this.opts.lspMaxSymbolsPerFile ?? 40;
    const root = this.opts.workspaceRoot;

    // Copy base into a mutable map of mutable sets (never touch the input).
    const merged = new Map<string, Set<string>>();
    for (const [k, v] of base) merged.set(k, new Set(v));
    const addEdge = (def: string, referrer: string): void => {
      if (def === referrer) return;
      let set = merged.get(def);
      if (set === undefined) { set = new Set(); merged.set(def, set); }
      set.add(referrer);
    };
    // Map an LSP file:// uri back to a canonical project-relative path we actually hold.
    const uriToRel = (uri: string): string | null => {
      try {
        const abs = decodeURIComponent(new URL(uri).pathname).replace(/^\/([A-Za-z]:)/, '$1');
        const rel = canonical(root, abs);
        return files.has(rel) ? rel : null;
      } catch { return null; }
    };

    let probed = 0;
    for (const rel of changed) {
      if (probed >= maxFiles) break;
      if (languageForFile(rel) === null) continue;
      const content = files.get(rel);
      if (content === undefined) continue;
      let adapter;
      try { adapter = await pool.forFile(rel); } catch { adapter = null; }
      if (adapter === null) continue; // no server for this language / unavailable → skip
      probed++;
      const uri = pathToFileURL(join(root, rel)).href;
      try {
        const syms = await adapter.documentSymbol(uri, content);
        for (const sym of syms.slice(0, maxSymbols)) {
          const refs = await adapter.references(uri, content, sym.range.start);
          for (const loc of refs) {
            const referrer = uriToRel(loc.uri);
            if (referrer !== null) addEdge(rel, referrer);
          }
        }
      } catch {
        // per-file LSP failure — keep whatever edges we have, continue with the next file
      }
    }
    return merged;
  }

  /**
   * Translate a ContextPlan into concrete collection caps for a single collect() call. The
   * instance caps are the ceiling; a narrow plan only ever TIGHTENS them (never widens past the
   * instance limits). Deterministic + pure. Absent plan ⇒ the instance defaults verbatim.
   */
  private resolveCaps(plan?: ContextPlan): { maxFiles: number; maxTotalBytes: number } {
    if (plan === undefined || plan.repositoryWide) {
      return { maxFiles: this.maxFiles, maxTotalBytes: this.maxTotalBytes };
    }
    // Narrow (non-repository) scope: bound to the plan's soft file cap (with a little headroom so
    // import-graph neighbours still load), clamped to the instance ceiling; byte budget tightened
    // proportionally but never below a usable floor.
    const narrowFiles = Math.min(this.maxFiles, Math.max(4, plan.maxFiles * 3));
    const narrowBytes = Math.min(this.maxTotalBytes, Math.max(128 * 1024, narrowFiles * this.maxFileBytes));
    return { maxFiles: narrowFiles, maxTotalBytes: narrowBytes };
  }

  // ── file collection ─────────────────────────────────────────────────────────

  private async readWorkspaceFiles(caps: { maxFiles: number; maxTotalBytes: number }): Promise<ReadonlyMap<string, string>> {
    const files = new Map<string, string>();
    let totalBytes = 0;
    const { maxFiles, maxTotalBytes } = caps;

    const walk = async (dir: string): Promise<void> => {
      if (files.size >= maxFiles || totalBytes >= maxTotalBytes) return;
      let entries: Dirent[];
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return; // unreadable dir — skip
      }
      // Deterministic order.
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (files.size >= maxFiles || totalBytes >= maxTotalBytes) return;
        if (entry.name.startsWith('.') && entry.isDirectory()) {
          if (this.skipDirs.has(entry.name)) continue;
        }
        const abs = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (this.skipDirs.has(entry.name)) continue;
          await walk(abs);
        } else if (entry.isFile()) {
          if (!SOURCE_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue;
          try {
            const info = await stat(abs);
            if (info.size > this.maxFileBytes) continue;
            if (totalBytes + info.size > maxTotalBytes) continue;
            const content = await readFile(abs, 'utf8');
            // Skip apparent binaries (NUL byte) that slipped past the extension filter.
            if (content.includes('\u0000')) continue;
            files.set(canonical(this.opts.workspaceRoot, abs), content);
            totalBytes += info.size;
          } catch {
            // unreadable file — skip
          }
        }
      }
    };

    await walk(this.opts.workspaceRoot);
    return files;
  }

  // ── code intelligence ────────────────────────────────────────────────────────

  private async analyze(files: ReadonlyMap<string, string>): Promise<{
    symbols: readonly RetrievedSymbol[];
    importReverseEdges: ReadonlyMap<string, ReadonlySet<string>>;
  }> {
    const adapter = await this.getAdapter();
    if (adapter === null) {
      return { symbols: [], importReverseEdges: new Map() };
    }

    const extractor = new SymbolExtractor(adapter);
    const symbols: RetrievedSymbol[] = [];
    for (const [path, content] of files) {
      const language = languageForFile(path);
      if (language === null) continue;
      try {
        const found = await extractor.extract(content, language, path);
        for (const s of found) {
          symbols.push({
            file:      path,
            name:      s.name,
            kind:      s.kind,
            startLine: s.startLine,
            endLine:   s.endLine,
            exported:  s.exported,
          });
        }
      } catch {
        // per-file parse failure — skip that file's symbols
      }
    }

    let importReverseEdges: ReadonlyMap<string, ReadonlySet<string>> = new Map();
    try {
      const graph = await new ImportGraphBuilder(adapter).build({ files });
      importReverseEdges = graph.reverseEdges;
    } catch {
      // graph failure — leave empty (Retriever falls back to alphabetical ranking)
    }

    return { symbols, importReverseEdges };
  }

  /** Lazily initialize the tree-sitter adapter once. Returns null if unavailable. */
  private async getAdapter(): Promise<TreeSitterAdapter | null> {
    if (this.treeSitterUnavailable) return null;
    if (this.adapter !== null) return this.adapter;
    try {
      const adapter = new TreeSitterAdapter();
      await adapter.initialize();
      this.adapter = adapter;
      return adapter;
    } catch {
      // WASM runtime unavailable on this platform — degrade to files-only context.
      this.treeSitterUnavailable = true;
      return null;
    }
  }
}
