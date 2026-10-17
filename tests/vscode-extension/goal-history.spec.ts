// goal-history (P12.23) — pure model binding submitted goals to runtime sessions (no vscode).
import { describe, it, expect } from 'vitest';
import {
  newGoalEntry, withGoalId, reconcileHistory, statusFromSessionState, statusChip,
  type GoalEntry, type BindableSession,
} from '../../packages/vscode-extension/src/goal-history.js';

describe('statusFromSessionState', () => {
  it('maps terminal success states to completed', () => {
    expect(statusFromSessionState('COMPLETED')).toBe('completed');
    expect(statusFromSessionState('succeeded')).toBe('completed');
  });
  it('maps terminal failure states to failed', () => {
    expect(statusFromSessionState('FAILED')).toBe('failed');
    expect(statusFromSessionState('ABORTED')).toBe('failed');
    expect(statusFromSessionState('cancelled')).toBe('failed');
  });
  it('treats anything else as running', () => {
    expect(statusFromSessionState('RUNNING')).toBe('running');
    expect(statusFromSessionState('PLANNING')).toBe('running');
  });
});

describe('newGoalEntry / withGoalId', () => {
  it('starts queued with no session', () => {
    const e = newGoalEntry('g1', 'do a thing', '2026-01-01T00:00:00.000Z');
    expect(e.status).toBe('queued');
    expect(e.sessionId).toBeUndefined();
    expect(e.goalId).toBeUndefined();
  });
  it('records the runtime goalId without changing status', () => {
    const e = withGoalId(newGoalEntry('g1', 'x', 't'), 'goal-42');
    expect(e.goalId).toBe('goal-42');
    expect(e.status).toBe('queued');
  });
});

describe('reconcileHistory', () => {
  const base = (localId: string, submittedAt: string): GoalEntry => newGoalEntry(localId, localId, submittedAt);

  it('binds a queued goal to the oldest session created at/after submit time', () => {
    const history = [base('g1', '2026-01-01T00:00:00.000Z')];
    const sessions: BindableSession[] = [
      { sessionId: 's1', state: 'RUNNING', createdAt: '2026-01-01T00:00:05.000Z' },
    ];
    const [out] = reconcileHistory(history, sessions);
    expect(out.sessionId).toBe('s1');
    expect(out.status).toBe('running');
  });

  it('does not bind a session created before the goal was submitted', () => {
    const history = [base('g1', '2026-01-01T00:00:10.000Z')];
    const sessions: BindableSession[] = [
      { sessionId: 's-old', state: 'COMPLETED', createdAt: '2026-01-01T00:00:00.000Z' },
    ];
    const [out] = reconcileHistory(history, sessions);
    expect(out.sessionId).toBeUndefined();
    expect(out.status).toBe('queued');
  });

  it('gives two goals two distinct sessions (first-come-first-served)', () => {
    const history = [
      base('g1', '2026-01-01T00:00:00.000Z'),
      base('g2', '2026-01-01T00:00:01.000Z'),
    ];
    const sessions: BindableSession[] = [
      { sessionId: 's1', state: 'COMPLETED', createdAt: '2026-01-01T00:00:02.000Z' },
      { sessionId: 's2', state: 'RUNNING', createdAt: '2026-01-01T00:00:03.000Z' },
    ];
    const out = reconcileHistory(history, sessions);
    expect(out.find((e) => e.localId === 'g1')?.sessionId).toBe('s1');
    expect(out.find((e) => e.localId === 'g2')?.sessionId).toBe('s2');
  });

  it('refreshes status for an already-bound goal when its session state changes', () => {
    const bound: GoalEntry = { ...base('g1', '2026-01-01T00:00:00.000Z'), sessionId: 's1', status: 'running' };
    const sessions: BindableSession[] = [
      { sessionId: 's1', state: 'COMPLETED', createdAt: '2026-01-01T00:00:05.000Z' },
    ];
    const [out] = reconcileHistory([bound], sessions);
    expect(out.status).toBe('completed');
  });

  it('keeps a bound entry untouched when its session is no longer listed', () => {
    const bound: GoalEntry = { ...base('g1', 't'), sessionId: 's1', status: 'running' };
    const [out] = reconcileHistory([bound], []);
    expect(out).toEqual(bound);
  });

  it('preserves submit order in the output', () => {
    const history = [
      base('g2', '2026-01-01T00:00:02.000Z'),
      base('g1', '2026-01-01T00:00:01.000Z'),
    ];
    const out = reconcileHistory(history, []);
    expect(out.map((e) => e.localId)).toEqual(['g1', 'g2']);
  });
});

describe('statusChip', () => {
  it('labels every status', () => {
    expect(statusChip('queued')).toBe('queued');
    expect(statusChip('running')).toBe('running');
    expect(statusChip('completed')).toBe('completed');
    expect(statusChip('failed')).toBe('failed');
  });
});
