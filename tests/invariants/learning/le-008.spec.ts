// LE-008 — SelfModel/learning chỉ đọc dữ liệu đã redact; không có PII/secret rò rỉ từ
// event/failure sang self-model.
//
// Enforced by SelfModelBuilder (P11.1): the builder derives the model ONLY from
// classification fields (failure class, recovery kind/outcome, counts, the already-
// normalized Failure.signature). It never copies raw event payloads, evidence messages,
// stderr, or file contents into the model. This test plants a secret in every free-text
// field the builder could theoretically touch and asserts it never appears in the output.
import { describe, it, expect } from 'vitest';
import { SelfModelBuilder } from '@codeforge/agent-core';
import type { DomainEvent, Failure, RecoveryAction } from '@codeforge/agent-core';

const SECRET = 'sk-SUPER-SECRET-TOKEN-9f8e7d6c';

const EVENTS: DomainEvent[] = [
  {
    eventId: 'e1',
    sessionId: 's1',
    type: 'TASK_RUN_STARTED',
    aggregate: { kind: 'task_run', id: 'r1' },
    // Secret planted in an event payload (the builder reads only taskId from payload).
    payload: { taskId: 't1', note: SECRET, apiKey: SECRET },
    at: '2026-01-01T00:00:00.000Z',
    sequenceNumber: 1,
  },
  {
    eventId: 'e2',
    sessionId: 's1',
    type: 'SESSION_COMPLETED',
    aggregate: { kind: 'session', id: 's1' },
    payload: { summary: `done with ${SECRET}` },
    at: '2026-01-01T00:00:00.000Z',
    sequenceNumber: 2,
  },
];

const FAILURES: Failure[] = [
  {
    failureId: 'f1',
    sessionId: 's1',
    taskId: 't1',
    taskRunId: 'r1',
    stage: 'verify',
    class: 'LOGIC',
    signature: 'sig-A',
    // Secret planted in evidence free-text fields.
    evidence: { message: `assertion failed: ${SECRET}`, stackTrace: SECRET },
    detectedAt: '2026-01-01T00:00:00.000Z',
    classifiedBy: 'deterministic',
    recoveryActionIds: [],
  },
];

const RECOVERIES: RecoveryAction[] = [
  {
    actionId: 'a1',
    failureId: 'f1',
    action: 'FIX',
    // Secret planted in the recovery reason.
    reason: `trying ${SECRET}`,
    policyVersion: 1,
    budgetConsumed: { wallClockMs: 0, modelTokens: 0, toolCalls: 0, recoveryAttempts: 0 },
    startedAt: '2026-01-01T00:00:00.000Z',
    outcome: 'SUCCEEDED',
  },
];

describe('LE-008 — no secret leaks from events/failures into the SelfModel', () => {
  it('the serialized SelfModel contains no planted secret', () => {
    const b = new SelfModelBuilder();
    const model = b.build({ events: EVENTS, failures: FAILURES, recoveryActions: RECOVERIES });
    const serialized = JSON.stringify(model);
    expect(serialized).not.toContain(SECRET);
  });

  it('still produces the expected classification signal (proves it read the data)', () => {
    const b = new SelfModelBuilder();
    const model = b.build({ events: EVENTS, failures: FAILURES, recoveryActions: RECOVERIES });
    // It DID read the failure (LOGIC) and the successful FIX — just not the secret text.
    expect(model.failureClasses).toEqual([{ failureClass: 'LOGIC', count: 1 }]);
    expect(model.recoveryOutcomes).toEqual([
      { failureClass: 'LOGIC', action: 'FIX', total: 1, succeeded: 1, failed: 0, aborted: 0, successRate: 1 },
    ]);
  });
});
