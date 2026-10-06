// P9.7 — ControlPlane.admit (pure control admission). Enforces OB-006.
import { describe, it, expect } from 'vitest';
import {
  ControlPlane,
  type ControlRequest,
  type ControlStateInput,
  type ControlActor,
} from '@codeforge/agent-core';
import type { SessionState, ToolCallState } from '@codeforge/agent-core';

const plane = new ControlPlane();

type Surface = 'dashboard' | 'telegram' | 'vscode' | 'cli' | 'api';
const actor = (surface: Surface): ControlActor => ({ kind: 'user', id: 'u1', surface });

function req(over: Partial<ControlRequest> & Pick<ControlRequest, 'intent'>): ControlRequest {
  return { sessionId: 'S', requestedBy: actor('dashboard'), ...over };
}
function state(sessionState: SessionState, toolCallState?: ToolCallState): ControlStateInput {
  return { sessionId: 'S', sessionState, ...(toolCallState !== undefined ? { toolCallState } : {}) };
}

describe('P9.7 ControlPlane — pause/resume/cancel admission', () => {
  it('admits pause from RUNNING as a PAUSE_REQUESTED transition', () => {
    const r = plane.admit(req({ intent: 'pause' }), state('RUNNING'));
    expect(r).toEqual({ admitted: true, action: { kind: 'session_transition', sessionId: 'S', event: 'PAUSE_REQUESTED' } });
  });

  it('rejects pause when not RUNNING', () => {
    expect(plane.admit(req({ intent: 'pause' }), state('PAUSED'))).toMatchObject({ admitted: false, reason: 'NOT_APPLICABLE' });
  });

  it('admits resume from PAUSED', () => {
    const r = plane.admit(req({ intent: 'resume' }), state('PAUSED'));
    expect(r).toMatchObject({ admitted: true, action: { event: 'RESUME_REQUESTED' } });
  });

  it('admits cancel from RUNNING, PAUSED, and AWAITING_HUMAN', () => {
    for (const s of ['RUNNING', 'PAUSED', 'AWAITING_HUMAN'] as SessionState[]) {
      expect(plane.admit(req({ intent: 'cancel' }), state(s))).toMatchObject({
        admitted: true, action: { event: 'CANCEL_REQUESTED' },
      });
    }
  });

  it('rejects any control on a terminal session', () => {
    for (const s of ['COMPLETED', 'ABORTED'] as SessionState[]) {
      expect(plane.admit(req({ intent: 'pause' }), state(s))).toMatchObject({ admitted: false, reason: 'SESSION_TERMINAL' });
      expect(plane.admit(req({ intent: 'cancel' }), state(s))).toMatchObject({ admitted: false, reason: 'SESSION_TERMINAL' });
    }
  });

  it('rejects a stale request (expectedSessionState disagrees)', () => {
    const r = plane.admit(req({ intent: 'pause', expectedSessionState: 'PAUSED' }), state('RUNNING'));
    expect(r).toMatchObject({ admitted: false, reason: 'STALE_STATE' });
  });
});

describe('P9.7 ControlPlane — approve/deny admission', () => {
  it('admits approve of a tool call awaiting a decision', () => {
    const r = plane.admit(req({ intent: 'approve', toolCallId: 'TC1' }), state('RUNNING', 'APPROVAL_PENDING'));
    expect(r).toEqual({
      admitted: true,
      action: { kind: 'tool_decision', toolCallId: 'TC1', decision: 'approve', decidedBy: 'user' },
    });
  });

  it('admits deny with a reason carried into the action', () => {
    const r = plane.admit(req({ intent: 'deny', toolCallId: 'TC1', reason: 'unsafe' }), state('RUNNING', 'APPROVAL_PENDING'));
    expect(r).toMatchObject({ admitted: true, action: { decision: 'deny', reason: 'unsafe' } });
  });

  it('rejects approve/deny without a target tool call', () => {
    expect(plane.admit(req({ intent: 'approve' }), state('RUNNING'))).toMatchObject({ admitted: false, reason: 'MISSING_TARGET' });
  });

  it('rejects approve/deny when the tool call is not APPROVAL_PENDING', () => {
    expect(plane.admit(req({ intent: 'approve', toolCallId: 'TC1' }), state('RUNNING', 'APPROVED')))
      .toMatchObject({ admitted: false, reason: 'TOOL_NOT_PENDING' });
  });
});

describe('P9.7 ControlPlane — retry/checkpoint admission', () => {
  it('admits retry of a task on a live session', () => {
    const r = plane.admit(req({ intent: 'retry', taskId: 'T1' }), state('RUNNING'));
    expect(r).toEqual({ admitted: true, action: { kind: 'retry_task', sessionId: 'S', taskId: 'T1' } });
  });

  it('rejects retry without a target task', () => {
    expect(plane.admit(req({ intent: 'retry' }), state('RUNNING'))).toMatchObject({ admitted: false, reason: 'MISSING_TARGET' });
  });

  it('admits checkpoint on a live session', () => {
    expect(plane.admit(req({ intent: 'checkpoint' }), state('RUNNING'))).toMatchObject({
      admitted: true, action: { kind: 'checkpoint', sessionId: 'S' },
    });
  });
});

describe('P9.7 ControlPlane — one control path (OB-006)', () => {
  it('a dashboard request and a telegram request admit IDENTICALLY', () => {
    const fromDashboard = plane.admit(
      { intent: 'pause', sessionId: 'S', requestedBy: actor('dashboard') }, state('RUNNING'),
    );
    const fromTelegram = plane.admit(
      { intent: 'pause', sessionId: 'S', requestedBy: actor('telegram') }, state('RUNNING'),
    );
    // The surface is audit-only; the admitted action is the same.
    expect(fromDashboard).toEqual(fromTelegram);
  });

  it('admission is pure — same (request,state) yields the same result', () => {
    const r = req({ intent: 'cancel' });
    const s = state('RUNNING');
    expect(plane.admit(r, s)).toEqual(plane.admit(r, s));
  });

  it('a rejected request produces no action (nothing to execute on the kernel)', () => {
    const r = plane.admit(req({ intent: 'resume' }), state('RUNNING'));
    expect(r.admitted).toBe(false);
    expect('action' in r).toBe(false);
  });
});
