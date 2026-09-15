// Blake3GraphHasher (P1-G1) — GRAPH_PROTOCOL §2.3.
//
// Binds the pure canonical-graph form (agent-core) to blake3 (same algorithm as the
// workspace hash, C1). Deterministic + cross-platform (pure-JS @noble/hashes). Keeps
// crypto out of agent-core (DC-002).
import { blake3 } from '@noble/hashes/blake3';
import { bytesToHex } from '@noble/hashes/utils';
import { canonicalGraphForm, type GraphHasher, type GraphNode, type GraphEdge } from '@codeforge/agent-core';

export class Blake3GraphHasher implements GraphHasher {
  hash(nodes: readonly GraphNode[], edges: readonly GraphEdge[]): string {
    const canonical = canonicalGraphForm(nodes, edges);
    return bytesToHex(blake3(Buffer.from(canonical, 'utf8')));
  }
}
