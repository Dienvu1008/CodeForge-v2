// OB-007 — Activity trace / observability chỉ phơi bày hoạt động + chứng cứ có cấu
// trúc đã redact; không reasoning thô, không secret.
//
// Enforced by ActivityTrace (P9.4): buildActivityTrace maps already-redacted events to
// structured entries (category + action + evidence refs). The entry shape has no field
// that could carry raw model reasoning, and evidence refs are id-style key=value pairs
// extracted from a whitelist of structured keys — never arbitrary payload content.
import { describe, it, expect } from 'vitest';
import { buildActivityTrace, type DomainEvent } from '@codeforge/agent-core';

function evt(seq: number, type: string, payload: unknown): DomainEvent {
  return {
    eventId: `E-${seq}`, sessionId: 'S', type,
    aggregate: { kind: 'task_run', id: 'TR1' }, payload,
    at: '2026-01-01T00:00:00.000Z', sequenceNumber: seq,
  };
}

describe('OB-007 — activity trace exposes structured evidence, not raw reasoning', () => {
  it('a trace entry has only structured fields — no chain-of-thought', () => {
    const trace = buildActivityTrace('S', [evt(1, 'TASK_RUN_STARTED', { taskId: 'T1' })]);
    const entry = trace.entries[0]!;
    const keys = Object.keys(entry).sort();
    expect(keys).toEqual(['action', 'aggregateId', 'aggregateKind', 'at', 'category', 'eventType', 'evidenceRefs', 'sequenceNumber']);
    // Explicitly: no raw-reasoning fields.
    expect('reasoning' in entry).toBe(false);
    expect('thought' in entry).toBe(false);
    expect('rationale' in entry).toBe(false);
  });

  it('only whitelisted structured keys become evidence — arbitrary payload content is not surfaced', () => {
    const trace = buildActivityTrace('S', [
      evt(1, 'TASK_RUN_STARTED', { taskId: 'T1', secretThought: 'the model reasoned about X', apiKey: 'sk-xyz' }),
    ]);
    const refs = trace.entries[0]!.evidenceRefs.join(' ');
    expect(refs).toContain('taskId=T1');       // structured id surfaced
    expect(refs).not.toContain('secretThought'); // free-form content never surfaced
    expect(refs).not.toContain('apiKey');        // even if upstream redaction missed it
    expect(refs).not.toContain('sk-xyz');
  });
});
