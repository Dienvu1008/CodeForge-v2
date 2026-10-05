// SymbolExtractor — P6-SX1. Extract symbols from a SyntaxTree.
//
// Extracts function/class/variable declarations and interface/type/enum definitions.
// Language-specific query strings select the right AST node types.
// Graceful degradation: if a language is not supported, returns empty array.
//
// Phase 6 v1 supports: typescript, javascript, dart, python.
import type { TreeSitterAdapter, SyntaxTree } from './tree-sitter-adapter.js';

// ── Symbol types ──────────────────────────────────────────────────────────────

export type SymbolKind =
  | 'function'
  | 'class'
  | 'variable'
  | 'interface'
  | 'type'
  | 'enum'
  | 'method'
  | 'constructor';

export interface CodeSymbol {
  readonly name:       string;
  readonly kind:       SymbolKind;
  readonly startLine:  number; // 0-indexed
  readonly endLine:    number; // 0-indexed
  readonly exported:   boolean;
}

// ── Language queries ──────────────────────────────────────────────────────────
//
// Tree-sitter S-expression patterns for symbol extraction.
// Each query captures a `@name` node.

const TS_QUERIES = [
  // Functions (named)
  '(function_declaration name: (identifier) @name) @def',
  // Arrow functions with const binding
  '(lexical_declaration (variable_declarator name: (identifier) @name value: (arrow_function)))',
  // Classes
  '(class_declaration name: (type_identifier) @name) @def',
  // Interfaces
  '(interface_declaration name: (type_identifier) @name) @def',
  // Type aliases
  '(type_alias_declaration name: (type_identifier) @name) @def',
  // Enums
  '(enum_declaration name: (identifier) @name) @def',
].join('\n');

const JS_QUERIES = [
  '(function_declaration name: (identifier) @name)',
  '(lexical_declaration (variable_declarator name: (identifier) @name value: (arrow_function)))',
  '(class_declaration name: (identifier) @name)',
].join('\n');

const PYTHON_QUERIES = [
  '(function_definition name: (identifier) @name)',
  '(class_definition name: (identifier) @name)',
].join('\n');

const DART_QUERIES = [
  '(function_signature name: (identifier) @name)',
  '(class_declaration name: (identifier) @name)',
].join('\n');

function getQuery(language: string): string | null {
  switch (language) {
    case 'typescript':
    case 'tsx':
      return TS_QUERIES;
    case 'javascript':
      return JS_QUERIES;
    case 'python':
      return PYTHON_QUERIES;
    case 'dart':
      return DART_QUERIES;
    default:
      return null;
  }
}

// ── SymbolExtractor ───────────────────────────────────────────────────────────

export class SymbolExtractor {
  constructor(private readonly adapter: TreeSitterAdapter) {}

  /**
   * Extract symbols from source content for a given language.
   * Returns an empty array for unsupported languages (graceful degradation).
   */
  async extract(
    content:   string,
    language:  string,
    _filePath = '',
  ): Promise<readonly CodeSymbol[]> {
    const queryStr = getQuery(language);
    if (queryStr === null) return [];

    const lines = content.split('\n');

    try {
      const matches = await this.adapter.queryText(content, language, queryStr);
      const symbols: CodeSymbol[] = [];

      for (const match of matches) {
        const nameCapture = match.captures.find((c) => c.name === 'name');
        if (nameCapture === undefined) continue;

        const node = nameCapture.node;
        const startLine = node.startPosition.row;
        const endLine   = node.endPosition.row;

        // Determine kind from surrounding context (simplified heuristic).
        const kind = inferKind(content, node.startByte, language);

        // Detect export: check if any parent line contains 'export'.
        const lineText = lines[startLine] ?? '';
        const exported = lineText.includes('export') || isExported(content, node.startByte);

        symbols.push({ name: node.text, kind, startLine, endLine, exported });
      }

      return symbols;
    } catch {
      // Parse or query failed — graceful degradation.
      return [];
    }
  }

  /**
   * Extract symbols from an already-parsed SyntaxTree.
   * Useful when the tree is already cached.
   */
  async extractFromTree(
    tree:    SyntaxTree,
    content: string,
  ): Promise<readonly CodeSymbol[]> {
    return this.extract(content, tree.language);
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────

function inferKind(source: string, startByte: number, language: string): SymbolKind {
  // Look at the preceding context (up to 100 chars before the symbol).
  const context = source.slice(Math.max(0, startByte - 100), startByte);
  const contextLower = context.toLowerCase();

  if (language === 'typescript' || language === 'tsx' || language === 'javascript') {
    if (contextLower.includes('interface '))   return 'interface';
    if (contextLower.includes('class '))       return 'class';
    if (contextLower.includes('enum '))        return 'enum';
    if (contextLower.includes('type '))        return 'type';
    if (contextLower.includes('function '))    return 'function';
    if (contextLower.includes('const ') || contextLower.includes('let ')) return 'variable';
  }
  if (language === 'python') {
    if (contextLower.includes('class ')) return 'class';
    return 'function';
  }
  if (language === 'dart') {
    if (contextLower.includes('class ')) return 'class';
    return 'function';
  }
  return 'function';
}

function isExported(source: string, startByte: number): boolean {
  // Check if the line or statement starts with 'export'.
  const lineStart = source.lastIndexOf('\n', startByte - 1) + 1;
  const lineText  = source.slice(lineStart, startByte);
  return /^\s*export\s/.test(lineText);
}