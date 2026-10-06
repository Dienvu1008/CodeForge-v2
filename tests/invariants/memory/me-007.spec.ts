// ME-007 — Memory/RAG không bypass Policy/ToolGateway để lấy dữ liệu.
//
// Invariants-first: the strongest guard is architectural and already partly in
// force — agent-core (where retrieval wiring lives) must not import infrastructure
// or network tools directly; dependency-cruiser enforces this (DC-003). Network
// RAG, when added, must route through ToolGateway + NetworkPolicy (P7-RAG1).
import { describe, it } from 'vitest';

describe('ME-007 — memory/RAG never bypass Policy/ToolGateway', () => {
  // Architectural guard DC-003 (agent-core ↛ infrastructure/tools) is enforced by
  // dependency-cruiser in the main suite; these cover the data-fetch path:
  it.todo('network RAG fetch routes through ToolGateway (P7-RAG1)');
  it.todo('RAG fetch respects NetworkPolicy (P7-RAG1)');
});
