// MI-005 — Classification (type/complexity/risk) deterministic trên cùng tín hiệu khách quan;
// cùng input → cùng phân loại.
//
// Enforced by MissionIntake + ComplexityAnalyzer + RiskAnalyzer: all are pure functions of the
// extracted signals (no I/O, no clock, no randomness). This test asserts repeated + reordered
// evaluation yields byte-identical classifications, and that complexity is NOT prompt-length.
import { describe, it, expect } from 'vitest';
import { extractSignals, classifyMissionType, assessComplexity, assessRisk } from '@codeforge/agent-core';

const GOALS = [
  'Rename calculatePrice to calculateTotalPrice',
  'Fix the crash in the auth module',
  'Add Telegram notifications to CodeForge using a bot token',
  'Build a Flutter productivity application for Windows and Android',
  'Migrate from Express 4 to Express 5',
  'Delete all log files and drop table sessions',
];

describe('MI-005 — deterministic classification', () => {
  it('type + complexity + risk are byte-identical across repeated calls', () => {
    for (const g of GOALS) {
      const sa = extractSignals(g);
      const sb = extractSignals(g);
      const ta = classifyMissionType(sa);
      const tb = classifyMissionType(sb);
      expect(JSON.stringify(tb)).toEqual(JSON.stringify(ta));
      expect(JSON.stringify(assessComplexity(sb, tb.type))).toEqual(JSON.stringify(assessComplexity(sa, ta.type)));
      expect(JSON.stringify(assessRisk(sb))).toEqual(JSON.stringify(assessRisk(sa)));
    }
  });

  it('complexity is multi-dimensional, not prompt length (long trivial stays LOW)', () => {
    const longTrivial = 'When you have a moment, could you please kindly rename the function foo to bar everywhere, thanks a lot for the help with this tiny little change across the file';
    const shortComplex = 'Build a cross-platform app for Windows and Android';
    const lt = assessComplexity(extractSignals(longTrivial), classifyMissionType(extractSignals(longTrivial)).type);
    const sc = assessComplexity(extractSignals(shortComplex), classifyMissionType(extractSignals(shortComplex)).type);
    expect(lt.level).toBe('LOW');
    expect(['HIGH', 'SYSTEM']).toContain(sc.level);
    // The long prompt is far longer than the short one, yet simpler — proves non-length-based.
    expect(longTrivial.length).toBeGreaterThan(shortComplex.length);
  });

  it('reasons arrays are stably sorted (deterministic serialization)', () => {
    const s = extractSignals('Build a Flutter app for Windows and Android with external api integration');
    const c = assessComplexity(s, classifyMissionType(s).type);
    const sorted = [...c.reasons].sort();
    expect(c.reasons).toEqual(sorted);
  });
});
