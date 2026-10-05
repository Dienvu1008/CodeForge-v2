// TreeSitterAdapter — P6-TS1. AST parsing via web-tree-sitter (cross-platform WASM).
//
// Uses web-tree-sitter (WASM) — no native addon, works on Windows/Linux/macOS.
// Grammar WASM files come from the tree-sitter-wasms package.
//
// Version pinning: web-tree-sitter@0.20.8 is held to match the tree-sitter ABI
// of the grammars shipped by tree-sitter-wasms@0.1.13 (built with tree-sitter-cli
// 0.20.x). Newer web-tree-sitter (0.25+) rejects these grammars with a dylink
// metadata error, so the runtime is kept on the 0.20 line to match the grammars.
//
// Design:
//   - initialize() must be called once before any parse()/queryText() call.
//   - Grammar files are loaded lazily per language on first use.
//   - Parse cache: (filePath, sha256(content)) -> SyntaxTree (avoids re-parsing).
//   - Graceful degradation: unsupported language -> TreeSitterError("UNSUPPORTED_LANGUAGE")
//     (callers catch and fall back to diff-based heuristic).
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import Parser from "web-tree-sitter";

// -- Public types --------------------------------------------------------------

export interface SyntaxPoint {
  readonly row:    number;
  readonly column: number;
}

export interface SyntaxNode {
  readonly type:          string;
  readonly startByte:     number;
  readonly endByte:       number;
  readonly startPosition: SyntaxPoint;
  readonly endPosition:   SyntaxPoint;
  readonly text:          string;
  /** Named children only (comments/punctuation excluded). */
  readonly namedChildren: readonly SyntaxNode[];
}

export interface SyntaxTree {
  readonly language: string;
  readonly root:     SyntaxNode;
}

export interface SyntaxMatch {
  readonly patternIndex: number;
  readonly captures:     ReadonlyArray<{ name: string; node: SyntaxNode }>;
}

// -- Errors --------------------------------------------------------------------

export class TreeSitterError extends Error {
  public readonly code:
    | "NOT_INITIALIZED"
    | "UNSUPPORTED_LANGUAGE"
    | "PARSE_FAILED"
    | "WASM_NOT_FOUND";
  constructor(code: TreeSitterError["code"], message?: string) {
    super(message ?? code);
    this.name = "TreeSitterError";
    this.code = code;
  }
}

// -- Language map --------------------------------------------------------------

/** Supported languages and their WASM grammar file names (tree-sitter-wasms/out/). */
const LANGUAGE_WASM: Readonly<Record<string, string>> = {
  typescript: "tree-sitter-typescript.wasm",
  javascript: "tree-sitter-javascript.wasm",
  tsx:        "tree-sitter-tsx.wasm",
  dart:       "tree-sitter-dart.wasm",
  python:     "tree-sitter-python.wasm",
};

// -- TreeSitterAdapter ---------------------------------------------------------

export class TreeSitterAdapter {
  private _parser: Parser | null = null;
  private readonly _languages  = new Map<string, Parser.Language>();
  private readonly _parseCache = new Map<string, { hash: string; tree: SyntaxTree }>();
  private readonly _wasmDir:    string;

  constructor(opts?: { wasmDir?: string }) {
    this._wasmDir = opts?.wasmDir ?? defaultWasmDir();
  }

  /**
   * Initialize the WASM runtime. Idempotent (no-op after first call).
   * Must run before parse()/queryText().
   */
  async initialize(): Promise<void> {
    if (this._parser !== null) return;
    await Parser.init();
    this._parser = new Parser();
  }

  /** List of supported language identifiers. */
  supportedLanguages(): string[] {
    return Object.keys(LANGUAGE_WASM);
  }

  /**
   * Parse source code and return a SyntaxTree.
   * Results are cached by (filePath, sha256(content)).
   *
   * @param filePath  Used as cache key. Pass "" for inline strings.
   * @param content   UTF-8 source text.
   * @param language  One of supportedLanguages().
   */
  async parse(filePath: string, content: string, language: string): Promise<SyntaxTree> {
    const parser = this._requireParser();
    const lang = await this._loadLanguage(language);

    const hash = createHash("sha256").update(content, "utf8").digest("hex").slice(0, 16);
    const cacheKey = `${filePath}:${hash}`;
    const cached = this._parseCache.get(cacheKey);
    if (cached !== undefined && cached.hash === hash) return cached.tree;

    parser.setLanguage(lang);
    const rawTree = parser.parse(content);
    // 0.20.x returns a Tree (not null); guard defensively anyway.
    if (rawTree === null || rawTree === undefined) {
      throw new TreeSitterError("PARSE_FAILED", `Failed to parse ${filePath}`);
    }

    const tree: SyntaxTree = { language, root: toSyntaxNode(rawTree.rootNode, content) };
    this._parseCache.set(cacheKey, { hash, tree });
    return tree;
  }

  /**
   * Run a Tree-sitter pattern query against source text and return matches with
   * named captures. Re-parses the content (cheaper than retaining raw trees).
   */
  async queryText(
    content:     string,
    language:    string,
    queryString: string,
  ): Promise<SyntaxMatch[]> {
    const parser = this._requireParser();
    const lang = await this._loadLanguage(language);
    parser.setLanguage(lang);
    const rawTree = parser.parse(content);
    if (rawTree === null || rawTree === undefined) return [];

    const query = lang.query(queryString);
    const rawMatches = query.matches(rawTree.rootNode);

    return rawMatches.map((m) => ({
      patternIndex: m.pattern,
      captures: m.captures.map((c) => ({
        name: c.name,
        node: toSyntaxNode(c.node, content),
      })),
    }));
  }

  /** Invalidate parse cache for a specific file (e.g., after a write). */
  invalidate(filePath: string): void {
    for (const key of this._parseCache.keys()) {
      if (key.startsWith(filePath + ":")) this._parseCache.delete(key);
    }
  }

  // -- private -----------------------------------------------------------------

  private _requireParser(): Parser {
    if (this._parser === null) {
      throw new TreeSitterError("NOT_INITIALIZED", "Call initialize() before parsing");
    }
    return this._parser;
  }

  private async _loadLanguage(language: string): Promise<Parser.Language> {
    const cached = this._languages.get(language);
    if (cached !== undefined) return cached;

    const wasmName = LANGUAGE_WASM[language];
    if (wasmName === undefined) {
      throw new TreeSitterError("UNSUPPORTED_LANGUAGE", `Unsupported language: ${language}`);
    }

    const wasmPath = join(this._wasmDir, wasmName);
    let wasmBuf: Buffer;
    try {
      wasmBuf = await readFile(wasmPath);
    } catch {
      throw new TreeSitterError("WASM_NOT_FOUND", `WASM grammar not found: ${wasmPath}`);
    }

    const lang = await Parser.Language.load(new Uint8Array(wasmBuf));
    this._languages.set(language, lang);
    return lang;
  }
}

// -- helpers -------------------------------------------------------------------

/** Resolve the tree-sitter-wasms out/ directory via module resolution (hoist-safe). */
function defaultWasmDir(): string {
  const require = createRequire(import.meta.url);
  const pkgJson = require.resolve("tree-sitter-wasms/package.json");
  return join(dirname(pkgJson), "out");
}

function toSyntaxNode(node: Parser.SyntaxNode, source: string): SyntaxNode {
  const named: SyntaxNode[] = [];
  for (const child of node.namedChildren) {
    named.push(toSyntaxNode(child, source));
  }
  return {
    type:          node.type,
    startByte:     node.startIndex,
    endByte:       node.endIndex,
    startPosition: { row: node.startPosition.row, column: node.startPosition.column },
    endPosition:   { row: node.endPosition.row,   column: node.endPosition.column },
    text:          source.slice(node.startIndex, node.endIndex),
    namedChildren: named,
  };
}
