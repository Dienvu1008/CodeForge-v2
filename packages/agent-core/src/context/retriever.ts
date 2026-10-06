// Retriever — CONTEXT_SPEC §4, P2-CX1 / P6-CR1.
//
// Phase 2 baseline: diff-based workspace files + direct-inject for task/goal/graph.
// Phase 6 (P6-CR1) upgrade — code intelligence:
//   - Injects symbol definitions (from SymbolExtractor) for changed/affected files.
//   - Ranks workspace files by import distance from the changed set.
// Phase 7 (P7-CR2) upgrade — memory / RAG:
//   - Injects memory records (from MemoryRetriever) and RAG chunks (from the Doc/
//     Repo retrievers) as untrusted, lower-priority context evidence (ME-001/002).
//
// Decoupling: symbols, import reverse-edges, memory records and RAG items are all
// passed in as PLAIN DATA. The retriever stays in agent-core and does NOT depend on
// the infrastructure layer. The caller runs SX1/IG1/MemoryStore/RAG and feeds the
// results in — the same pattern used for workspaceFiles / changedPaths.
//
// CX-002: every item has provenance.
// CX-003: workspace content (files + symbols + memory + RAG) is marked untrusted.
// CX-005 / ME-001: context (incl. memory) is evidence only, never runtime authority.
// CX-006: snapshot records workspaceRevision.
// Determinism: same request → same candidate set (sorted, no randomness).
import type {
  ContextItem,
  ContextItemKind,
  ContextSource,
  TrustLevel,
  BuildReason,
} from '../domain/context.js';
import type { WorkspaceRevision } from '../domain/workspace-revision.js';
import type { Task } from '../domain/task.js';
import type { Goal } from '../domain/goal.js';
import type { Provenance } from '../domain/provenance.js';
import type { MemoryRecord, RagItem } from '../domain/memory.js';
import { countTokens } from './token-counter.js';

// ── RetrievedSymbol ───────────────────────────────────────────────────────────

/**
 * A code symbol surfaced for context, decoupled from the infrastructure
 * SymbolExtractor's CodeSymbol. The caller maps SX1 output into this shape and
 * tags each symbol with the file it came from.
 */
export interface RetrievedSymbol {
  /** Canonical project-relative path of the file the symbol is defined in. */
  readonly file:      string;
  readonly name:      string;
  readonly kind:      string;
  readonly startLine: number; // 0-indexed
  readonly endLine:   number; // 0-indexed
  readonly exported:  boolean;
}

// ── RetrieveRequest ───────────────────────────────────────────────────────────

export interface RetrieveRequest {
  readonly sessionId: string;
  readonly taskId?: string;
  readonly taskRunId?: string;
  readonly workspaceRevision: WorkspaceRevision;
  readonly buildReason: BuildReason;
  /** Concrete data to inject directly (pinned, highest priority). */
  readonly taskData?:  Task;
  readonly goalData?:  Goal;
  /** All workspace file paths + contents available for retrieval. */
  readonly workspaceFiles?: ReadonlyMap<string, string>;
  /** Paths changed in the current taskRun (diff-based affected set). */
  readonly changedPaths?: readonly string[];
  /** Graph summary text (optional). */
  readonly graphSummary?: string;
  /** Failure evidence text (optional). */
  readonly failureEvidence?: string;
  /**
   * P6-CR1: code symbols (from SymbolExtractor), each tagged with its file.
   * Symbols in changed/affected files are injected as symbol_definition items.
   */
  readonly symbols?: readonly RetrievedSymbol[];
  /**
   * P6-CR1: import graph reverse edges (file -> files that import it, from
   * ImportGraphBuilder). Used to rank workspace files by import distance from
   * the changed set. When absent, ranking falls back to alphabetical (Phase 2).
   */
  readonly importReverseEdges?: ReadonlyMap<string, ReadonlySet<string>>;
  /**
   * P7-CR2: memory records (from MemoryRetriever), already ranked by the caller.
   * Injected as untrusted `memory` context items (ME-001/002).
   */
  readonly memoryRecords?: readonly MemoryRecord[];
  /**
   * P7-CR2: RAG chunks (from Doc/Repo retrievers), already ranked by the caller.
   * Injected as untrusted context items that record their source path (ME-005).
   */
  readonly ragItems?: readonly RagItem[];
  /** Hard limit on candidate items returned. */
  readonly maxItems?: number;
}

// ── Retriever ─────────────────────────────────────────────────────────────────

export interface RetrieverDeps {
  readonly nextId: () => string;
  readonly now:    () => string;
}

export class Retriever {
  constructor(private readonly deps: RetrieverDeps) {}

  /**
   * Retrieve candidate ContextItems for a build request.
   * Order: pinned items first (task/goal/graph), then changed files, then other files.
   * Deterministic: items sorted by (pinned desc, priority desc, path asc).
   */
  retrieve(request: RetrieveRequest): readonly ContextItem[] {
    const items: ContextItem[] = [];

    // 1. Task definition (pinned, trusted, priority 100).
    if (request.taskData !== undefined) {
      items.push(this.makeItem({
        kind:      'task_definition',
        content:   this.taskContent(request.taskData),
        source:    { kind: 'task', artifactId: request.taskData.taskId },
        trust:     'trusted',
        reason:    'task to execute',
        priority:  100,
        pinned:    true,
        sessionId: request.sessionId,
      }));
    }

    // 2. Goal description (pinned, trusted, priority 100).
    if (request.goalData !== undefined) {
      items.push(this.makeItem({
        kind:      'acceptance_criteria',
        content:   this.goalContent(request.goalData),
        source:    { kind: 'goal', artifactId: request.goalData.goalId },
        trust:     'trusted',
        reason:    'goal definition',
        priority:  100,
        pinned:    true,
        sessionId: request.sessionId,
      }));
    }

    // 3. Graph summary (pinned, trusted, priority 85).
    if (request.graphSummary !== undefined && request.graphSummary.length > 0) {
      items.push(this.makeItem({
        kind:      'graph_summary',
        content:   request.graphSummary,
        source:    { kind: 'graph' },
        trust:     'trusted',
        reason:    'task graph context',
        priority:  85,
        pinned:    true,
        sessionId: request.sessionId,
      }));
    }

    // 4. Failure evidence (pinned, untrusted, priority 90).
    if (request.failureEvidence !== undefined && request.failureEvidence.length > 0) {
      items.push(this.makeItem({
        kind:      'failure_evidence',
        content:   request.failureEvidence,
        source:    { kind: 'artifact' },
        trust:     'untrusted',
        reason:    'failure evidence for analysis',
        priority:  90,
        pinned:    true,
        sessionId: request.sessionId,
      }));
    }

    // 5. Changed workspace files (untrusted, priority 80).
    const changedSet = new Set(request.changedPaths ?? []);
    for (const path of [...changedSet].sort()) {
      const content = request.workspaceFiles?.get(path) ?? '';
      if (content.length === 0) continue;
      items.push(this.makeItem({
        kind:      'file_full',
        content,
        source:    {
          kind: 'workspace_file',
          path,
          revisionId: request.workspaceRevision.revisionId,
        },
        trust:     'untrusted',
        reason:    'directly changed in task run',
        priority:  80,
        pinned:    false,
        sessionId: request.sessionId,
      }));
    }

    // 5.5. Symbol definitions for changed/affected files (P6-CR1).
    //      Untrusted (workspace_symbol), priority 60 — above fill-in files,
    //      below the changed files themselves. Only symbols whose file is in the
    //      changed set (or, when a graph is available, its affected closure).
    if (request.symbols !== undefined && request.symbols.length > 0) {
      const relevantFiles = this.affectedFiles(changedSet, request.importReverseEdges);
      const relevantSymbols = request.symbols
        .filter((s) => relevantFiles.has(s.file))
        .sort(compareSymbols);
      for (const sym of relevantSymbols) {
        items.push(this.makeItem({
          kind:      'symbol_definition',
          content:   this.symbolContent(sym),
          source:    {
            kind: 'workspace_symbol',
            path: sym.file,
            symbolName: sym.name,
            revisionId: request.workspaceRevision.revisionId,
          },
          trust:     'untrusted',
          reason:    'symbol in changed/affected file',
          priority:  60,
          pinned:    false,
          sessionId: request.sessionId,
        }));
      }
    }

    // 6. Other workspace files (untrusted, priority 40 — fill-in).
    //    P6-CR1: rank by import distance from the changed set when a reverse-edge
    //    graph is available (closer importers first); fall back to alphabetical.
    if (request.workspaceFiles !== undefined) {
      const maxItems = request.maxItems ?? 50;
      const ranked = this.rankOtherFiles(
        request.workspaceFiles,
        changedSet,
        request.importReverseEdges,
      );
      for (const path of ranked) {
        const content = request.workspaceFiles.get(path) ?? '';
        if (content.length === 0) continue;
        if (items.length >= maxItems) break;
        const distance = this.importDistance(path, changedSet, request.importReverseEdges);
        items.push(this.makeItem({
          kind:      'file_full',
          content,
          source:    {
            kind: 'workspace_file',
            path,
            revisionId: request.workspaceRevision.revisionId,
          },
          trust:     'untrusted',
          reason:    distance === null
            ? 'workspace context'
            : `imports changed file (distance ${distance})`,
          // Closer files rank higher: distance 1 → 49, 2 → 48, ... capped so
          // fill-in files never outrank the changed files (80) or symbols (60).
          priority:  distance === null ? 40 : Math.min(50, 51 - distance),
          pinned:    false,
          sessionId: request.sessionId,
        }));
      }
    }

    // 7. Memory records (P7-CR2) — untrusted evidence, priority 35 (below fill-in
    //    files so remembered context never outranks the current workspace). Caller
    //    supplies them already ranked by MemoryRetriever; we preserve that order.
    if (request.memoryRecords !== undefined) {
      for (const mem of request.memoryRecords) {
        items.push(this.makeItem({
          kind:      'memory',
          content:   mem.content,
          source:    { kind: 'memory', artifactId: mem.memoryId },
          trust:     'untrusted',
          reason:    `memory (${mem.kind})`,
          priority:  35,
          pinned:    false,
          sessionId: request.sessionId,
        }));
      }
    }

    // 8. RAG chunks (P7-CR2) — untrusted, priority 30. Each records its source
    //    path (ME-005). Caller supplies them already ranked by the RAG retrievers.
    if (request.ragItems !== undefined) {
      for (const rag of request.ragItems) {
        items.push(this.makeItem({
          kind:      'file_snippet',
          content:   rag.content,
          source:    {
            kind: 'workspace_file',
            path: rag.path,
            revisionId: request.workspaceRevision.revisionId,
          },
          trust:     'untrusted',
          reason:    `rag:${rag.source} ${rag.reason}`,
          priority:  30,
          pinned:    false,
          sessionId: request.sessionId,
        }));
      }
    }

    return items.slice(0, request.maxItems ?? items.length);
  }

  // ── code-intelligence helpers (P6-CR1) ──────────────────────────────────────

  /**
   * The set of files relevant for symbol injection: the changed set plus, when a
   * reverse-edge graph is given, every file that transitively imports a changed
   * file (the affected closure). Pure + deterministic.
   */
  private affectedFiles(
    changed: ReadonlySet<string>,
    reverseEdges?: ReadonlyMap<string, ReadonlySet<string>>,
  ): ReadonlySet<string> {
    if (reverseEdges === undefined) return changed;
    const visited = new Set<string>();
    const queue: string[] = [...changed].sort();
    while (queue.length > 0) {
      const file = queue.shift() as string;
      if (visited.has(file)) continue;
      visited.add(file);
      const importers = reverseEdges.get(file);
      if (importers === undefined) continue;
      for (const imp of [...importers].sort()) {
        if (!visited.has(imp)) queue.push(imp);
      }
    }
    return visited;
  }

  /**
   * Import distance (hops) from `file` to the nearest changed file via reverse
   * edges: 0 if `file` is itself changed, 1 if it directly imports a changed file,
   * etc. Returns null if there is no path (or no graph).
   */
  private importDistance(
    file: string,
    changed: ReadonlySet<string>,
    reverseEdges?: ReadonlyMap<string, ReadonlySet<string>>,
  ): number | null {
    if (changed.has(file)) return 0;
    if (reverseEdges === undefined) return null;
    // BFS outward from the changed set along reverse edges, tracking depth.
    const depth = new Map<string, number>();
    const queue: string[] = [];
    for (const c of [...changed].sort()) { depth.set(c, 0); queue.push(c); }
    let head = 0;
    while (head < queue.length) {
      const cur = queue[head++] as string;
      const d = depth.get(cur) as number;
      const importers = reverseEdges.get(cur);
      if (importers === undefined) continue;
      for (const imp of [...importers].sort()) {
        if (!depth.has(imp)) {
          depth.set(imp, d + 1);
          if (imp === file) return d + 1;
          queue.push(imp);
        }
      }
    }
    return depth.get(file) ?? null;
  }

  /**
   * Order the non-changed workspace files for fill-in. With a graph: by import
   * distance ascending (closer first), ties broken alphabetically; files with no
   * path to the changed set come last (alphabetical). Without a graph: alphabetical.
   */
  private rankOtherFiles(
    files: ReadonlyMap<string, string>,
    changed: ReadonlySet<string>,
    reverseEdges?: ReadonlyMap<string, ReadonlySet<string>>,
  ): string[] {
    const candidates = [...files.keys()].filter((p) => !changed.has(p)).sort();
    if (reverseEdges === undefined) return candidates;
    return candidates.sort((a, b) => {
      const da = this.importDistance(a, changed, reverseEdges);
      const db = this.importDistance(b, changed, reverseEdges);
      const ra = da === null ? Number.POSITIVE_INFINITY : da;
      const rb = db === null ? Number.POSITIVE_INFINITY : db;
      if (ra !== rb) return ra - rb;
      return a.localeCompare(b);
    });
  }

  private symbolContent(sym: RetrievedSymbol): string {
    const exp = sym.exported ? 'exported ' : '';
    return `${exp}${sym.kind} ${sym.name} (${sym.file}:${sym.startLine + 1}-${sym.endLine + 1})`;
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  private makeItem(opts: {
    kind:      ContextItemKind;
    content:   string;
    source:    ContextSource;
    trust:     TrustLevel;
    reason:    string;
    priority:  number;
    pinned:    boolean;
    sessionId: string;
  }): ContextItem {
    const provenance: Provenance = {
      provenanceId: this.deps.nextId(),
      source:       { kind: 'runtime', id: opts.source.kind },
      inputs:       [],
      reason:       opts.reason,
      at:           this.deps.now(),
    };
    return {
      itemId:      this.deps.nextId(),
      kind:        opts.kind,
      source:      opts.source,
      content:     opts.content,
      tokenCount:  countTokens(opts.content),
      trust:       opts.trust,
      reason:      opts.reason,
      provenance,
      priority:    opts.priority,
      pinned:      opts.pinned,
      truncated:   false,
    };
  }

  private taskContent(task: Task): string {
    const lines: string[] = [
      `Task: ${task.description}`,
    ];
    if (task.acceptanceCriteria.length > 0) {
      lines.push('Acceptance criteria:');
      for (const ac of task.acceptanceCriteria) {
        lines.push(`  - ${ac.description}`);
      }
    }
    if (task.constraints.length > 0) {
      lines.push('Constraints:');
      for (const c of task.constraints) {
        lines.push(`  - ${c.description}`);
      }
    }
    return lines.join('\n');
  }

  private goalContent(goal: Goal): string {
    const lines: string[] = [`Goal: ${goal.description}`];
    if (goal.acceptanceCriteria.length > 0) {
      lines.push('Acceptance criteria:');
      for (const ac of goal.acceptanceCriteria) {
        lines.push(`  - ${ac.description}`);
      }
    }
    return lines.join('\n');
  }
}

// ── module helpers ──────────────────────────────────────────────────────────

/** Deterministic ordering of symbols: by file, then start line, then name. */
function compareSymbols(a: RetrievedSymbol, b: RetrievedSymbol): number {
  if (a.file !== b.file) return a.file.localeCompare(b.file);
  if (a.startLine !== b.startLine) return a.startLine - b.startLine;
  return a.name.localeCompare(b.name);
}
