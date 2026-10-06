// P9-I1 — SessionStateControlGate: derives the orchestrator control signal from the
// authoritative session state (single source of truth).
import { describe, it, expect } from 'vitest';
import { SessionStateControlGate } from '@codeforge/infrastructure';
import type { Session, SessionRepository, SessionState } from '@codeforge/agent-core';

function session(state: SessionState): Session {
  return {
    sessionId: 'S', workspaceId: 'W', workspaceRoot: '/r', goalId: 'G', graphVersion: 1,
    state, createdAt: 't', updatedAt: 't', runtimeVersion: '0.9.0', schemaVersion: 1,
    budgetId: 'B', lockId: 'L',
    metadata: { hostname: 'h', processId: 1, ollamaEndpoint: 'x',
      ollamaModels: { planner: 'p', critic: 'c', executor: 'e', analyzer: 'a' } },
  };
}

/** A mutable fake repo whose state the test flips to simulate control actions. */
class FakeSessions implements SessionRepository {
  constructor(public current: Session | null) {}
  async getById(): Promise<Session | null> { return this.current; }
  async create(): Promise<void> {}
  async getActiveByWorkspace(): Promise<Session | null> { return this.current; }
  async update(): Promise<void> {}
}

const noSleep = async (): Promise<void> => undefined;

describe('P9-I1 SessionStateControlGate — poll', () => {
  it('maps PAUSED -> pause, CANCELLING/ABORTED -> cancel, else none', async () => {
    const check = async (state: SessionState, kind: string): Promise<void> => {
      const gate = new SessionStateControlGate({ sessions: new FakeSessions(session(state)) });
      expect((await gate.poll('S')).kind).toBe(kind);
    };
    await check('RUNNING', 'none');
    await check('PAUSED', 'pause');
    await check('CANCELLING', 'cancel');
    await check('ABORTED', 'cancel');
    await check('AWAITING_HUMAN', 'none');
  });

  it('reports none for an unknown session', async () => {
    const gate = new SessionStateControlGate({ sessions: new FakeSessions(null) });
    expect((await gate.poll('S')).kind).toBe('none');
  });
});

describe('P9-I1 SessionStateControlGate — awaitResume', () => {
  it('resolves resume once the session leaves PAUSED (back to RUNNING)', async () => {
    const repo = new FakeSessions(session('PAUSED'));
    const gate = new SessionStateControlGate({ sessions: repo, sleep: noSleep, pollIntervalMs: 1 });
    // Flip to RUNNING after the first poll.
    let polls = 0;
    const orig = repo.getById.bind(repo);
    repo.getById = async () => { polls += 1; if (polls >= 2) repo.current = session('RUNNING'); return orig(); };
    expect(await gate.awaitResume('S')).toBe('resume');
  });

  it('resolves cancel when the session reaches CANCELLING', async () => {
    const repo = new FakeSessions(session('PAUSED'));
    const gate = new SessionStateControlGate({ sessions: repo, sleep: noSleep, pollIntervalMs: 1 });
    let polls = 0;
    const orig = repo.getById.bind(repo);
    repo.getById = async () => { polls += 1; if (polls >= 2) repo.current = session('CANCELLING'); return orig(); };
    expect(await gate.awaitResume('S')).toBe('cancel');
  });

  it('fails safe to cancel when the wait budget expires (stuck pause)', async () => {
    const repo = new FakeSessions(session('PAUSED'));
    let clock = 0;
    const gate = new SessionStateControlGate({
      sessions: repo, sleep: noSleep, pollIntervalMs: 10, maxWaitMs: 30,
      nowMs: () => (clock += 20), // advances past the 30ms budget within a few polls
    });
    expect(await gate.awaitResume('S')).toBe('cancel');
  });
});
