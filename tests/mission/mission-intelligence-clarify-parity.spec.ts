// Feature: goal-clarification-gate, Property 6: Tắt cờ thì hành vi không đổi
//
// **Validates: Requirements 1.2, 2.2**
//
// Baseline choice: (b) a reference model of the Tier B1 flow, NOT "run the stage twice". Running
// the same code twice only proves determinism; it would pass even if the refactor into
// resolveAmbiguity() changed Tier B1. Instead the expected outcome is derived independently:
//   - event types = the fixed deterministic analysis sequence, plus MISSION_ASSUMPTIONS_MADE
//     exactly when the assessed level ≠ KNOWN and the advisor returned a valid clarification;
//   - assumptions = the advisor's scripted output, clamped to 6 and flattened to statements
//     (absent when there are none / the advisor failed — fail-safe).
// An extra check wires a recording gate on KNOWN/INFERRED goals: the outcome and event log must
// deep-equal the no-gate run, and the gate must never be consulted.
import { describe, it, expect } from 'vitest';
import {
  MissionIntelligence,
  AssumptionAdvisor,
  type Goal,
  type DomainEvent,
  type EventLog,
  type EventFilter,
  type ClarificationGate,
  type ClarificationOutcome,
  type MissionStageOutcome,
} from '@codeforge/agent-core';
import { FakeModel } from '@codeforge/testing';
import { mulberry32, int, bool, pick, type Rng } from './clarification-generators.js';

// ── In-memory EventLog double (same as mission-intelligence.spec.ts) ─────────────
class MemoryEventLog implements EventLog {
  public readonly events: DomainEvent[] = [];
  async append(event: DomainEvent): Promise<void> { this.events.push(event); }
  async *stream(): AsyncIterable<DomainEvent> { for (const e of this.events) yield e; }
  async query(filter: EventFilter): Promise<readonly DomainEvent[]> {
    return this.events.filter((e) => filter.type === undefined || e.type === filter.type);
  }
  types(): string[] { return this.events.map((e) => e.type); }
}

function rt() {
  let n = 0;
  return { now: () => '2026-01-02T00:00:00.000Z', newId: () => `id-${++n}` };
}

// ── Recording gate: must never be consulted on the parity paths ──────────────────
class RecordingGate implements ClarificationGate {
  public calls = 0;
  async awaitAnswers(): Promise<ClarificationOutcome> {
    this.calls++;
    return { kind: 'answered', answers: {} };
  }
}

// ── Generators ────────────────────────────────────────────────────────────────────
type GoalKind = 'vague' | 'short' | 'clear';

const VAGUE = [
  'make it better somehow', 'build something cool', 'help me with a tool that does stuff',
  'create a script that sorts things or something', 'giúp tôi làm gì đó cho dự án',
  'write a program that handles whatever comes in', 'add a thing that makes it work',
];
const SHORT = ['fix it', 'refactor', 'add tests', 'speed up', 'tidy code', 'update docs', 'fix the crash'];
const CLEAR = [
  'add an exported parseCsv(input) that returns an array of rows; for example "a,b" returns [["a","b"]]',
  'write a CLI that reads a file from stdin and prints the line count to stdout',
  'add an exported isEven(n) that returns true for even integers and must throw on NaN',
  'add an api endpoint GET /health that returns {"ok":true} with status 200',
  'fix the crash in save(): it should write the file and return the saved path',
];

function genGoal(rng: Rng, i: number): { goal: Goal; kind: GoalKind } {
  const kind = pick<GoalKind>(rng, ['vague', 'short', 'clear']);
  const description =
    kind === 'vague' ? pick(rng, VAGUE) : kind === 'short' ? pick(rng, SHORT) : pick(rng, CLEAR);
  // Vague goals never carry acceptance (⇒ score ≥ 2 ⇒ UNKNOWN). Clear goals usually do (KNOWN);
  // a clear goal WITHOUT acceptance scores exactly 1 (INFERRED).
  const withAcceptance = kind === 'clear' ? bool(rng, 0.6) : kind === 'vague' ? false : bool(rng);
  return {
    kind,
    goal: {
      goalId: `g-${i}`, version: 1, description, constraints: [],
      acceptanceCriteria: withAcceptance ? [{ criterionId: 'a', description: 'done', mandatory: true }] : [],
      createdAt: '2026-01-01T00:00:00.000Z', createdBy: 'user',
    },
  };
}

interface AdvisorScript {
  readonly response: string;
  /** The flattened statements the reference expects (empty ⇒ invalid output / no assumptions). */
  readonly expected: readonly string[];
}

function genAdvisorScript(rng: Rng): AdvisorScript {
  if (bool(rng, 0.15)) return { response: 'not json', expected: [] }; // fail-safe path
  const n = int(rng, 1, 8);
  const assumptions = Array.from({ length: n }, (_, k) => ({
    question: `q${k}`, assumption: `assume #${k} ${int(rng, 0, 999)}`, acceptance: `check #${k}`,
  }));
  return {
    response: JSON.stringify({ clarifiedGoal: 'clarified goal', assumptions }),
    expected: assumptions.slice(0, 6).map((a) => a.assumption), // MAX_ASSUMPTIONS clamp
  };
}

// ── Stage runner ──────────────────────────────────────────────────────────────────
async function runStage(goal: Goal, script: AdvisorScript, gate?: ClarificationGate) {
  const events = new MemoryEventLog();
  const gw = new FakeModel();
  gw.setResponse(/.*/, script.response);
  const stage = new MissionIntelligence({
    events, ...rt(),
    assumptionAdvisor: new AssumptionAdvisor({ gateway: gw, now: () => 't', newProvenanceId: () => 'p' }),
    ...(gate !== undefined ? { clarificationGate: gate } : {}),
  });
  const out: MissionStageOutcome = await stage.analyze('s-parity', goal);
  return { out, events };
}

const BASE_SEQUENCE = [
  'MISSION_RECEIVED',
  'MISSION_CLASSIFIED',
  'MISSION_COMPLEXITY_ESTIMATED',
  'MISSION_RISK_ASSESSED',
  'MISSION_UNCERTAINTY_ASSESSED',
  'MISSION_PLANNING_MODE_SELECTED',
];

const RUNS = 150;

describe('Property 6: Tắt cờ thì hành vi không đổi', () => {
  it('without a clarificationGate: no GOAL_CLARIFICATION_* events; events + assumptions match the Tier B1 reference', async () => {
    const rng = mulberry32(0x6e7a);
    const seen = { KNOWN: 0, INFERRED: 0, UNKNOWN: 0 } as Record<string, number>;
    for (let i = 0; i < RUNS; i++) {
      const { goal, kind } = genGoal(rng, i);
      const script = genAdvisorScript(rng);
      const before = structuredClone(goal);
      const ctx = `iteration ${i}: kind=${kind} goal=${JSON.stringify(goal.description)} ac=${goal.acceptanceCriteria.length}`;

      const { out, events } = await runStage(goal, script);
      const types = events.types();

      // Assessed level comes from the stage's own audit event (not from out.mission).
      const assessed = events.events.find((e) => e.type === 'MISSION_UNCERTAINTY_ASSESSED');
      const level = (assessed?.payload as { level: string } | undefined)?.level;
      expect(level, ctx).toBeDefined();
      seen[level as string]++;
      if (kind === 'vague') expect(level, ctx).toBe('UNKNOWN');

      // No gate ⇒ never any GOAL_CLARIFICATION_* event.
      expect(types.some((t) => t.startsWith('GOAL_CLARIFICATION_')), ctx).toBe(false);

      // Reference Tier B1: ASSUMPTIONS_MADE iff level ≠ KNOWN and the advisor produced output.
      const assumes = level !== 'KNOWN' && script.expected.length > 0;
      expect(types, ctx).toEqual(assumes ? [...BASE_SEQUENCE, 'MISSION_ASSUMPTIONS_MADE'] : BASE_SEQUENCE);
      if (assumes) {
        expect(out.assumptions, ctx).toEqual(script.expected);
        expect(out.clarification?.assumptions.map((a) => a.assumption), ctx).toEqual(script.expected);
      } else {
        expect(out.assumptions, ctx).toBeUndefined();
        expect(out.clarification, ctx).toBeUndefined();
      }

      // Tier B1 leaves the uncertainty as assessed and always proceeds; the Goal is untouched.
      expect(out.mission.uncertainty.level, ctx).toBe(level);
      expect(out.proceed, ctx).toBe(true);
      expect(out.blockers, ctx).toEqual([]);
      expect(goal, ctx).toEqual(before);
    }
    // Generator coverage: every level is exercised.
    expect(seen.KNOWN).toBeGreaterThan(0);
    expect(seen.INFERRED).toBeGreaterThan(0);
    expect(seen.UNKNOWN).toBeGreaterThan(0);
  });

  it('with a gate on KNOWN/INFERRED goals: identical to the no-gate run and the gate is never called', async () => {
    const rng = mulberry32(0xc1a7);
    let compared = 0;
    for (let i = 0; i < RUNS; i++) {
      const { goal, kind } = genGoal(rng, i);
      const script = genAdvisorScript(rng);
      const ctx = `iteration ${i}: kind=${kind} goal=${JSON.stringify(goal.description)} ac=${goal.acceptanceCriteria.length}`;

      const without = await runStage(goal, script);
      if (without.out.mission.uncertainty.level === 'UNKNOWN') continue; // gate path is task 2.3's scope
      const gate = new RecordingGate();
      const withGate = await runStage(goal, script, gate);

      expect(gate.calls, ctx).toBe(0);
      expect(withGate.events.events, ctx).toEqual(without.events.events);
      expect(withGate.out, ctx).toEqual(without.out);
      compared++;
    }
    expect(compared).toBeGreaterThanOrEqual(50);
  });
});
