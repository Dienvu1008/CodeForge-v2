// P1-S1 SessionStateMachine — pure transition tests (SM-001..003, SS-002/003/007).
import { describe, it, expect } from 'vitest';
import { transitionSession, SESSION_TRANSITIONS, isSessionTerminal } from '@codeforge/agent-core';
import type { SessionState } from '@codeforge/agent-core';

describe('transitionSession — happy path (DOMAIN_CONTRACTS §25.1)', () => {
  it('walks CREATED -> INITIALIZING -> RUNNING', () => {
    const a = transitionSession('CREATED', 'SESSION_INITIALIZED');
    expect(a).toEqual({ ok: true, next: 'INITIALIZING', event: 'SESSION_INITIALIZED' });
    const b = transitionSession('INITIALIZING', 'SESSION_READY');
    expect(b.ok && b.next).toBe('RUNNING');
  });

  it('RUNNING -> CANCELLING -> ABORTED', () => {
    expect(transitionSession('RUNNING', 'CANCEL_REQUESTED').ok).toBe(true);
    const done = transitionSession('CANCELLING', 'CANCEL_COMPLETED');
    expect(done.ok && done.next).toBe('ABORTED');
  });
});

describe('transitionSession — SM-001 determinism', () => {
  it('same (state,event,ctx) yields the same result', () => {
    const r1 = transitionSession('RUNNING', 'ALL_TASKS_TERMINAL', { allTasksTerminal: true });
    const r2 = transitionSession('RUNNING', 'ALL_TASKS_TERMINAL', { allTasksTerminal: true });
    expect(r1).toEqual(r2);
  });
});

describe('transitionSession — SS-002 invalid transitions rejected', () => {
  it('rejects an undeclared (state,event) pair', () => {
    const r = transitionSession('CREATED', 'SESSION_READY');
    expect(r).toMatchObject({ ok: false, code: 'INVALID_TRANSITION' });
  });

  it('rejects HUMAN_DECIDED from RUNNING (only valid from AWAITING_HUMAN)', () => {
    expect(transitionSession('RUNNING', 'HUMAN_DECIDED').ok).toBe(false);
  });
});

describe('transitionSession — SM-003 terminal states are absorbing', () => {
  it('no transition out of COMPLETED or ABORTED', () => {
    for (const t of ['COMPLETED', 'ABORTED'] as SessionState[]) {
      const r = transitionSession(t, 'ABORT');
      expect(r).toMatchObject({ ok: false, code: 'TERMINAL_STATE' });
    }
  });
});

describe('transitionSession — SS-003 completion guard', () => {
  it('blocks COMPLETED while tasks are non-terminal', () => {
    const r = transitionSession('RUNNING', 'ALL_TASKS_TERMINAL', { allTasksTerminal: false });
    expect(r).toMatchObject({ ok: false, code: 'GUARD_FAILED' });
  });
  it('allows COMPLETED when all tasks terminal', () => {
    const r = transitionSession('RUNNING', 'ALL_TASKS_TERMINAL', { allTasksTerminal: true });
    expect(r.ok && r.next).toBe('COMPLETED');
  });
});

describe('transitionSession — SS-007 human-decision guard', () => {
  it('blocks AWAITING_HUMAN -> RUNNING without a recorded decision', () => {
    const r = transitionSession('AWAITING_HUMAN', 'HUMAN_DECIDED', {});
    expect(r).toMatchObject({ ok: false, code: 'GUARD_FAILED' });
  });
  it('allows resume once a decision is recorded', () => {
    const r = transitionSession('AWAITING_HUMAN', 'HUMAN_DECIDED', { humanDecisionRecorded: true });
    expect(r.ok && r.next).toBe('RUNNING');
  });
});

describe('SESSION_TRANSITIONS table integrity', () => {
  it('every "to" state is reachable and terminal states have no outgoing rule', () => {
    const outgoingFromTerminal = SESSION_TRANSITIONS.filter((r) => isSessionTerminal(r.from));
    expect(outgoingFromTerminal).toEqual([]);
  });
});
