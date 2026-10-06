// AU-007 — Sub-agent output là proposal, không phải authority.
//
// Enforced by MultiAgentCoordinator.coordinate (P8-MA1), mirroring MG-006 (model output
// is advisory) / TI-007 (priority is a proposal). A sub-agent is a 'model' source; a
// result forging 'runtime' or 'user' authority is rejected. A completion suggestion is
// carried as a CompletionProposal (taskId + rationale only) — it can never, by itself,
// move a task to PASSED (that stays with CompletionGate / TI-005).
import { describe, it, expect } from 'vitest';
import {
  MultiAgentCoordinator,
  type SubAgentResult,
  type Provenance,
} from '@codeforge/agent-core';

function prov(kind: Provenance['source']['kind'], id: string): Provenance {
  return { provenanceId: `pv-${id}`, source: { kind, id }, inputs: [], reason: 'r', at: 't' };
}
function result(agentId: string, kind: Provenance['source']['kind'], s: SubAgentResult['suggestions']): SubAgentResult {
  return { agentId, provenance: prov(kind, agentId), suggestions: s };
}

const coord = new MultiAgentCoordinator();

describe('AU-007 — sub-agent output is a proposal, never authority', () => {
  it('a sub-agent proposal cannot complete a task — it is only a completion proposal', () => {
    const out = coord.coordinate([
      result('executor', 'model', [{ kind: 'completion', taskId: 'T9', rationale: 'tests pass' }]),
    ]);
    const p = out.proposals[0]!;
    expect(p.kind).toBe('completion');
    if (p.kind === 'completion') {
      // Pure advisory data — no PASSED flag, no report, nothing executable.
      expect(Object.keys(p).sort()).toEqual(['agentId', 'kind', 'rationale', 'taskId']);
    }
  });

  it('a sub-agent cannot forge runtime authority (rejected as authority-source)', () => {
    const out = coord.coordinate([
      result('rogue', 'runtime', [{ kind: 'completion', taskId: 'T', rationale: 'done' }]),
    ]);
    expect(out.proposals).toEqual([]);
    expect(out.rejected).toEqual([{ agentId: 'rogue', reason: 'authority-source' }]);
  });

  it('a sub-agent cannot forge user authority either', () => {
    const out = coord.coordinate([
      result('rogue', 'user', [{ kind: 'completion', taskId: 'T', rationale: 'done' }]),
    ]);
    expect(out.rejected).toEqual([{ agentId: 'rogue', reason: 'authority-source' }]);
  });
});
