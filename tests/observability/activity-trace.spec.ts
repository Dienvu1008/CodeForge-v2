// P9.4 — ActivityTrace.buildActivityTrace (pure structured trace from events).
import { describe, it, expect } from 'vitest';
import { buildActivityTrace, type DomainEvent } from '@codeforge/agent-core';

function evt(seq: number, type: string, kind: DomainEvent['aggregate']['kind'], id: string, payload: unknown = {}): DomainEvent {
  return {
    eventId: `E-${seq}`, sessionId: 'S', type,
    aggregate: { kind, id }, payload,
    at: `2026-01-01T00:00:0${seq}.000Z`, sequenceNumber: seq,
  };
}

describe('P9.4 buildActivityTrace — structure + categories', () => {
  it('maps events to structured entries in event order', () => {
    const events = [
      evt(1, 'SESSION_CREATED', 'session', 'S'),
      evt(2, 'GRAPH_MUTATION_COMMITTED', 'graph', 'G', { mutationId: 'M1', graphVersion: 2 }),
      evt(3, 'TASK_RUN_STARTED', 'task_run', 'TR1', { taskId: 'T1', taskRunId: 'TR1' }),
      evt(4, 'TOOL_CALL_ENDED', 'tool_call', 'TC1', { toolCallId: 'TC1', state: 'SUCCEEDED' }),
      evt(5, 'VERIFICATION_ENDED', 'verification', 'V1', { status: 'PASS', scope: 'AFFECTED_DIRECT' }),
    ];
    const trace = buildActivityTrace('S', events);
    expect(trace.entries.map((e) => e.sequenceNumber)).toEqual([1, 2, 3, 4, 5]);
    expect(trace.entries.map((e) => e.category)).toEqual([
      'lifecycle', 'planning', 'scheduling', 'tool_use', 'verification',
    ]);
  });

  it('extracts evidence references (ids) but never raw content', () => {
    const trace = buildActivityTrace('S', [
      evt(1, 'TASK_RUN_STARTED', 'task_run', 'TR1', { taskId: 'T1', taskRunId: 'TR1' }),
    ]);
    const entry = trace.entries[0]!;
    expect(entry.evidenceRefs).toContain('taskId=T1');
    expect(entry.evidenceRefs).toContain('taskRunId=TR1');
    // No raw-reasoning field exists on the entry shape at all.
    expect('reasoning' in entry).toBe(false);
    expect('chainOfThought' in entry).toBe(false);
  });

  it('categorizes approval, recovery, budget, checkpoint, control events', () => {
    const types: Array<[string, string]> = [
      ['HUMAN_APPROVAL_GRANTED', 'approval'],
      ['FAILURE_DETECTED', 'recovery'],
      ['BUDGET_EXHAUSTED', 'budget'],
      ['CHECKPOINT_CREATED', 'checkpoint'],
      ['CONTROL_PAUSE_ADMITTED', 'control'],
    ];
    const events = types.map(([type], i) => evt(i + 1, type, 'session', 'S'));
    const trace = buildActivityTrace('S', events);
    expect(trace.entries.map((e) => e.category)).toEqual(types.map(([, c]) => c));
  });

  it('filters to the requested session only', () => {
    const events = [
      evt(1, 'SESSION_CREATED', 'session', 'S'),
      { ...evt(1, 'SESSION_CREATED', 'session', 'OTHER'), sessionId: 'OTHER' },
    ];
    const trace = buildActivityTrace('S', events);
    expect(trace.entries).toHaveLength(1);
    expect(trace.entries[0]!.aggregateId).toBe('S');
  });

  it('is deterministic — same events yield the same trace', () => {
    const events = [evt(1, 'SESSION_CREATED', 'session', 'S'), evt(2, 'SESSION_COMPLETED', 'session', 'S')];
    expect(buildActivityTrace('S', events)).toEqual(buildActivityTrace('S', events));
  });

  it('empty events → empty trace', () => {
    expect(buildActivityTrace('S', []).entries).toEqual([]);
  });
});
