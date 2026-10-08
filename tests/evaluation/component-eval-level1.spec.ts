// Level-1 component evaluation (§10) — measure the ACCURACY of individual deterministic
// subsystems against labeled fixtures, independent of any end-to-end run. Here: the mission
// classifier (type) and complexity analyzer. This is how CodeForge evaluates a single component
// in isolation; it reuses the real agent-core functions (no mocks).
import { describe, it, expect } from 'vitest';
import {
  extractSignals,
  classifyMissionType,
  assessComplexity,
  type MissionType,
  type Complexity,
} from '@codeforge/agent-core';

interface Fixture { goal: string; expectedType: MissionType; expectedComplexityIn: Complexity[]; }

// Labeled fixtures — the "ground truth" for the components (deterministic, hand-labeled).
const FIXTURES: readonly Fixture[] = [
  { goal: 'fix the crash when the user submits an empty form', expectedType: 'BUG_FIX', expectedComplexityIn: ['LOW', 'MEDIUM'] },
  { goal: 'add a logout button to the settings screen', expectedType: 'FEATURE', expectedComplexityIn: ['LOW', 'MEDIUM'] },
  { goal: 'rename the variable count to total across utils', expectedType: 'REFACTOR', expectedComplexityIn: ['LOW', 'MEDIUM'] },
  { goal: 'migrate the database schema from mysql to postgres', expectedType: 'MIGRATION', expectedComplexityIn: ['MEDIUM', 'HIGH'] },
  { goal: 'write unit tests for the pricing module', expectedType: 'TESTING', expectedComplexityIn: ['LOW', 'MEDIUM'] },
  { goal: 'build a new app from scratch with multiple subsystems', expectedType: 'PROJECT', expectedComplexityIn: ['HIGH', 'SYSTEM'] },
  { goal: 'research and compare charting libraries for the dashboard', expectedType: 'RESEARCH', expectedComplexityIn: ['LOW', 'MEDIUM', 'HIGH'] },
  { goal: 'optimize the slow report query', expectedType: 'PERFORMANCE', expectedComplexityIn: ['LOW', 'MEDIUM'] },
  { goal: 'document the public API in the readme', expectedType: 'DOCUMENTATION', expectedComplexityIn: ['LOW', 'MEDIUM'] },
  { goal: 'automate the release with a github action', expectedType: 'AUTOMATION', expectedComplexityIn: ['LOW', 'MEDIUM'] },
];

describe('Level-1 component eval — mission classifier', () => {
  it('classifies the labeled fixtures with high accuracy', () => {
    let correct = 0;
    const misses: string[] = [];
    for (const f of FIXTURES) {
      const type = classifyMissionType(extractSignals(f.goal)).type;
      if (type === f.expectedType) correct++;
      else misses.push(`"${f.goal}" → ${type} (expected ${f.expectedType})`);
    }
    const accuracy = correct / FIXTURES.length;
    // eslint-disable-next-line no-console
    if (misses.length > 0) console.log('classifier misses:\n' + misses.join('\n'));
    // A deterministic keyword classifier should get the clear cases; require a strong majority.
    expect(accuracy).toBeGreaterThanOrEqual(0.8);
  });

  it('is deterministic (same goal → same classification)', () => {
    const g = FIXTURES[0]!.goal;
    expect(classifyMissionType(extractSignals(g)).type).toBe(classifyMissionType(extractSignals(g)).type);
  });
});

describe('Level-1 component eval — complexity analyzer', () => {
  it('places each fixture within its expected complexity band', () => {
    let withinBand = 0;
    for (const f of FIXTURES) {
      const signals = extractSignals(f.goal);
      const type = classifyMissionType(signals).type;
      const level = assessComplexity(signals, type).level;
      if (f.expectedComplexityIn.includes(level)) withinBand++;
    }
    expect(withinBand / FIXTURES.length).toBeGreaterThanOrEqual(0.8);
  });
});
