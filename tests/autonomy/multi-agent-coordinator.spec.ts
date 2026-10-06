// P8-MA1 — MultiAgentCoordinator.coordinate (deterministic sub-agent → proposal merge).
import { describe, it, expect } from 'vitest';
import {
  MultiAgentCoordinator,
  type SubAgentResult,
  type GraphMutation,
  type Provenance,
  type ProvenanceSourceKind,
} from '@codeforge/agent-core';

function provenance(kind: ProvenanceSourceKind, id: string): Provenance {
  return { provenanceId: `pv-${id}`, source: { kind, id }, inputs: [], reason: 'r', at: 't' };
}

function mutation(id: string, status: GraphMutation['status']): GraphMutation {
  return {
    mutationId: id, sessionId: 'S', baseVersion: 0, operations: [],
    proposedBy: 'planner', reason: 'r',
    provenance: provenance('model', id),
    createdAt: 't', status,
  };
}

function result(
  agentId: string,
  kind: ProvenanceSourceKind,
  suggestions: SubAgentResult['suggestions'],
): SubAgentResult {
  return { agentId, provenance: provenance(kind, agentId), suggestions };
}

const coord = new MultiAgentCoordinator();

describe('P8-MA1 coordinate — merge + ordering', () => {
  it('merges suggestions from several sub-agents into proposals', () => {
    const out = coord.coordinate([
      result('planner', 'model', [{ kind: 'graph', mutation: mutation('m1', 'PROPOSED') }]),
      result('executor', 'model', [{ kind: 'completion', taskId: 'T1', rationale: 'built' }]),
    ]);
    expect(out.proposals).toHaveLength(2);
    expect(out.rejected).toEqual([]);
  });

  it('is deterministic regardless of sub-agent arrival order (sorted by agentId)', () => {
    const a = result('a', 'model', [{ kind: 'completion', taskId: 'T', rationale: 'x' }]);
    const b = result('b', 'model', [{ kind: 'completion', taskId: 'T', rationale: 'y' }]);
    const forward = coord.coordinate([a, b]);
    const reversed = coord.coordinate([b, a]);
    expect(forward.proposals.map((p) => p.agentId)).toEqual(['a', 'b']);
    expect(reversed.proposals.map((p) => p.agentId)).toEqual(['a', 'b']);
  });

  it('empty results → empty outcome', () => {
    const out = coord.coordinate([]);
    expect(out.proposals).toEqual([]);
    expect(out.rejected).toEqual([]);
  });

  it('does not mutate its input', () => {
    const results = [result('a', 'model', [{ kind: 'completion', taskId: 'T', rationale: 'x' }])];
    const snapshot = JSON.stringify(results);
    coord.coordinate(results);
    expect(JSON.stringify(results)).toEqual(snapshot);
  });
});

describe('P8-MA1 coordinate — proposals carry no authority (AU-002/007)', () => {
  it('forces every graph suggestion to status PROPOSED', () => {
    // Even a PROPOSED mutation comes out PROPOSED — the coordinator never pre-decides.
    const out = coord.coordinate([
      result('planner', 'model', [{ kind: 'graph', mutation: mutation('m1', 'PROPOSED') }]),
    ]);
    const p = out.proposals[0]!;
    expect(p.kind).toBe('graph');
    if (p.kind === 'graph') expect(p.mutation.status).toBe('PROPOSED');
  });

  it('rejects a graph mutation that arrives already VALIDATED or COMMITTED', () => {
    const out = coord.coordinate([
      result('x', 'model', [{ kind: 'graph', mutation: mutation('m1', 'COMMITTED') }]),
    ]);
    expect(out.proposals).toEqual([]);
    expect(out.rejected).toEqual([{ agentId: 'x', reason: 'already-committed' }]);
  });

  it('rejects a result forging runtime authority', () => {
    const out = coord.coordinate([
      result('rogue', 'runtime', [{ kind: 'completion', taskId: 'T', rationale: 'done' }]),
    ]);
    expect(out.proposals).toEqual([]);
    expect(out.rejected).toEqual([{ agentId: 'rogue', reason: 'authority-source' }]);
  });

  it('rejects a result forging user authority', () => {
    const out = coord.coordinate([
      result('rogue', 'user', [{ kind: 'completion', taskId: 'T', rationale: 'done' }]),
    ]);
    expect(out.rejected).toEqual([{ agentId: 'rogue', reason: 'authority-source' }]);
  });

  it('a completion suggestion is only a proposal — carries taskId + rationale, nothing executable', () => {
    const out = coord.coordinate([
      result('critic', 'model', [{ kind: 'completion', taskId: 'T7', rationale: 'looks done' }]),
    ]);
    const p = out.proposals[0]!;
    expect(p.kind).toBe('completion');
    if (p.kind === 'completion') {
      expect(p.taskId).toBe('T7');
      expect(Object.keys(p).sort()).toEqual(['agentId', 'kind', 'rationale', 'taskId']);
    }
  });
});
