// Cycle detection (P1-G2) — GRAPH_PROTOCOL §5.6, GI-004.
//
// Pure DFS 3-color cycle detection over a directed edge set. Implements the Phase 0
// CycleDetector interface. Deterministic: nodes/edges are processed in sorted order so
// the answer never depends on input ordering.
import type { GraphNode, GraphEdge, CycleDetector } from './types.js';

/** Build adjacency (from -> [to]) for a given edge kind filter. */
function adjacency(
  edges: readonly GraphEdge[],
  kinds: ReadonlySet<GraphEdge['kind']>,
): Map<string, string[]> {
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    if (!kinds.has(e.kind)) continue;
    const list = adj.get(e.fromTaskId) ?? [];
    list.push(e.toTaskId);
    adj.set(e.fromTaskId, list);
  }
  // Deterministic neighbour order.
  for (const list of adj.values()) list.sort();
  return adj;
}

/** True if the directed graph over `kinds` edges contains a cycle (DFS 3-color). */
export function hasCycleOfKinds(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
  kinds: ReadonlySet<GraphEdge['kind']>,
): boolean {
  const adj = adjacency(edges, kinds);
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();

  // Seed every referenced node (from nodes list + edge endpoints) as WHITE.
  const allNodes = new Set<string>(nodes.map((n) => n.taskId));
  for (const e of edges) {
    if (kinds.has(e.kind)) {
      allNodes.add(e.fromTaskId);
      allNodes.add(e.toTaskId);
    }
  }
  for (const id of allNodes) color.set(id, WHITE);

  // Iterative DFS to avoid stack overflow on large graphs. Visit in sorted order.
  const roots = [...allNodes].sort();
  for (const root of roots) {
    if (color.get(root) !== WHITE) continue;
    const stack: Array<{ node: string; i: number }> = [{ node: root, i: 0 }];
    color.set(root, GRAY);
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      if (!frame) break;
      const neighbours = adj.get(frame.node) ?? [];
      if (frame.i < neighbours.length) {
        const next = neighbours[frame.i] ?? '';
        frame.i += 1;
        const c = color.get(next) ?? WHITE;
        if (c === GRAY) {
          return true; // back-edge → cycle
        }
        if (c === WHITE) {
          color.set(next, GRAY);
          stack.push({ node: next, i: 0 });
        }
      } else {
        color.set(frame.node, BLACK);
        stack.pop();
      }
    }
  }
  return false;
}

/** True if any edge is a self-loop (from === to). */
export function hasSelfLoop(edges: readonly GraphEdge[]): boolean {
  return edges.some((e) => e.fromTaskId === e.toTaskId);
}

const DEPENDS_KINDS: ReadonlySet<GraphEdge['kind']> = new Set(['depends_on', 'blocks']);
const SUPERSEDES_KINDS: ReadonlySet<GraphEdge['kind']> = new Set(['supersedes']);

/**
 * DFS-based CycleDetector (GI-004). `hasCycle` treats depends_on/blocks together as the
 * dependency relation (blocks is the reverse alias, but for pure cycle presence either
 * direction that closes a loop is a cycle). supersedes cycles are checked separately.
 */
export class DfsCycleDetector implements CycleDetector {
  hasCycle(nodes: readonly GraphNode[], edges: readonly GraphEdge[]): boolean {
    if (hasSelfLoop(edges)) return true;
    if (hasCycleOfKinds(nodes, edges, DEPENDS_KINDS)) return true;
    if (hasCycleOfKinds(nodes, edges, SUPERSEDES_KINDS)) return true;
    return false;
  }
}

export { DEPENDS_KINDS, SUPERSEDES_KINDS };
