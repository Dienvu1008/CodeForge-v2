// MI-004 — The MissionIntelligence stage does NOT mutate the Goal and does NOT create Tasks or
// Graph. Only the Planner + GraphCommit create the Graph (GI-009). Proven two ways:
//   (1) At the stage: the only side-effecting dependency it has is an EventLog; the produced
//       Mission references the SAME goalId and does not alter the goal's description/constraints.
//   (2) At the orchestrator seam: when the stage BLOCKs, NO graph commit happens (planner and
//       graphCommitService are never called); when it proceeds, the Graph is produced by the
//       planner as always — never by the stage.
import { describe, it, expect } from 'vitest';
import {
  MissionIntelligence,
  SessionOrchestrator,
  type MissionStage,
  type Goal,
  type DomainEvent,
  type EventLog,
  type EventFilter,
} from '@codeforge/agent-core';
import { makeOrchestratorFakes, GOAL, REVISION } from './_orchestrator-fakes.js';

class RecordingEventLog implements EventLog {
  public readonly appended: DomainEvent[] = [];
  async append(e: DomainEvent): Promise<void> { this.appended.push(e); }
  async *stream(): AsyncIterable<DomainEvent> { for (const e of this.appended) yield e; }
  async query(_f: EventFilter): Promise<readonly DomainEvent[]> { return this.appended; }
}

const GOAL_WITH_CONSTRAINTS: Goal = {
  goalId: 'G-7', version: 3, description: 'add a feature to the service',
  constraints: [{ kind: 'scope', description: 'TypeScript only', enforceable: true } as never],
  acceptanceCriteria: [{ criterionId: 'a', description: 'done', mandatory: true }],
  createdAt: '2026-01-01T00:00:00.000Z', createdBy: 'user',
};

describe('MI-004 — stage does not mutate the Goal or create Tasks/Graph', () => {
  it('the produced Mission references the Goal unchanged (same id/version-source/description)', async () => {
    const events = new RecordingEventLog();
    let n = 0;
    const stage = new MissionIntelligence({ events, now: () => 't', newId: () => `id-${++n}` });

    const out = await stage.analyze('S', GOAL_WITH_CONSTRAINTS);

    expect(out.mission.goalId).toBe('G-7');
    expect(out.mission.userGoal).toBe(GOAL_WITH_CONSTRAINTS.description);
    // The goal object itself is not mutated (still the same values the caller passed in).
    expect(GOAL_WITH_CONSTRAINTS.description).toBe('add a feature to the service');
    expect(GOAL_WITH_CONSTRAINTS.constraints).toHaveLength(1);
    // Constraints/acceptance are copied by reference into the mission (read-only mirror).
    expect(out.mission.constraints).toBe(GOAL_WITH_CONSTRAINTS.constraints);
    // The ONLY side effect is appended events — all 'mission' aggregate, never task/graph.
    expect(events.appended.length).toBeGreaterThan(0);
    expect(events.appended.every((e) => e.aggregate.kind === 'mission')).toBe(true);
  });

  it('orchestrator: a BLOCK commits NO graph (planner + graphCommit never called)', async () => {
    const f = makeOrchestratorFakes();
    const stage: MissionStage = { async analyze() { return { proceed: false, blockers: ['blocked'] }; } };
    const orch = new SessionOrchestrator({ ...f.deps, missionStage: stage, now: f.now, nextId: f.nextId });

    await orch.run({ sessionId: 'S', goal: GOAL, revision: REVISION, graphVersion: 1 });

    expect(f.plannerCalls).toBe(0);
    expect(f.commits).toBe(0);  // no Graph produced by the stage (MI-004 / GI-009)
  });

  it('orchestrator: when proceeding, the Graph is produced by the planner (never the stage)', async () => {
    const f = makeOrchestratorFakes();
    const stage: MissionStage = { async analyze() { return { proceed: true, blockers: [] }; } };
    const orch = new SessionOrchestrator({ ...f.deps, missionStage: stage, now: f.now, nextId: f.nextId });

    await orch.run({ sessionId: 'S', goal: GOAL, revision: REVISION, graphVersion: 1 });

    expect(f.plannerCalls).toBe(1);
    expect(f.commits).toBe(1);  // the one commit came from the planner path, as always
  });
});
