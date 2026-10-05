// Phase 6 — P6-TS1/SX1: Tree-sitter AST adapter + symbol extractor.
export { TreeSitterAdapter, TreeSitterError } from './tree-sitter-adapter.js';
export type { SyntaxNode, SyntaxTree, SyntaxMatch } from './tree-sitter-adapter.js';
export { SymbolExtractor } from './symbol-extractor.js';
export type { CodeSymbol, SymbolKind } from './symbol-extractor.js';
// P6-IG1: Import graph builder (TS/JS).
export { ImportGraphBuilder } from './import-graph-builder.js';
export type { ImportGraph, ImportEdge, BuildInput } from './import-graph-builder.js';
