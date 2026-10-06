// P9.9 — InterventionRecord.buildInterventionRecord (pure audit record builder).
import { describe, it, expect } from 'vitest';
import {
  buildInterventionRecord,
  ControlPlane,
  type ControlRequest,
  type ControlStateInput,
} from '@codeforge/agent-core';

const plane = new ControlPlane();

function req(over: Partial<ControlRequest> & Pick<ControlRequest, 'intent'>): ControlRequest {
  return { sessionId: 'S', requestedBy: { kind: 'user', id: 'u1', surface: 'telegram' }, ...over };
}
function st(sessionState: ControlStateInput['sessionState'], toolCallState?: ControlStateInput['toolCallState']): ControlStateInput {
  return { sessionId: 'S', sessionState, ...(toolCallState !== undefined ? { toolCallState } : {}) };
}

describe('P9.9 buildInterventionRecord', () => {
  it('records an admitted-but-not-yet-executed intervention as "admitted"', () => {
    const request = req({ intent: 'pause' });
    const admission = plane.admit(request, st('RUNNING'));
    const rec = buildInterventionRecord({ interventionId: 'IV1', request, admission, at: 't' });
    expect(rec).toMatchObject({
      interventionId: 'IV1', sessionId: 'S', intent: 'pause',
      actor: { kind: 'user', id: 'u1', surface: 'telegram' },
      at: 't', result: 'admitted',
    });
    expect(rec.rejectReason).toBeUndefined();
  });

  it('records an executed intervention as "applied"', () => {
    const request = req({ intent: 'cancel' });
    const admission = plane.admit(request, st('RUNNING'));
    const rec = buildInterventionRecord({ interventionId: 'IV2', request, admission, at: 't', executionOutcome: 'applied' });
    expect(rec.result).toBe('applied');
  });

  it('records a failed execution as "failed"', () => {
    const request = req({ intent: 'cancel' });
    const admission = plane.admit(request, st('RUNNING'));
    const rec = buildInterventionRecord({ interventionId: 'IV3', request, admission, at: 't', executionOutcome: 'failed' });
    expect(rec.result).toBe('failed');
  });

  it('records a rejected request with its reason and no execution', () => {
    const request = req({ intent: 'resume' }); // not admissible from RUNNING
    const admission = plane.admit(request, st('RUNNING'));
    const rec = buildInterventionRecord({ interventionId: 'IV4', request, admission, at: 't' });
    expect(rec.result).toBe('rejected');
    expect(rec.rejectReason).toBe('NOT_APPLICABLE');
  });

  it('carries target ids and reason from the request (approve/deny with reason)', () => {
    const request = req({ intent: 'deny', toolCallId: 'TC1', reason: 'unsafe' });
    const admission = plane.admit(request, st('RUNNING', 'APPROVAL_PENDING'));
    const rec = buildInterventionRecord({ interventionId: 'IV5', request, admission, at: 't', executionOutcome: 'applied' });
    expect(rec.toolCallId).toBe('TC1');
    expect(rec.reason).toBe('unsafe');
    expect(rec.result).toBe('applied');
  });

  it('is deterministic — same input yields the same record', () => {
    const request = req({ intent: 'checkpoint' });
    const admission = plane.admit(request, st('RUNNING'));
    const a = buildInterventionRecord({ interventionId: 'IV6', request, admission, at: 't' });
    const b = buildInterventionRecord({ interventionId: 'IV6', request, admission, at: 't' });
    expect(a).toEqual(b);
  });
});
