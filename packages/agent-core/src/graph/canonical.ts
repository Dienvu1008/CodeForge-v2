// Graph canonical form (P1-G1) — GRAPH_PROTOCOL §2.3.
//
// canonicalHash = hash( sort(nodes by taskId), sort(edges by (fromTaskId, toTaskId, kind)) ).
// This module builds the deterministic CANONICAL STRING to hash — a pure, crypto-free
// function so it can live in agent-core (the actual blake3 hashing is an infrastructure
// adapter, keeping @noble/hashes out of the domain, DC-002).
//
// The canonical form intentionally ignores version/timestamps/mutationId: it captures the
// STRUCTURE (which tasks + which dependency edges), so two graphs with identical structure
// hash identically regardless of how they were built (GI-001 drift detection, audit).
import type { GraphNode, GraphEdge } from './types.js';

/** Escape field separators so distinct structures can never collide. */
function esc(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/\t/g, '\\t').replace(/\n/g, '\\n');
}

/**
 * Build the canonical string for a graph's structure. Deterministic: nodes sorted by
 * taskId; edges sorted by (fromTaskId, toTaskId, kind). Node/edge identity fields that
 * are NOT part of structure (addedInVersion, edgeId) are excluded so the hash reflects
 * logical structure only.
 */
export function canonicalGraphForm(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
): string {
  const nodeLines = [...nodes]
    .map((n) => n.taskId)
    .sort()
    .map((taskId) => `N\t${esc(taskId)}`);

  const edgeLines = [...edges]
    .map((e) => ({ from: e.fromTaskId, to: e.toTaskId, kind: e.kind }))
    .sort((a, b) => {
      if (a.from !== b.from) return a.from < b.from ? -1 : 1;
      if (a.to !== b.to) return a.to < b.to ? -1 : 1;
      return a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0;
    })
    .map((e) => `E\t${esc(e.from)}\t${esc(e.to)}\t${esc(e.kind)}`);

  // Section markers keep the node block unambiguous from the edge block.
  return ['#nodes', ...nodeLines, '#edges', ...edgeLines].join('\n');
}

/** The canonical hashing boundary. Impl (blake3) lives in infrastructure. */
export interface GraphHasher {
  /** Hash a graph's structure (nodes + edges) → hex digest. */
  hash(nodes: readonly GraphNode[], edges: readonly GraphEdge[]): string;
}
