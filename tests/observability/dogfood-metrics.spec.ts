// P9.12 — DogfoodMetrics.computeSessionMetrics (pure per-session behavior metrics).
import { describe, it, expect } from 'vitest';
import { computeSessionMetrics, type DomainEvent, type ContextSnapshot } from '@codeforge/agent-core';

function evt(seq: number, type: string, kind: DomainEvent['aggregate']['kind'], id: string, payload: unknown = {}, at?: string): DomainEvent {
  return {
    eventId: `E-${seq}`, sessionId: 'S', type, aggregate: { kind, id }, payload,
    at: at ?? `2026-01-01T00:00:${String(seq).padStart(2, '0')}.000Z`, sequenceNumber: seq,
  };
}

const SESSION: DomainEvent[] = [
  evt(1, 'SESSION_CREATED', 'session', 'S'),
  evt(2, 'TASK_CREATED', 'task', 'T1'),
  evt(3, 'GRAPH_MUTATION_COMMITTED', 'graph', 'GR', { graphVersion: 2 }),
  evt(4, 'TASK_RUN_STARTED', 'task_run', 'TR1', { taskId: 'T1' }),
  evt(5, 'TOOL_CALL_REQUESTED', 'tool_call', 'TC1', { toolCallId: 'TC1' }),
  evt(6, 'TOOL_CALL_APPROVED', 'tool_call', 'TC1', { toolCallId: 'TC1' }),
  evt(7, 'TOOL_CALL_STARTED', 'tool_call', 'TC1', { toolCallId: 'TC1' }),
  evt(8, 'TOOL_CALL_ENDED', 'tool_call', 'TC1', { toolCallId: 'TC1', state: 'SUCCEEDED' }),
  evt(9, 'VERIFICATION_STARTED', 'verification', 'V1'),
  evt(10, 'VERIFICATION_ENDED', 'verification', 'V1', { status: 'PASS' }),
  evt(11, 'TASK_RUN_ENDED', 'task_run', 'TR1', { taskId: 'T1' }),
  evt(12, 'CHECKPOINT_CREATED', 'session', 'S'),
  evt(13, 'SESSION_COMPLETED', 'session', 'S', {}, '2026-01-01T00:00:30.000Z'),
];

describe('P9.12 computeSessionMetrics — counts + outcome', () => {
  it('counts task runs, tools, verification, checkpoints, graph mutations', () => {
    const m = computeSessionMetrics('S', SESSION);
    expect(m.eventCount).toBe(13);
    expect(m.outcome).toBe('COMPLETED');
    expect(m.taskRunsStarted).toBe(1);
    expect(m.taskRunsEnded).toBe(1);
    expect(m.tasksCreated).toBe(1);
    expect(m.tools).toEqual({ requested: 1, approved: 1, denied: 0, started: 1, ended: 1 });
    expect(m.verification).toEqual({ started: 1, ended: 1, passed: 1, failed: 0 });
    expect(m.graphMutationsCommitted).toBe(1);
    expect(m.checkpointsCreated).toBe(1);
  });

  it('computes the wall-clock span from first to last event', () => {
    const m = computeSessionMetrics('S', SESSION);
    expect(m.spanMs).toBe(29000); // 00:00:01 -> 00:00:30
  });

  it('reports ABORTED outcome and counts failed verification', () => {
    const m = computeSessionMetrics('S', [
      evt(1, 'VERIFICATION_ENDED', 'verification', 'V1', { status: 'FAIL' }),
      evt(2, 'SESSION_ABORTED', 'session', 'S'),
    ]);
    expect(m.outcome).toBe('ABORTED');
    expect(m.verification.failed).toBe(1);
    expect(m.verification.passed).toBe(0);
  });

  it('infers task retries from repeated TASK_RUN_STARTED on the same task', () => {
    const m = computeSessionMetrics('S', [
      evt(1, 'TASK_RUN_STARTED', 'task_run', 'TRa', { taskId: 'T1' }),
      evt(2, 'TASK_RUN_STARTED', 'task_run', 'TRb', { taskId: 'T1' }),
      evt(3, 'TASK_RUN_STARTED', 'task_run', 'TRc', { taskId: 'T1' }),
      evt(4, 'TASK_RUN_STARTED', 'task_run', 'TRd', { taskId: 'T2' }),
    ]);
    expect(m.recovery.taskRetries).toBe(2); // T1 started 3x -> 2 retries; T2 once -> 0
  });

  it('counts failures, recovery actions, approvals, overrides, and control actions', () => {
    const m = computeSessionMetrics('S', [
      evt(1, 'FAILURE_DETECTED', 'failure', 'F1'),
      evt(2, 'RECOVERY_ACTION_CHOSEN', 'recovery', 'R1'),
      evt(3, 'HUMAN_APPROVAL_REQUESTED', 'tool_call', 'TC1'),
      evt(4, 'HUMAN_APPROVAL_GRANTED', 'tool_call', 'TC1'),
      evt(5, 'HUMAN_OVERRIDE_COMPLETED', 'task', 'T1'),
      evt(6, 'CONTROL_PAUSE_ADMITTED', 'session', 'S'),
    ]);
    expect(m.recovery.failuresDetected).toBe(1);
    expect(m.recovery.recoveryActions).toBe(1);
    expect(m.intervention).toEqual({
      approvalsRequested: 1, approvalsGranted: 1, approvalsDenied: 0, overrides: 1, controlActions: 1,
    });
  });

  it('includes context usage when a snapshot is supplied', () => {
    const snap = {
      snapshotId: 'SNAP', sessionId: 'S',
      workspaceRevision: { revisionId: 'R', canonicalFormVersion: 'v1', root: '/', includedPaths: [], excludedScratchPaths: [], hashAlgorithm: 'blake3', hash: 'H', fileCount: 0, totalBytes: 0, createdAt: 't', createdBy: { sessionId: 'S', reason: 'session_start' } },
      canonicalFormVersion: 'v1',
      items: [{ itemId: 'a', kind: 'memory', source: { kind: 'memory' }, content: 'x', tokenCount: 50, trust: 'untrusted', reason: 'r', provenance: { provenanceId: 'p', source: { kind: 'runtime', id: 'c' }, inputs: [], reason: 'r', at: 't' }, priority: 1, pinned: false, truncated: false }],
      tokenBudget: 200, tokenUsed: 50, builtBy: 'executor', builtAt: 't', buildReason: 'task_execution', policyVersion: 1, schemaVersion: 1,
    } as ContextSnapshot;
    const m = computeSessionMetrics('S', SESSION, snap);
    expect(m.context).toEqual({ tokenBudget: 200, tokenUsed: 50, pressure: 0.25, itemCount: 1 });
  });

  it('produces a deterministic event-type histogram and ignores other sessions', () => {
    const m = computeSessionMetrics('S', [
      evt(1, 'SESSION_CREATED', 'session', 'S'),
      evt(2, 'TASK_CREATED', 'task', 'T1'),
      evt(2, 'TASK_CREATED', 'task', 'T2'),
      { ...evt(1, 'SESSION_CREATED', 'session', 'X'), sessionId: 'OTHER' },
    ]);
    expect(m.eventCount).toBe(3); // OTHER excluded
    expect(m.eventTypeCounts).toEqual([
      { type: 'SESSION_CREATED', count: 1 },
      { type: 'TASK_CREATED', count: 2 },
    ]);
  });

  it('is deterministic — same events yield the same metrics', () => {
    expect(computeSessionMetrics('S', SESSION)).toEqual(computeSessionMetrics('S', SESSION));
  });

  it('empty events → zeroed metrics, no outcome', () => {
    const m = computeSessionMetrics('S', []);
    expect(m.eventCount).toBe(0);
    expect(m.spanMs).toBe(0);
    expect(m.outcome).toBeUndefined();
    expect(m.eventTypeCounts).toEqual([]);
  });
});
