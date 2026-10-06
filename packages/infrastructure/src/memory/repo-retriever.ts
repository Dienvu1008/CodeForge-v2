// RepoRetriever — P7-RAG1. Local repository code retrieval (RAG, read-only).
//
// Surfaces code chunks relevant to a seed set (e.g. changed files) using the
// Phase 6 import graph (IG1): files are ranked by import distance to the seeds
// (closer importers first), reusing the same reverse-edge BFS as CR1/AS1. Returns
// RagItems with source path recorded (ME-005). Read-only over the provided files
// map — no network, no ToolGateway bypass (ME-007). Deterministic.
import type { RagItem } from '@codeforge/agent-core';
import { ImportGraphBuilder } from '../code-intelligence/import-graph-builder.js';
import type { TreeSitterAdapter } from '../code-intelligence/tree-sitter-adapter.js';

export interface RepoQuery {
  /** Seed files whose neighborhood is relevant (e.g. the changed set). */
  readonly seeds: readonly string[];
  /** Max files to return (ranked by closeness to the seeds). */
  readonly limit: number;
  /** Include the seed files themselves in the result (default false). */
  readonly includeSeeds?: boolean;
}

export class RepoRetriever {
  private readonly graphBuilder: ImportGraphBuilder;

  constructor(adapter: TreeSitterAdapter) {
    this.graphBuilder = new ImportGraphBuilder(adapter);
  }

  /**
   * Build the import graph over `files` and return the code chunks whose files
   * are closest (by import distance) to the seed set, as RagItems.
   */
  async retrieve(query: RepoQuery, files: ReadonlyMap<string, string>): Promise<readonly RagItem[]> {
    const graph = await this.graphBuilder.build({ files });
    const seeds = new Set(query.seeds.filter((s) => files.has(s)));
    const includeSeeds = query.includeSeeds ?? false;

    const items: RagItem[] = [];
    for (const [path, content] of files) {
      if (content.length === 0) continue;
      const distance = importDistance(path, seeds, graph.reverseEdges);
      if (distance === null) continue;              // not reachable from the seeds
      if (distance === 0 && !includeSeeds) continue; // seed itself, excluded by default
      // Closer files score higher. score = large constant - distance so ordering
      // is by proximity; ties broken by path for determinism.
      items.push({
        source: 'repo',
        path,
        content,
        score: 1000 - distance,
        reason: distance === 0
          ? 'seed file'
          : `imports seed (distance ${distance})`,
      });
    }

    items.sort((a, b) => (b.score !== a.score ? b.score - a.score : a.path.localeCompare(b.path)));
    return items.slice(0, Math.max(0, query.limit));
  }
}

// ── distance ─────────────────────────────────────────────────────────────────

/**
 * Import distance (hops) from `file` to the nearest seed via reverse edges: 0 if
 * `file` is a seed, 1 if it directly imports a seed, etc. Null if unreachable.
 * Deterministic BFS (sorted frontier) — mirrors CR1's importDistance.
 */
function importDistance(
  file: string,
  seeds: ReadonlySet<string>,
  reverseEdges: ReadonlyMap<string, ReadonlySet<string>>,
): number | null {
  if (seeds.has(file)) return 0;
  const depth = new Map<string, number>();
  const queue: string[] = [];
  for (const s of [...seeds].sort()) {
    depth.set(s, 0);
    queue.push(s);
  }
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
