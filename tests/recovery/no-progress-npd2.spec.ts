// P7-NPD2 — relevantFilesChanged signal in NoProgressDetector.
// Verifies the Phase 7 affected-file signal (deferred from P6): static files
// across attempts indicate no progress; absent signal is unknown-safe (RC-003).
import { describe, it, expect } from 'vitest';
import { detectNoProgress } from '@codeforge/agent-core';
import type { Failure } from '@codeforge/agent-core';

let n = 0;
function makeFailure(cls: Failure['class']): Failure {
  return {
    failureId: `F-${++n}`, sessionId: 'S', taskId: 'T', taskRunId: 'TR',
    stage: 'verify', class: cls, signature: `sig-${n}`,
    evidence: { message: 'x' }, detectedAt: '2026-01-01T00:00:00.000Z',
    classifiedBy: 'deterministic', recoveryActionIds: [],
  };
}

const S = (...xs: string[]): Set<string> => new Set(xs);

describe('P7-NPD2 — relevantFilesChanged signal', () => {
  it('absent signal → identical to Phase 5 behavior (RC-003 unknown-safe)', () => {
    const failures = [makeFailure('LOGIC'), makeFailure('SYNTAX'), makeFailure('TIMEOUT')];
    const r = detectNoProgress(failures, 3);
    // Mixed classes, no files signal → not stuck; signal reported unknown.
    expect(r.noProgress).toBe(false);
    expect(r.relevantFilesChanged).toBeUndefined();
  });

  it('reports relevantFilesChanged=false when the file set is static across attempts', () => {
    const failures = [makeFailure('LOGIC'), makeFailure('SYNTAX'), makeFailure('TIMEOUT')];
    const files = [S('a.ts', 'b.ts'), S('a.ts', 'b.ts'), S('a.ts', 'b.ts')];
    const r = detectNoProgress(failures, 3, { relevantFilesPerAttempt: files });
    expect(r.relevantFilesChanged).toBe(false);
    // Static files across attempts → no-progress even though classes differ (P7-NPD2).
    expect(r.noProgress).toBe(true);
    expect(r.reason).toContain('P7-NPD2');
  });

  it('reports relevantFilesChanged=true when the file set changes (not stuck on this signal)', () => {
    const failures = [makeFailure('LOGIC'), makeFailure('SYNTAX'), makeFailure('TIMEOUT')];
    const files = [S('a.ts'), S('a.ts', 'b.ts'), S('c.ts')];
    const r = detectNoProgress(failures, 3, { relevantFilesPerAttempt: files });
    expect(r.relevantFilesChanged).toBe(true);
    expect(r.noProgress).toBe(false); // mixed classes + files changing = progress
  });

  it('set comparison is order-independent (deterministic)', () => {
    const failures = [makeFailure('LOGIC'), makeFailure('SYNTAX'), makeFailure('LOGIC')];
    const files = [S('a.ts', 'b.ts'), S('b.ts', 'a.ts'), S('a.ts', 'b.ts')];
    const r = detectNoProgress(failures, 3, { relevantFilesPerAttempt: files });
    expect(r.relevantFilesChanged).toBe(false); // same sets, different insertion order
  });

  it('signal is unknown when fewer than threshold file-sets provided', () => {
    const failures = [makeFailure('LOGIC'), makeFailure('LOGIC'), makeFailure('LOGIC')];
    const r = detectNoProgress(failures, 3, { relevantFilesPerAttempt: [S('a.ts')] });
    // Class signal still fires (3x LOGIC); files signal stays unknown.
    expect(r.noProgress).toBe(true);
    expect(r.relevantFilesChanged).toBeUndefined();
  });

  it('static files reinforce an already-repeating class (reason notes it)', () => {
    const failures = [makeFailure('LOGIC'), makeFailure('LOGIC'), makeFailure('LOGIC')];
    const files = [S('a.ts'), S('a.ts'), S('a.ts')];
    const r = detectNoProgress(failures, 3, { relevantFilesPerAttempt: files });
    expect(r.noProgress).toBe(true);
    expect(r.repeatingClass).toBe('LOGIC');
    expect(r.relevantFilesChanged).toBe(false);
    expect(r.reason).toContain('relevant files unchanged');
  });

  it('deterministic: same input → same output', () => {
    const failures = [makeFailure('LOGIC'), makeFailure('SYNTAX'), makeFailure('TIMEOUT')];
    const files = [S('a.ts'), S('a.ts'), S('a.ts')];
    const r1 = detectNoProgress(failures, 3, { relevantFilesPerAttempt: files });
    const r2 = detectNoProgress(failures, 3, { relevantFilesPerAttempt: files });
    expect(r1.noProgress).toBe(r2.noProgress);
    expect(r1.relevantFilesChanged).toBe(r2.relevantFilesChanged);
  });
});
