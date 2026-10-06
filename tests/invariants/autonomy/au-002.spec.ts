// AU-002 — Multi-agent coordination không tạo authority mới; vẫn chịu TaskGraph + Verification.
//
// Invariants-first: enforcement lands with P8-MA1 (MultiAgentCoordinator). Contract:
// sub-agents cannot commit the graph or complete a task on their own — TaskGraph
// (GI-001/GI-009) remains the only dependency authority and TI-005 still gates
// completion. Coordination fans out work; it never becomes a new authority.
import { describe, it } from 'vitest';

describe('AU-002 — multi-agent coordination creates no new authority', () => {
  it.todo('sub-agents cannot commit the TaskGraph directly (GI-009 still holds) (P8-MA1)');
  it.todo('task completion still requires Verification + CompletionGate (TI-005) (P8-MA1)');
});
