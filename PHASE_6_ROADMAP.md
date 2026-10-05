# PHASE_6_ROADMAP.md

**Ollama Coding Agent — Kế hoạch Phase 6 (Advanced Code Intelligence)**

Version: 1.0
Status: Working plan
Owner: Intelligence Plane / Code Intelligence Layer
Scope: Tree-sitter + LSP integration → symbol graph, affected-file detection,
       semantic context retrieval, precise verification scope (AFFECTED_CLOSURE).
Related:
`PHASE_5_SIGNOFF.md`, `INVARIANTS.md`, `CONTEXT_SPEC.md §4.3`,
`INFRASTRUCTURE_SPEC.md §10-11`, `Coding Agent Architecture Target §56`

---

## 0. Nguyên tắc Phase 6

> **Phase 5 làm agent phục hồi khi thất bại. Phase 6 làm agent hiểu code.**

Ba luật:

1. **Code intelligence là evidence, không phải authority** — symbol graph và import
   graph cung cấp context tốt hơn cho model, nhưng quyết định vẫn do runtime
   deterministic. Cùng nguyên tắc với context (CX-005).
2. **Graceful degradation** — nếu Tree-sitter không parse được một file (syntax error,
   unsupported language), system vẫn hoạt động với diff-based heuristic (baseline Phase 2).
3. **Performance không block** — parsing on-demand, cache theo (path, mtime),
   không parse toàn bộ workspace trước khi execute.

North Star: *Khi agent sửa `src/auth.ts`, nó biết chính xác test file nào cần chạy,
context symbol nào liên quan, và verification scope là `AFFECTED_CLOSURE` thay vì `FULL`.*

---

## 1. Con số Phase 6

Phase 6 **không có invariants mới** trong `invariants.yaml` (phase==6 = 0).
Các invariants liên quan đều đã phân bổ từ trước:
- **CX-002** (Phase 2): mọi context item phải có provenance — Phase 6 upgrade Retriever.
- **VR-004** (Phase 1.5): final graph verification phải dùng ≥ AFFECTED_CLOSURE.
- **VR-010** (Phase 1.5): scope computation phải deterministic.
- **RC-003** (Phase 5): `relevantFilesChanged` signal từ Phase 6 bổ sung cho NoProgressDetector.

Phase 6 là **precision milestone** — existing invariants thoả tốt hơn, không thêm mới.

---

## 2. Scope Phase 6

### 2.1 In-scope

| Component | Mục tiêu | Enforces |
|---|---|---|
| `TreeSitterAdapter` | Parse AST, query symbols, extract imports | INFRASTRUCTURE_SPEC §10 |
| `SymbolExtractor` | Extract function/class/variable symbols per file | CX-002 |
| `ImportGraphBuilder` | Build import graph (TypeScript / Dart) | VR-004 |
| `AffectedSetComputer` | Transitive affected files from changed paths | VR-004, VR-010 |
| `LspAdapter` (optional) | definition/references/symbols via LSP server | INFRASTRUCTURE_SPEC §11 |
| `CodeIntelligenceRetriever` | Upgrade Retriever: symbols + imports + affected | CX-002, CX-003 |
| `VerificationScope upgrade` | AFFECTED_CLOSURE now uses real import graph | VR-004, VR-010 |
| `NoProgressDetector upgrade` | `relevantFilesChanged` signal added (RC-003) | RC-003 |
| P6-I1 Integration E2E | Parse real TS file, extract symbols, compute affected set | All Phase-6 |

### 2.2 Out-of-scope (Phase 6)

- Memory / RAG (Phase 7).
- Multi-agent (Phase 8+).
- Streaming LSP (future).
- Full language server lifecycle management (VS Code handles).

---

## 3. Kiến trúc những gì đã có

### 3.1 Đã có — dùng ngay

| Thứ | Location | Status |
|---|---|---|
| `Retriever` (diff-based baseline) | `agent-core/src/context/retriever.ts` | ✅ Phase 2 |
| `computeAffectedDirect()` | `agent-core/src/verification/affected-set.ts` | ✅ Phase 1.5 |
| `computeAffectedClosure()` (stub) | `agent-core/src/verification/affected-set.ts` | ✅ Phase 1.5 |
| `VerificationScope` lattice | `agent-core/src/domain/verification.ts` | ✅ Phase 1.5 |
| `computeScope()` | `agent-core/src/verification/scope-computer.ts` | ✅ Phase 1.5 |
| `WorkspaceManager` | `agent-core/src/workspace/workspace-manager.ts` | ✅ Phase 3 |
| `NodeWorkspaceManager` | `infrastructure/src/workspace/node-workspace-manager.ts` | ✅ Phase 3 |

### 3.2 Cần tạo mới (Phase 6)

| Component | Package | Phần cốt lõi |
|---|---|---|
| `TreeSitterAdapter` | infrastructure | parse() + query() + cache by mtime |
| `SymbolExtractor` | infrastructure | symbol extraction per file per language |
| `ImportGraphBuilder` | infrastructure | TS `import`/`require` + Dart `import` extraction |
| `AffectedSetComputer` | agent-core | transitive closure via import graph |
| `LspAdapter` | infrastructure | optional, TypeScript LSP first |
| `CodeIntelligenceRetriever` | agent-core/infra | Retriever upgrade |
| P6-I1 E2E | tests | parse + symbols + affected set on real TS file |

---

## 4. Component breakdown

### 4.1 P6-TS1 — TreeSitterAdapter

```
infrastructure/src/code-intelligence/
  tree-sitter-adapter.ts  ← parse(), query(), supportedLanguages()
  language-cache.ts       ← cache (path, mtime) → SyntaxTree
```

```typescript
interface TreeSitterAdapter {
  parse(path: string, content: string, language: string): SyntaxTree;
  query(tree: SyntaxTree, queryString: string): SyntaxMatch[];
  supportedLanguages(): string[];
}
```

Supported languages v1: `typescript`, `javascript`, `python`.
Cache: `Map<string, { mtime: number; tree: SyntaxTree }>`.

### 4.2 P6-SX1 — SymbolExtractor

```
infrastructure/src/code-intelligence/
  symbol-extractor.ts  ← extract(path, tree) → Symbol[]
```

```typescript
interface Symbol {
  name:        string;
  kind:        'function' | 'class' | 'variable' | 'interface' | 'type' | 'enum';
  startLine:   number;
  endLine:     number;
  exported:    boolean;
}
```

Uses Tree-sitter queries:
- TypeScript: `(function_declaration name: (identifier) @name)`
- TypeScript: `(class_declaration name: (type_identifier) @name)`
- Export detection: `(export_statement declaration: _)`

### 4.3 P6-IG1 — ImportGraphBuilder

```
infrastructure/src/code-intelligence/
  import-graph-builder.ts  ← build(rootDir, files) → ImportGraph
```

```typescript
interface ImportGraph {
  /** Map: canonical file path → set of canonical import paths */
  edges: ReadonlyMap<string, ReadonlySet<string>>;
  /** Resolve relative imports to canonical paths */
  resolve(fromFile: string, importPath: string): string | null;
}
```

TypeScript: parse `import ... from '...'` + `require('...')` via Tree-sitter.
Dart: parse `import '...'` statements.

### 4.4 P6-AS1 — AffectedSetComputer (real closure)

```
agent-core/src/verification/affected-set.ts  ← upgrade computeAffectedClosure()
```

Replace the Phase 1.5 heuristic stub with real import-graph transitive closure:

```
affected_closure(changed_files, import_graph):
  queue = changed_files.copy()
  visited = {}
  while queue:
    file = queue.pop()
    if file in visited: continue
    visited.add(file)
    for importer in reverse_edges[file]:
      queue.push(importer)
  return visited
```

`VR-004`: final graph verification now correctly uses `AFFECTED_CLOSURE`.
`VR-010`: still deterministic — BFS on stable map.

### 4.5 P6-LX1 — LspAdapter (optional)

```
infrastructure/src/code-intelligence/
  lsp-adapter.ts  ← start(), stop(), definition(), references(), symbols()
```

Uses `@vscode/languageclient` or raw LSP protocol over stdio.
Phase 6 v1: TypeScript LSP (`typescript-language-server`) only.
Lifecycle: start on first use, reuse session, stop on workspace close.

### 4.6 P6-CR1 — CodeIntelligenceRetriever upgrade

Upgrade `Retriever` in `agent-core/src/context/retriever.ts` to:
1. If `hints.symbols` provided → include symbol definitions from `SymbolExtractor`.
2. If changed paths available → include affected files via `AffectedSetComputer`.
3. Rank by import distance from changed files.

`CX-002`: each item still has `provenance.source.kind = 'workspace_file'`.
`CX-003`: workspace content still marked `trust: 'untrusted'`.

### 4.7 P6-I1 — Integration E2E

```
tests/integration/code-intelligence-e2e.spec.ts
```

Scenarios:
1. Parse a real TypeScript file → extract symbols correctly.
2. Build import graph for a small project → verify edges.
3. Compute affected set from 1 changed file → transitive closure correct.
4. CodeIntelligenceRetriever returns symbols in context.

---

## 5. Timeline (4 tuần)

```
Tuần 1 — Tree-sitter + Symbols
  P6-TS1   TreeSitterAdapter (parse + cache)                     [2 ngày]
  P6-SX1   SymbolExtractor (functions/classes/exports)           [2 ngày]
  —        Tests: parse real TS file, extract symbols            [1 ngày]

Tuần 2 — Import graph + Affected set
  P6-IG1   ImportGraphBuilder (TS + Dart imports)                [2 ngày]
  P6-AS1   AffectedSetComputer (real transitive closure)         [2 ngày]
  —        Tests: import graph + affected set                    [1 ngày]

Tuần 3 — Retriever upgrade + LSP (optional)
  P6-CR1   CodeIntelligenceRetriever upgrade                     [2 ngày]
  P6-LX1   LspAdapter (TypeScript LSP, optional)                 [2 ngày]
  —        Buffer                                                [1 ngày]

Tuần 4 — Integration + Sign-off
  P6-I1    Integration E2E                                       [2 ngày]
  —        PHASE_6_SIGNOFF.md                                    [1 ngày]
  —        Buffer                                                [2 ngày]
```

---

## 6. Exit criteria Phase 6

1. Tất cả §4 components implemented.
2. `TreeSitterAdapter.parse()` trả về AST cho TypeScript files (không crash).
3. `SymbolExtractor` extract đúng function/class names từ real TS file.
4. `ImportGraphBuilder` build đúng import edges từ TS imports.
5. `computeAffectedClosure()` dùng import graph thật (không phải heuristic stub).
6. `VerificationScope` cho changed TS files upgrade từ AFFECTED_DIRECT → AFFECTED_CLOSURE.
7. `NoProgressDetector` nhận `relevantFilesChanged` signal (RC-003 — optional signal).
8. P6-I1 E2E pass trên real TypeScript project.
9. Không TypeScript error / ESLint error / dependency-cruiser violation.
10. CI green trên 2 OS.
11. `PHASE_6_SIGNOFF.md` được tạo.

---

## 7. Rủi ro

| Rủi ro | Xác suất | Tác động | Mitigation |
|---|---|---|---|
| `tree-sitter` npm package issues | Thấp | Cao | Test trên cả Windows/WSL trước khi code |
| LSP server startup time in CI | Cao | Trung bình | P6-LX1 optional; skip LSP tests in CI if server not found |
| Import graph circular dependency | Thấp | Thấp | BFS with visited set prevents infinite loop |
| TypeScript import resolution complex | Trung bình | Trung bình | Start with `./relative` and `../relative` only; skip `node_modules` |

---

## 8. Những gì Phase 6 KHÔNG làm

- Không có Memory / RAG (Phase 7).
- Không có multi-agent (Phase 8+).
- Không có semantic diffing (tương lai).
- Không có full VS Code LSP lifecycle (VS Code handles that).
- Không có Python LSP (Phase 6 v2).

---

## Phụ lục: Tree-sitter package

```
npm install tree-sitter tree-sitter-typescript tree-sitter-python --save-exact
```

Cross-platform: `tree-sitter` có pre-built binaries cho Windows x64, Linux x64, macOS.
Node binding: `node-tree-sitter` (wraps native addon, pre-built via node-pre-gyp).