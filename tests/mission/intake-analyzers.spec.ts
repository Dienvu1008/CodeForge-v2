// P12.2 unit — MissionIntake + Complexity + Risk analyzers (deterministic core).
// Covers the §22-24 examples and the §31 classification/complexity cases.
import { describe, it, expect } from 'vitest';
import {
  extractSignals,
  classifyMissionType,
  assessComplexity,
  assessRisk,
} from '@codeforge/agent-core';

const sig = (goal: string, ws?: Parameters<typeof extractSignals>[1]) => extractSignals(goal, ws);

describe('classifyMissionType — §31 classification', () => {
  it('simple edit / rename → REFACTOR', () => {
    expect(classifyMissionType(sig('Rename calculatePrice to calculateTotalPrice')).type).toBe('REFACTOR');
  });
  it('bug fix → BUG_FIX', () => {
    expect(classifyMissionType(sig('Fix the crash in the auth module')).type).toBe('BUG_FIX');
  });
  it('feature → FEATURE', () => {
    expect(classifyMissionType(sig('Add Telegram notifications to CodeForge')).type).toBe('FEATURE');
  });
  it('project → PROJECT', () => {
    expect(classifyMissionType(sig('Build a Flutter productivity application for Windows and Android')).type).toBe('PROJECT');
  });
  it('research → RESEARCH', () => {
    expect(classifyMissionType(sig('Investigate which charting library fits our needs')).type).toBe('RESEARCH');
  });
  it('migration → MIGRATION', () => {
    expect(classifyMissionType(sig('Migrate the project from Express 4 to Express 5')).type).toBe('MIGRATION');
  });
  it('unknown goal → UNKNOWN (caller may ask / consult advisory)', () => {
    expect(classifyMissionType(sig('hmm the thing with the stuff')).type).toBe('UNKNOWN');
  });
  it('priority: "migrate ... feature" classifies as MIGRATION, not FEATURE', () => {
    expect(classifyMissionType(sig('Migrate the feature set to the new framework')).type).toBe('MIGRATION');
  });
});

describe('assessComplexity — §31 complexity (multi-dimensional, not prompt length)', () => {
  it('LOW: a bare rename (light type, no breadth signals)', () => {
    const s = sig('Rename calculatePrice to calculateTotalPrice');
    const c = assessComplexity(s, classifyMissionType(s).type);
    expect(c.level).toBe('LOW');
  });
  it('MEDIUM: add a network feature', () => {
    const s = sig('Add Telegram notifications to CodeForge');
    const c = assessComplexity(s, classifyMissionType(s).type);
    expect(['MEDIUM', 'HIGH']).toContain(c.level); // feature + external integration
  });
  it('HIGH/SYSTEM: cross-platform project', () => {
    const s = sig('Build a Flutter productivity application for Windows and Android with cloud sync');
    const c = assessComplexity(s, classifyMissionType(s).type);
    expect(['HIGH', 'SYSTEM']).toContain(c.level);
    expect(c.reasons.join(' ')).toMatch(/platform|heavy mission/);
  });
  it('a LONG but trivial prompt stays LOW (not length-based)', () => {
    const longTrivial = 'Please, when you have a moment, could you kindly rename the function calculatePrice to calculateTotalPrice everywhere it appears, thank you so much for your help with this small change';
    const s = sig(longTrivial);
    const c = assessComplexity(s, classifyMissionType(s).type);
    expect(c.level).toBe('LOW');
  });
  it('large existing workspace raises complexity', () => {
    const s = sig('Refactor the scheduler', { fileCount: 600, languages: ['typescript'], hasExistingProject: true });
    const c = assessComplexity(s, classifyMissionType(s).type);
    expect(c.reasons).toContain('large existing codebase');
  });
});

describe('assessRisk — §6 dimensions', () => {
  it('READ_ONLY when nothing mutating', () => {
    const r = assessRisk(sig('Explain how the scheduler works'));
    expect(r.level).toBe('LOW');
    expect(r.factors).toEqual(['READ_ONLY']);
  });
  it('network + credential for a Telegram integration', () => {
    const r = assessRisk(sig('Add Telegram notifications using a bot token over the network'));
    expect(r.factors).toContain('NETWORK');
    expect(r.factors).toContain('CREDENTIAL');
    expect(r.requiredApprovals).toContain('CREDENTIAL');
  });
  it('destructive goal is CRITICAL and requires approval', () => {
    const r = assessRisk(sig('Delete all the log files and drop table sessions'));
    expect(r.level).toBe('CRITICAL');
    expect(r.requiredApprovals).toContain('DESTRUCTIVE');
  });
  it('a local edit is LOW/MEDIUM, not escalated', () => {
    const r = assessRisk(sig('Rename a function in utils.ts'));
    expect(['LOW', 'MEDIUM']).toContain(r.level);
    expect(r.requiredApprovals).toEqual([]);
  });
});

describe('MI-005 — determinism (same signals → same classification)', () => {
  const goals = [
    'Rename calculatePrice to calculateTotalPrice',
    'Build a Flutter app for Windows and Android',
    'Add Telegram notifications using a bot token',
    'Migrate from Express 4 to Express 5',
  ];
  it('intake + complexity + risk are pure functions', () => {
    for (const g of goals) {
      const s1 = sig(g);
      const s2 = sig(g);
      const t1 = classifyMissionType(s1);
      const t2 = classifyMissionType(s2);
      expect(JSON.stringify(t2)).toEqual(JSON.stringify(t1));
      expect(JSON.stringify(assessComplexity(s2, t2.type))).toEqual(JSON.stringify(assessComplexity(s1, t1.type)));
      expect(JSON.stringify(assessRisk(s2))).toEqual(JSON.stringify(assessRisk(s1)));
    }
  });
  it('platform count de-duplicates (windows twice counts once)', () => {
    const a = sig('Build for Windows and Android and Windows');
    expect(a.platformCount).toBe(2); // {windows, android}
  });
});
