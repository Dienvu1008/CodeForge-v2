// P9.10 — AuditTimeline.buildAuditTimeline (pure replay/audit view).
import { describe, it, expect } from 'vitest';
import { buildAuditTimeline, type DomainEvent } from '@codeforge/agent-core';

function evt(seq: number, type: string, kind: DomainEvent['aggregate']['kind'], id: string, payload: unknown = {}): DomainEvent {
  return {
    eventId: `E-${seq}`, sessionId: 'S', type,
    aggregate: { kind, id }, payload,
    at: `2026-01-01T00:00:0${seq}.000Z`, sequenceNumber: seq,
  };
}

const PIPELINE: DomainEvent[] = [
  evt(1, 'SESSION_CREATED', 'session', 'S'),
  evt(2, 'GOAL_CREATED', 'session', 'S', { goalId: 'G' }),
  evt(3, 'GRAPH_MUTATION_COMMITTED', 'graph', 'GR', { mutationId: 'M1', graphVersion: 2 }),
  evt(4, 'TASK_RUN_STARTED', 'task_run', 'TR1', { taskId: 'T1', taskRunId: 'TR1' }),
  evt(5, 'TOOL_CALL_ENDED', 'tool_call', 'TC1', { toolCallId: 'TC1', state: 'SUCCEEDED' }),
  evt(6, 'VERIFICATION_ENDED', 'verification', 'V1', { status: 'PASS', scope: 'AFFECTED_DIRECT' }),
  evt(7, 'SESSION_COMPLETED', 'session', 'S'),
];

describe('P9.10 buildAuditTimeline — phase + authority path', () => {
  it('tags each event with the correct pipeline phase', () => {
    const t = buildAuditTimeline('S', PIPELINE);
    expect(t.entries.map((e) => e.phase)).toEqual([
      'lifecycle', 'goal', 'plan', 'schedule', 'tool', 'verify', 'lifecycle',
    ]);
  });

  it('tags each event with the authority that produced/admitted it', () => {
    const t = buildAuditTimeline('S', PIPELINE);
    const byType = new Map(t.entries.map((e) => [e.eventType, e.authorityPath]));
    expect(byType.get('GRAPH_MUTATION_COMMITTED')).toBe('Planner->GraphCommit');
    expect(byType.get('TASK_RUN_STARTED')).toBe('Scheduler');
    expect(byType.get('TOOL_CALL_ENDED')).toBe('ToolGateway->Policy');
    expect(byType.get('VERIFICATION_ENDED')).toBe('VerificationEngine->CompletionGate');
    expect(byType.get('SESSION_COMPLETED')).toBe('SessionStateMachine');
  });

  it('maps control and approval events to their authority', () => {
    const t = buildAuditTimeline('S', [
      evt(1, 'CONTROL_PAUSE_ADMITTED', 'session', 'S'),
      evt(2, 'HUMAN_APPROVAL_GRANTED', 'tool_call', 'TC1', { toolCallId: 'TC1' }),
    ]);
    expect(t.entries[0]!.authorityPath).toBe('ControlPlane->Policy');
    expect(t.entries[0]!.phase).toBe('control');
    expect(t.entries[1]!.authorityPath).toBe('ApprovalEngine');
  });

  it('computes a deterministic phase-count summary', () => {
    const t = buildAuditTimeline('S', PIPELINE);
    expect(t.phaseCounts.lifecycle).toBe(2);
    expect(t.phaseCounts.plan).toBe(1);
    expect(t.phaseCounts.tool).toBe(1);
    expect(t.phaseCounts.verify).toBe(1);
    expect(t.phaseCounts.recovery).toBe(0);
  });

  it('carries evidence refs (ids) but no raw reasoning (OB-007)', () => {
    const t = buildAuditTimeline('S', [evt(1, 'TASK_RUN_STARTED', 'task_run', 'TR1', { taskId: 'T1', secret: 'reasoning' })]);
    const e = t.entries[0]!;
    expect(e.evidenceRefs).toContain('taskId=T1');
    expect(e.evidenceRefs.join(' ')).not.toContain('secret');
    expect('reasoning' in e).toBe(false);
  });

  it('is a deterministic replay — same events yield the same timeline', () => {
    expect(buildAuditTimeline('S', PIPELINE)).toEqual(buildAuditTimeline('S', PIPELINE));
  });

  it('empty events → empty timeline with zeroed phase counts', () => {
    const t = buildAuditTimeline('S', []);
    expect(t.entries).toEqual([]);
    expect(t.phaseCounts.tool).toBe(0);
  });
});
