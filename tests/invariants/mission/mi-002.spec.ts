// MI-002 — Flag-off parity. When the MissionIntelligence stage is NOT wired into the
// SessionOrchestrator (`--mission off`), the orchestrator behaves exactly as before Phase 12:
// no MISSION_* events are emitted and planning proceeds normally. Wiring a stage that returns
// proceed=true changes control flow in NO way (the planner is still called, no AWAITING_HUMAN).
//
// This is proven at the orchestrator seam with lightweight fakes that record calls — the
// invariant is about control flow (planner called, session not escalated), not persistence.
import { describe, it, expect } from 'vitest';
import {
  SessionOrchestrator,
  type MissionStage,
  type Goal,
  type WorkspaceRevision,
  type GraphMutation,
} from '@codeforge/agent-core';
import { makeOrchestratorFakes, GOAL, REVISION } from './_orchestrator-fakes.js';

describe('MI-002 — mission flag-off parity', () => {
  it('without a mission stage: planner is called, session completes, no MISSION_* events', async () => {
    const f = makeOrchestratorFakes();
    const orch = new SessionOrchestrator({ ...f.deps, now: f.now, nextId: f.nextId });

    const result = await orch.run({ sessionId: 'S', goal: GOAL, revision: REVISION, graphVersion: 1 });

    expect(f.plannerCalls).toBe(1);                 // planning proceeded
    expect(result.sessionState).toBe('COMPLETED');  // normal terminal state
    expect(f.events.filter((t) => t.startsWith('MISSION_'))).toHaveLength(0);
  });

  it('with a stage returning proceed=true: identical control flow (planner still called)', async () => {
    const f = makeOrchestratorFakes();
    const stage: MissionStage = { async analyze() { return { proceed: true, blockers: [] }; } };
    const orch = new SessionOrchestrator({ ...f.deps, missionStage: stage, now: f.now, nextId: f.nextId });

    const result = await orch.run({ sessionId: 'S', goal: GOAL, revision: REVISION, graphVersion: 1 });

    expect(f.plannerCalls).toBe(1);
    expect(result.sessionState).toBe('COMPLETED');
  });

  // Guard: the fakes themselves represent a valid empty-plan run (sanity for the parity claim).
  it('fake planner returns an empty mutation (deterministic no-op plan)', async () => {
    const f = makeOrchestratorFakes();
    const m: GraphMutation = await f.deps.planner.plan('S', GOAL as Goal, { version: 1, nodes: [], edges: [] } as never, REVISION as WorkspaceRevision);
    expect(m.operations).toEqual([]);
  });
});
