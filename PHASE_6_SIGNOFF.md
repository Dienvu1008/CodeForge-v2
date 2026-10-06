# Phase 6 Sign-off — Advanced Code Intelligence

Date: 2026-09-14
Branch: main
Commits: fbb5761 (P6-TS1/SX1), ee8d25d (P6-IG1), 8d504f6 (P6-AS1),
         40f407b (P6-CR1), 342dea4 (P6-I1 E2E + sign-off)

Format per PHASE_6_ROADMAP §6 (Exit criteria). Phase 6 delivers the
**Code Intelligence Layer**: the agent now parses source into an AST, extracts
symbols, builds an import graph, computes a real transitive affected set, and
feeds symbols + import-distance-ranked files into the context Retriever. All of
it is deterministic, cross-platform (WASM, no native addon), and degrades
gracefully when a language or grammar is unavailable.

> Phase 5 made the agent recover when it fails. Phase 6 makes the agent
> understand code.

---

## Exit criteria (PHASE_6_ROADMAP §6)

- [x] 1. All §4 components implemented (P6-TS1, P6-SX1, P6-IG1, P6-AS1, P6-CR1, P6-I1).
         P6-LX1 (LspAdapter) is optional — **deferred to Phase 7** (see Deferred section).
- [x] 2. `TreeSitterAdapter.parse()` returns an AST for TypeScript files without crashing.
- [x] 3. `SymbolExtractor` extracts correct function/class names from a real TS file.
- [x] 4. `ImportGraphBuilder` builds correct import edges from TS imports.
- [x] 5. `computeAffectedClosureFromGraph()` uses a real import graph (not the heuristic stub).
- [x] 6. `computeScope()` for changed TS files promotes AFFECTED_DIRECT → AFFECTED_CLOSURE
         (VR-004) using the real closure size — verified in the E2E.
- [ ] 7. `NoProgressDetector` `relevantFilesChanged` signal (RC-003) — **deferred to Phase 7**.
         The roadmap marks this an optional/enriching signal, not a required component.
         The import graph that would feed it now exists; wiring is a Phase 7 follow-up.
- [x] 8. P6-I1 E2E passes on a real TypeScript project.
- [x] 9. No TypeScript error / ESLint error / dependency-cruiser violation.
- [x] 10. CI green on 2 OS — Windows 11 + WSL2 Ubuntu 24.04, Node 20.18.1.
- [x] 11. `PHASE_6_SIGNOFF.md` created (this document).

Note: item 7 is left **unchecked** on purpose — it is a deferred, roadmap-optional
signal, not completed work. Item 1's optional sub-component (P6-LX1) is likewise
deferred. Both are recorded transparently in the Deferred section rather than
silently dropped or falsely marked done. All *required* exit criteria are met.

---

## Components delivered (PHASE_6_ROADMAP §4)

| ID | Component | Package | Enriches |
|---|---|---|---|
| P6-TS1 | `TreeSitterAdapter` — WASM AST parse + query + per-(path,hash) cache | infrastructure | INFRASTRUCTURE_SPEC §10 |
| P6-SX1 | `SymbolExtractor` — function/class/interface/type/enum/arrow symbols | infrastructure | CX-002 |
| P6-IG1 | `ImportGraphBuilder` — import edges + reverse edges (TS/JS) | infrastructure | VR-004 |
| P6-AS1 | `computeAffectedClosureFromGraph` — real transitive closure | agent-core | VR-004, VR-010 |
| P6-CR1 | `Retriever` upgrade — symbol injection + import-distance ranking | agent-core | CX-002, CX-003 |
| P6-I1 | Code Intelligence E2E — full chain on a real TS project | tests | all Phase-6 |

---

## Test results

- Total automated tests: **989 / 989 pass** across **71 test files** (Vitest).
- No TypeScript errors (`tsc --build --force`), no build errors.
- No ESLint errors (`eslint .`).
- dependency-cruiser: **0 violations** (547 modules, 1296 dependencies cruised).

### Phase 6 additions (over Phase 5 baseline of 925 tests)

| Step | New tests | Cumulative | What's tested |
|---|---|---|---|
| P6-TS1/SX1 | +19 | 944 | parse TS/JS/Python, cache, invalidate, error codes; symbol extraction |
| P6-IG1 | +17 | 961 | import resolution, require/dynamic import, re-export, reverse edges, Dart skip |
| P6-AS1 | +11 | 972 | transitive closure, diamond, cycle, determinism, IG1+AS1 integration |
| P6-CR1 | +10 | 982 | symbol injection, import-distance ranking, CX-002/003, SX1+IG1 integration |
| P6-I1 | +7 | **989** | full E2E: TS1→SX1→IG1→AS1→CR1 + VR-004 scope promotion + determinism |

---

## Invariant coverage — Phase 6 (no new invariants; existing ones enriched)

| Invariant | How Phase 6 enriches it |
|---|---|
| VR-004 | `computeAffectedClosureFromGraph` gives a correct AFFECTED_CLOSURE; E2E shows AFFECTED_DIRECT → AFFECTED_CLOSURE/FULL promotion on a real graph. |
| VR-010 | Closure BFS and retriever ordering are deterministic — sorted seed + sorted neighbours; tested explicitly. |
| CX-002 | Symbol-definition context items carry full provenance. |
| CX-003 | Symbol items use `workspace_symbol` source → `untrusted` trust (verified). |
| RC-003 | Import graph now exists to supply a future `relevantFilesChanged` signal (wiring deferred — see Deferred). |

---

## Cross-platform

| Environment | Node | Result | Tests |
|---|---|---|---|
| Windows 11 (local) | 20.18.1 | ✅ PASS | 989/989 |
| WSL2 Ubuntu 24.04 (local, `npm ci`) | 20.18.1 | ✅ PASS | 989/989 |

The WASM grammar approach (web-tree-sitter) runs identically on both platforms —
code-intelligence tests (36/36) pass on Linux with the same grammar files, with
no native addon to compile.

---

## Honest scope notes

- **web-tree-sitter pinned to 0.20.8.** The grammars in `tree-sitter-wasms@0.1.13`
  (the latest release) are built for the tree-sitter 0.20.x ABI (language version
  13–14). The modern web-tree-sitter (0.25+) rejects them with a dylink metadata
  error, so the runtime is held on the 0.20 line to match the grammars. Upgrading
  to a newer ABI is a single "lift the floor" task when newer prebuilt grammars
  are available; it is isolated inside `TreeSitterAdapter`.

- **Dart is parked.** `TS/JS/TSX/Python` grammars load on 0.20.8; the Dart grammar
  is language version 15 (outside the 13–14 range) and does **not** load. Dart is
  therefore omitted from `ImportGraphBuilder`'s `LANGUAGE_PACKS`; a Dart file
  degrades gracefully (no edges, no crash). Adding Dart = one language-pack entry
  once a compatible grammar exists — no algorithm change.

- **SymbolExtractor coverage.** SX1 extracts functions, classes, interfaces, type
  aliases, enums, and arrow-function const bindings. A plain value binding
  (`export const ZERO = 0`) is intentionally **not** a symbol kind yet; the E2E
  asserts the actual behaviour rather than overclaiming.

- **agent-core stays infra-free.** AS1 and CR1 live in `agent-core` and must not
  depend on the infrastructure TreeSitter layer. Both take the import graph and
  symbols as **plain data** (`ReadonlyMap` / `RetrievedSymbol[]`); the caller runs
  SX1/IG1 and feeds results in. dependency-cruiser confirms 0 violations.

---

## What Phase 6 does NOT deliver

- **P6-LX1 LspAdapter** — deferred to Phase 7 (see Deferred section).
- **`relevantFilesChanged` wiring into NoProgressDetector** — the import graph that
  feeds this signal now exists; connecting it into recovery is a Phase 7 follow-up.
- **Dart / additional languages** — parked on grammar ABI; one pack entry each later.
- Memory / RAG (Phase 7). Multi-agent (Phase 8+). Semantic diffing (future).

---

## Deferred to Phase 7

### P6-LX1 — LspAdapter (was optional in §2.1 / §4.5)

- **Status:** Deferred (not started). Not an exit-criterion component.
- **Why deferred:** requires an external process (`typescript-language-server`),
  which cannot be verified headless+cross-platform under the project's Windows+WSL
  discipline without flaky CI; roadmap §7 flagged this risk and marked LX1 optional.
  The Phase 6 exit criteria (§6) are met without it.
- **Definition of done (for Phase 7):**
  1. `LspAdapter` with `start()`, `stop()`, `definition()`, `references()`, `symbols()`
     over LSP stdio; TypeScript LSP first.
  2. Lifecycle: start on first use, reuse session, stop on workspace close.
  3. CI-safe: skip LSP tests when the server binary is absent (no hard dependency).
  4. Feeds the SAME retriever interface as SX1/IG1 (symbols/references as plain data)
     — no change required to `CodeIntelligenceRetriever`, which already consumes
     symbols and graph edges abstractly.
- **Architectural readiness:** CR1 was built to accept symbols/graph as plain data,
  so LSP plugs in as an additional source with no rework of existing Phase 6 code.

---

## Anti-criteria — confirmed NOT violated

- `agent-core` has no dependency on `infrastructure` — depcruise 0 violations.
- `computeAffectedClosureFromGraph` is pure: no I/O, no clock, no model output (VR-010).
- Symbol/file context items from the workspace are always `untrusted` (CX-003).
- Context never becomes runtime authority — it is data for the model only (CX-005).
- Tree-sitter failures degrade gracefully (unsupported language/grammar → no crash).
- Determinism: the whole chain produces identical output across runs (tested).

---

## Signed by

- Developer: _______________
- Reviewer: _______________
- Architect: _______________

Phase 6: COMPLETE (P6-LX1 deferred to Phase 7) — CI green + human peer + architecture review pending.
