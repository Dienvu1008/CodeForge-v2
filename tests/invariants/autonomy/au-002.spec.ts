// AU-002 — Multi-agent coordination không tạo authority mới; vẫn chịu TaskGraph + Verification.
//
// Enforced by MultiAgentCoordinator.coordinate (P8-MA1): sub-agent output is merged as
// PROPOSALS, never committed. A graph suggestion always leaves the coordinator with
// status 'PROPOSED', so the graph validator (GR-5) + GraphCommitService (GI-009) remain
// the only authority that commits it. A completion suggestion is advisory — TI-005 /
// CompletionGate still decides. The coordinator rejects any result that arrives already
// claiming authority (committed mutation, or a runtime/user-sourced result).
import { describe, it, expect } from 'vitest';
import {
  MultiAgentCoordinator,
  type SubAgentResult,
  type GraphMutation,
  type Provenance,
} from '@codeforge/agent-core';

function prov(kind: Provenance['source']['kind'], id: string): Provenance {
  return { provenanceId: `pv-${id}`, source: { kind, id }, inputs: [], reason: 'r', at: 't' };
}
function mutation(status: GraphMutation['status']): GraphMutation {
  return {
    mutationId: 'm', sessionId: 'S', baseVersion: 0, operations: [],
    proposedBy: 'planner', reason: 'r', provenance: prov('model', 'm'),
    createdAt: 't', status,
  };
}
function result(agentId: string, s: SubAgentResult['suggestions'], kind: Provenance['source']['kind'] = 'model'): SubAgentResult {
  return { agentId, provenance: prov(kind, agentId), suggestions: s };
}

const coord = new MultiAgentCoordinator();

describe('AU-002 — multi-agent coordination creates no new authority', () => {
  it('a sub-agent graph suggestion stays PROPOSED (GI-009 commits, not the coordinator)', () => {
    const out = coord.coordinate([result('planner', [{ kind: 'graph', mutation: mutation('PROPOSED') }])]);
    const p = out.proposals[0]!;
    expect(p.kind).toBe('graph');
    if (p.kind === 'graph') expect(p.mutation.status).toBe('PROPOSED');
  });

  it('a graph mutation that arrives already COMMITTED is rejected (no bypass of the committer)', () => {
    const out = coord.coordinate([result('x', [{ kind: 'graph', mutation: mutation('COMMITTED') }])]);
    expect(out.proposals).toEqual([]);
    expect(out.rejected).toEqual([{ agentId: 'x', reason: 'already-committed' }]);
  });

  it('task completion is only proposed — the coordinator never satisfies CompletionGate (TI-005)', () => {
    const out = coord.coordinate([result('executor', [{ kind: 'completion', taskId: 'T1', rationale: 'built' }])]);
    const p = out.proposals[0]!;
    expect(p.kind).toBe('completion');
    // Output is advisory data (taskId + rationale) — nothing that marks a task PASSED.
    if (p.kind === 'completion') expect(p.taskId).toBe('T1');
  });
});
