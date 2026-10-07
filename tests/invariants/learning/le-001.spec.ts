// LE-001 — Output của lớp learning không bao giờ là runtime authority — chỉ là input có
// trọng số cho một quyết định deterministic đã tồn tại.
//
// Phase 11 invariant (invariants-first: full enforcement lands with the AdviceGate in
// P11.3). What is testable at P11.1: the SelfModel is a pure READ-ONLY projection — the
// builder exposes no mutating/decision surface, does not mutate its inputs, and holds no
// reference to any policy/engine/gateway. The kernel reads no self-model to decide
// anything (architectural: agent-core has no self-model authority path; depcruise guards
// the direction, and no runtime decision function takes a SelfModel as input yet).
import { describe, it, expect } from 'vitest';
import { SelfModelBuilder } from '@codeforge/agent-core';
import type { DomainEvent, Failure, RecoveryAction } from '@codeforge/agent-core';

const EVENTS: DomainEvent[] = [
  {
    eventId: 'e1',
    sessionId: 's1',
    type: 'TASK_RUN_STARTED',
    aggregate: { kind: 'task_run', id: 'r1' },
    payload: { taskId: 't1' },
    at: '2026-01-01T00:00:00.000Z',
    sequenceNumber: 1,
  },
];
const FAILURES: Failure[] = [];
const RECOVERIES: RecoveryAction[] = [];

describe('LE-001 — self-model is a read-only projection, never authority', () => {
  it('build() does not mutate its inputs', () => {
    const b = new SelfModelBuilder();
    const events = [...EVENTS];
    const failures = [...FAILURES];
    const recoveryActions = [...RECOVERIES];
    const eventsSnapshot = JSON.stringify(events);
    const failuresSnapshot = JSON.stringify(failures);
    const recoverySnapshot = JSON.stringify(recoveryActions);

    b.build({ events, failures, recoveryActions });

    expect(JSON.stringify(events)).toEqual(eventsSnapshot);
    expect(JSON.stringify(failures)).toEqual(failuresSnapshot);
    expect(JSON.stringify(recoveryActions)).toEqual(recoverySnapshot);
  });

  it('exposes only build() — no decide/apply/mutate/approve surface', () => {
    const b = new SelfModelBuilder() as unknown as Record<string, unknown>;
    const authorityNames = ['decide', 'apply', 'mutate', 'approve', 'commit', 'execute', 'enforce', 'transition'];
    const proto = Object.getPrototypeOf(b) as object;
    const methods = Object.getOwnPropertyNames(proto);
    for (const name of authorityNames) {
      expect(methods).not.toContain(name);
    }
    expect(typeof (b as { build?: unknown }).build).toBe('function');
  });

  it('the produced model is plain data (no functions / behavior)', () => {
    const b = new SelfModelBuilder();
    const model = b.build({ events: EVENTS, failures: FAILURES, recoveryActions: RECOVERIES });
    // A pure-data projection round-trips through JSON unchanged (no methods, no identity).
    const roundTripped = JSON.parse(JSON.stringify(model));
    expect(roundTripped).toEqual(model);
  });
});
