// P11.1 unit — SelfModelBuilder computations (retries, success rates, signature recurrence,
// convergence, orphan handling). Pure projection; see LE-001/LE-004/LE-008 for invariants.
import { describe, it, expect } from 'vitest';
import { SelfModelBuilder } from '@codeforge/agent-core';
import type { DomainEvent, Failure, RecoveryAction } from '@codeforge/agent-core';

function ev(sessionId: string, type: string, seq: number, payload: unknown = {}): DomainEvent {
  return {
    eventId: `e-${sessionId}-${seq}`,
    sessionId,
    type,
    aggregate: { kind: 'session', id: sessionId },
    payload,
    at: '2026-01-01T00:00:00.000Z',
    sequenceNumber: seq,
  };
}
function failure(id: string, sessionId: string, cls: Failure['class'], signature: string): Failure {
  return {
    failureId: id, sessionId, taskId: `t-${id}`, taskRunId: `r-${id}`,
    stage: 'verify', class: cls, signature, evidence: { message: 'x' },
    detectedAt: '2026-01-01T00:00:00.000Z', classifiedBy: 'deterministic', recoveryActionIds: [],
  };
}
function recovery(id: string, failureId: string, action: RecoveryAction['action'], outcome: RecoveryAction['outcome']): RecoveryAction {
  return {
    actionId: id, failureId, action, reason: 'r', policyVersion: 1,
    budgetConsumed: { wallClockMs: 0, modelTokens: 0, toolCalls: 0, recoveryAttempts: 0 },
    startedAt: '2026-01-01T00:00:00.000Z', outcome,
  };
}

describe('SelfModelBuilder', () => {
  it('counts task retries from repeated TASK_RUN_STARTED on the same task', () => {
    const b = new SelfModelBuilder();
    const events = [
      ev('s1', 'TASK_RUN_STARTED', 1, { taskId: 't1' }),
      ev('s1', 'TASK_RUN_STARTED', 2, { taskId: 't1' }),
      ev('s1', 'TASK_RUN_STARTED', 3, { taskId: 't1' }),
      ev('s1', 'TASK_RUN_STARTED', 4, { taskId: 't2' }),
    ];
    const m = b.build({ events, failures: [], recoveryActions: [] });
    const s1 = m.convergence.find((c) => c.sessionId === 's1')!;
    expect(s1.taskRunsStarted).toBe(4);
    expect(s1.taskRetries).toBe(2); // t1 started 3x → 2 retries; t2 once → 0
  });

  it('computes recovery success rate per (failureClass, action)', () => {
    const b = new SelfModelBuilder();
    const failures = [
      failure('f1', 's1', 'LOGIC', 'A'),
      failure('f2', 's1', 'LOGIC', 'B'),
      failure('f3', 's1', 'LOGIC', 'C'),
    ];
    const recoveries = [
      recovery('a1', 'f1', 'FIX', 'SUCCEEDED'),
      recovery('a2', 'f2', 'FIX', 'FAILED'),
      recovery('a3', 'f3', 'FIX', 'SUCCEEDED'),
    ];
    const m = b.build({ events: [], failures, recoveryActions: recoveries });
    const stat = m.recoveryOutcomes.find((r) => r.failureClass === 'LOGIC' && r.action === 'FIX')!;
    expect(stat.total).toBe(3);
    expect(stat.succeeded).toBe(2);
    expect(stat.failed).toBe(1);
    expect(stat.successRate).toBeCloseTo(2 / 3);
  });

  it('ignores PENDING recovery actions in the success-rate tally', () => {
    const b = new SelfModelBuilder();
    const failures = [failure('f1', 's1', 'TOOL', 'A'), failure('f2', 's1', 'TOOL', 'B')];
    const recoveries = [
      recovery('a1', 'f1', 'FIX', 'SUCCEEDED'),
      recovery('a2', 'f2', 'FIX', 'PENDING'),
    ];
    const m = b.build({ events: [], failures, recoveryActions: recoveries });
    const stat = m.recoveryOutcomes.find((r) => r.failureClass === 'TOOL')!;
    expect(stat.total).toBe(1); // PENDING excluded
    expect(stat.succeeded).toBe(1);
  });

  it('skips orphan recovery actions whose failure is unknown', () => {
    const b = new SelfModelBuilder();
    const recoveries = [recovery('a1', 'MISSING', 'FIX', 'SUCCEEDED')];
    const m = b.build({ events: [], failures: [], recoveryActions: recoveries });
    expect(m.recoveryOutcomes).toEqual([]);
    expect(m.totals.recoveryActions).toBe(1); // still counted in totals
  });

  it('ranks recurring failure signatures by count desc', () => {
    const b = new SelfModelBuilder();
    const failures = [
      failure('f1', 's1', 'SYNTAX', 'dup'),
      failure('f2', 's1', 'SYNTAX', 'dup'),
      failure('f3', 's1', 'LOGIC', 'once'),
    ];
    const m = b.build({ events: [], failures, recoveryActions: [] });
    expect(m.failureSignatures[0]).toEqual({ signature: 'dup', count: 2, failureClass: 'SYNTAX' });
    expect(m.failureSignatures[1]).toEqual({ signature: 'once', count: 1, failureClass: 'LOGIC' });
  });

  it('records session outcome and totals', () => {
    const b = new SelfModelBuilder();
    const events = [ev('s1', 'SESSION_COMPLETED', 1), ev('s2', 'SESSION_ABORTED', 1)];
    const m = b.build({ events, failures: [], recoveryActions: [] });
    expect(m.totals.sessions).toBe(2);
    expect(m.convergence.find((c) => c.sessionId === 's1')!.outcome).toBe('COMPLETED');
    expect(m.convergence.find((c) => c.sessionId === 's2')!.outcome).toBe('ABORTED');
  });

  it('handles entirely empty input', () => {
    const b = new SelfModelBuilder();
    const m = b.build({ events: [], failures: [], recoveryActions: [] });
    expect(m.totals).toEqual({ events: 0, failures: 0, recoveryActions: 0, sessions: 0 });
    expect(m.recoveryOutcomes).toEqual([]);
    expect(m.failureClasses).toEqual([]);
    expect(m.failureSignatures).toEqual([]);
    expect(m.convergence).toEqual([]);
  });
});
