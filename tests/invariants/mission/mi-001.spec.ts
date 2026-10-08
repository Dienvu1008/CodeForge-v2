// MI-001 — Mission Intelligence output is advisory, never authority. The ONLY way the stage can
// affect control flow is an ArchitectureGate BLOCK (proceed=false), which makes the orchestrator
// drive the session to AWAITING_HUMAN BEFORE planning. A proceed=true outcome (whatever the
// mission recommended) changes nothing: planning proceeds exactly as without the stage.
import { describe, it, expect } from 'vitest';
import { SessionOrchestrator, type MissionStage } from '@codeforge/agent-core';
import { makeOrchestratorFakes, GOAL, REVISION } from './_orchestrator-fakes.js';

describe('MI-001 — mission output is advisory, not authority', () => {
  it('proceed=true never alters control flow (planner still runs, no escalation)', async () => {
    const f = makeOrchestratorFakes();
    const stage: MissionStage = { async analyze() { return { proceed: true, blockers: ['advisory note only'] }; } };
    const orch = new SessionOrchestrator({ ...f.deps, missionStage: stage, now: f.now, nextId: f.nextId });

    const result = await orch.run({ sessionId: 'S', goal: GOAL, revision: REVISION, graphVersion: 1 });

    expect(result.sessionState).toBe('COMPLETED');
    expect(f.plannerCalls).toBe(1);
    expect(f.transitions).not.toContain('HUMAN_REQUIRED');
  });

  it('a gate BLOCK (proceed=false) is the ONLY control-flow effect → session AWAITING_HUMAN, no planning', async () => {
    const f = makeOrchestratorFakes();
    const stage: MissionStage = { async analyze() { return { proceed: false, blockers: ['required capability not VERIFIED: docker'] }; } };
    const orch = new SessionOrchestrator({ ...f.deps, missionStage: stage, now: f.now, nextId: f.nextId });

    const result = await orch.run({ sessionId: 'S', goal: GOAL, revision: REVISION, graphVersion: 1 });

    expect(result.sessionState).toBe('AWAITING_HUMAN');
    expect(f.transitions).toContain('HUMAN_REQUIRED');
    expect(f.plannerCalls).toBe(0);  // stopped before planning
  });

  it('a stage that throws must not break the run — it falls through to planning (advisory)', async () => {
    const f = makeOrchestratorFakes();
    const stage: MissionStage = { async analyze() { throw new Error('advisor exploded'); } };
    const orch = new SessionOrchestrator({ ...f.deps, missionStage: stage, now: f.now, nextId: f.nextId });

    const result = await orch.run({ sessionId: 'S', goal: GOAL, revision: REVISION, graphVersion: 1 });

    expect(result.sessionState).toBe('COMPLETED');
    expect(f.plannerCalls).toBe(1);
  });
});
