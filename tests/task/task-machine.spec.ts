// P1-SM1 TaskStateMachine — pure transitions (SM-001..003, SM-005).
import { describe, it, expect } from 'vitest';
import { transitionTask, isTaskTerminal } from '@codeforge/agent-core';
import type { TaskState } from '@codeforge/agent-core';

describe('transitionTask — happy path (SM-TASK §4.3)', () => {
  it('PENDING -> READY -> RUNNING -> VERIFYING -> PASSED', () => {
    expect(transitionTask('PENDING', 'DEPS_SATISFIED')).toMatchObject({ ok: true, next: 'READY' });
    expect(transitionTask('READY', 'SCHEDULED')).toMatchObject({ ok: true, next: 'RUNNING' });
    expect(transitionTask('RUNNING', 'RUN_ENDED_OK')).toMatchObject({ ok: true, next: 'VERIFYING' });
    expect(
      transitionTask('VERIFYING', 'VERIFICATION_PASSED', { reportValid: true, fresh: true }),
    ).toMatchObject({ ok: true, next: 'PASSED' });
  });

  it('failure + analysis + recovery loop', () => {
    expect(transitionTask('RUNNING', 'RUN_ENDED_ABNORMAL')).toMatchObject({ ok: true, next: 'FAILED' });
    expect(transitionTask('FAILED', 'FAILURE_ANALYZED')).toMatchObject({ ok: true, next: 'FAILURE_ANALYZED' });
    expect(transitionTask('FAILURE_ANALYZED', 'RECOVERY_CHOSEN')).toMatchObject({ ok: true, next: 'RECOVERY' });
    expect(transitionTask('RECOVERY', 'RECOVERY_ENDED')).toMatchObject({ ok: true, next: 'RUNNING' });
  });
});

describe('transitionTask — SM-001 determinism', () => {
  it('same (state,event,ctx) yields the same result', () => {
    const a = transitionTask('VERIFYING', 'VERIFICATION_PASSED', { reportValid: true, fresh: true });
    const b = transitionTask('VERIFYING', 'VERIFICATION_PASSED', { reportValid: true, fresh: true });
    expect(a).toEqual(b);
  });
});

describe('transitionTask — SM-002 / SM-L1 no unverified PASS', () => {
  it('RUNNING -> PASSED is not allowed directly', () => {
    // No event takes RUNNING straight to PASSED; RUN_ENDED_OK goes to VERIFYING.
    expect(transitionTask('RUNNING', 'RUN_ENDED_OK')).toMatchObject({ next: 'VERIFYING' });
  });
  it('VERIFYING -> PASSED requires a valid report', () => {
    expect(transitionTask('VERIFYING', 'VERIFICATION_PASSED', { reportValid: false, fresh: true }))
      .toMatchObject({ ok: false, code: 'GUARD_FAILED' });
  });
  it('VERIFYING -> PASSED requires a fresh report (no revision drift)', () => {
    expect(transitionTask('VERIFYING', 'VERIFICATION_PASSED', { reportValid: true, fresh: false }))
      .toMatchObject({ ok: false, code: 'GUARD_FAILED' });
  });
});

describe('transitionTask — SM-003 / SM-L3 terminal absorbing', () => {
  it('no transition out of PASSED / SUPERSEDED / ABORTED', () => {
    for (const t of ['PASSED', 'SUPERSEDED', 'ABORTED'] as TaskState[]) {
      expect(transitionTask(t, 'ABORT')).toMatchObject({ ok: false, code: 'TERMINAL_STATE' });
      expect(isTaskTerminal(t)).toBe(true);
    }
    expect(isTaskTerminal('RUNNING')).toBe(false);
  });
});

describe('transitionTask — SM-005 / SM-L5 AWAITING_HUMAN exits', () => {
  it('HUMAN_DECIDED needs a recorded decision', () => {
    expect(transitionTask('AWAITING_HUMAN', 'HUMAN_DECIDED', {})).toMatchObject({
      ok: false,
      code: 'GUARD_FAILED',
    });
  });
  it('HUMAN_DECIDED resume -> RUNNING, abort -> ABORTED', () => {
    expect(
      transitionTask('AWAITING_HUMAN', 'HUMAN_DECIDED', { humanDecisionRecorded: true, humanDecision: 'resume' }),
    ).toMatchObject({ ok: true, next: 'RUNNING' });
    expect(
      transitionTask('AWAITING_HUMAN', 'HUMAN_DECIDED', { humanDecisionRecorded: true, humanDecision: 'abort' }),
    ).toMatchObject({ ok: true, next: 'ABORTED' });
  });
  it('HUMAN_OVERRIDE_PASSED -> PASSED only with override committed (SM-L2/L10)', () => {
    expect(transitionTask('AWAITING_HUMAN', 'HUMAN_OVERRIDE_PASSED', {})).toMatchObject({
      ok: false,
      code: 'GUARD_FAILED',
    });
    expect(
      transitionTask('AWAITING_HUMAN', 'HUMAN_OVERRIDE_PASSED', { overrideCommitted: true }),
    ).toMatchObject({ ok: true, next: 'PASSED' });
  });
  it('CANCEL_REQUESTED -> ABORTED without a decision (the escape hatch)', () => {
    expect(transitionTask('AWAITING_HUMAN', 'CANCEL_REQUESTED')).toMatchObject({ ok: true, next: 'ABORTED' });
  });
});

describe('transitionTask — universal ABORT / SUPERSEDE (EX-006)', () => {
  it('ABORT from any non-terminal -> ABORTED', () => {
    for (const s of ['PENDING', 'READY', 'RUNNING', 'VERIFYING', 'AWAITING_HUMAN'] as TaskState[]) {
      expect(transitionTask(s, 'ABORT')).toMatchObject({ ok: true, next: 'ABORTED' });
    }
  });
  it('SUPERSEDE requires supersedeValid (no RUNNING run)', () => {
    expect(transitionTask('PENDING', 'SUPERSEDE', {})).toMatchObject({ ok: false, code: 'GUARD_FAILED' });
    expect(transitionTask('PENDING', 'SUPERSEDE', { supersedeValid: true })).toMatchObject({
      ok: true,
      next: 'SUPERSEDED',
    });
  });
});

describe('transitionTask — SM-L8 DEP_UNREACHABLE + invalid transitions', () => {
  it('PENDING -> ABORTED on DEP_UNREACHABLE (no infinite PENDING)', () => {
    expect(transitionTask('PENDING', 'DEP_UNREACHABLE')).toMatchObject({ ok: true, next: 'ABORTED' });
  });
  it('rejects an undeclared (state,event)', () => {
    expect(transitionTask('PENDING', 'SCHEDULED')).toMatchObject({ ok: false, code: 'INVALID_TRANSITION' });
    expect(transitionTask('READY', 'VERIFICATION_PASSED')).toMatchObject({ ok: false, code: 'INVALID_TRANSITION' });
  });
});
