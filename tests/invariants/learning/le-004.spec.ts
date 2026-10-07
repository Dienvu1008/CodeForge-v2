// LE-004 — SelfModel là total function của EventLog (đã redact) + failures + recovery
// actions; cùng input → cùng self-model (tái lập được).
//
// Enforced by SelfModelBuilder (P11.1): build() performs no I/O, no clock, no randomness,
// and sorts every output key with a stable comparator, so the result is independent of
// input ordering and byte-identical across repeated calls.
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
    failureId: id,
    sessionId,
    taskId: `t-${id}`,
    taskRunId: `r-${id}`,
    stage: 'verify',
    class: cls,
    signature,
    evidence: { message: 'x' },
    detectedAt: '2026-01-01T00:00:00.000Z',
    classifiedBy: 'deterministic',
    recoveryActionIds: [],
  };
}

const NO_BUDGET = { wallClockMs: 0, modelTokens: 0, toolCalls: 0, recoveryAttempts: 0 };

function recovery(id: string, failureId: string, action: RecoveryAction['action'], outcome: RecoveryAction['outcome']): RecoveryAction {
  return {
    actionId: id,
    failureId,
    action,
    reason: 'r',
    policyVersion: 1,
    budgetConsumed: NO_BUDGET,
    startedAt: '2026-01-01T00:00:00.000Z',
    outcome,
  };
}

const EVENTS: DomainEvent[] = [
  ev('s1', 'TASK_RUN_STARTED', 1, { taskId: 't-f1' }),
  ev('s1', 'DECISION_COMPLETED', 2),
  ev('s1', 'TASK_RUN_STARTED', 3, { taskId: 't-f1' }),
  ev('s1', 'TASK_RUN_ENDED', 4, { taskId: 't-f1' }),
  ev('s1', 'SESSION_COMPLETED', 5),
  ev('s2', 'TASK_RUN_STARTED', 1, { taskId: 't-f2' }),
  ev('s2', 'SESSION_ABORTED', 2),
];

const FAILURES: Failure[] = [
  failure('f1', 's1', 'SYNTAX', 'sig-A'),
  failure('f2', 's2', 'LOGIC', 'sig-B'),
  failure('f3', 's1', 'SYNTAX', 'sig-A'),
];

const RECOVERIES: RecoveryAction[] = [
  recovery('a1', 'f1', 'FIX', 'FAILED'),
  recovery('a2', 'f3', 'FIX', 'SUCCEEDED'),
  recovery('a3', 'f2', 'REPLAN', 'SUCCEEDED'),
];

describe('LE-004 — SelfModel is a deterministic, reproducible projection', () => {
  it('yields byte-identical JSON regardless of input ordering', () => {
    const b = new SelfModelBuilder();
    const forward = b.build({ events: EVENTS, failures: FAILURES, recoveryActions: RECOVERIES });
    const reversed = b.build({
      events: [...EVENTS].reverse(),
      failures: [...FAILURES].reverse(),
      recoveryActions: [...RECOVERIES].reverse(),
    });
    expect(JSON.stringify(reversed)).toEqual(JSON.stringify(forward));
  });

  it('is a pure function — repeated calls are identical', () => {
    const b = new SelfModelBuilder();
    const first = b.build({ events: EVENTS, failures: FAILURES, recoveryActions: RECOVERIES });
    const second = b.build({ events: EVENTS, failures: FAILURES, recoveryActions: RECOVERIES });
    expect(JSON.stringify(second)).toEqual(JSON.stringify(first));
  });

  it('produces stable sorted ordering on every output array', () => {
    const b = new SelfModelBuilder();
    const m = b.build({ events: EVENTS, failures: FAILURES, recoveryActions: RECOVERIES });

    expect(m.sessionIds).toEqual(['s1', 's2']);
    // failureClasses sorted by class
    expect(m.failureClasses.map((x) => x.failureClass)).toEqual(['LOGIC', 'SYNTAX']);
    // recovery outcomes sorted by (class, action)
    expect(m.recoveryOutcomes.map((x) => `${x.failureClass}:${x.action}`)).toEqual([
      'LOGIC:REPLAN',
      'SYNTAX:FIX',
    ]);
    // convergence sorted by sessionId
    expect(m.convergence.map((x) => x.sessionId)).toEqual(['s1', 's2']);
  });
});
