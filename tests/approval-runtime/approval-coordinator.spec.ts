// P10.5 — NodeApprovalCoordinator: pause to AWAITING_HUMAN, await the tool decision,
// resume to RUNNING. Uses fakes (no DB, no clock) for determinism.
import { describe, it, expect } from 'vitest';
import { NodeApprovalCoordinator } from '@codeforge/infrastructure';

/** A fake tool-call store whose state flips after N polls. */
function fakeToolCalls(stateSequence: string[]): { getById: (id: string) => Promise<{ state: string } | null> } {
  let i = 0;
  return {
    getById: async () => {
      const state = stateSequence[Math.min(i, stateSequence.length - 1)]!;
      i++;
      return { state };
    },
  };
}

function fakeSession(): { transition: (id: string, ev: string, ctx?: Record<string, unknown>) => Promise<unknown>; events: Array<{ ev: string; ctx?: Record<string, unknown> }> } {
  const events: Array<{ ev: string; ctx?: Record<string, unknown> }> = [];
  return {
    events,
    transition: async (_id, ev, ctx) => { events.push({ ev, ...(ctx ? { ctx } : {}) }); return undefined; },
  };
}

const fastClock = { pollIntervalMs: 1, sleep: async () => {} };

describe('P10.5 NodeApprovalCoordinator', () => {
  it('approved: pauses to AWAITING_HUMAN, resumes to RUNNING, returns approved', async () => {
    const session = fakeSession();
    const coord = new NodeApprovalCoordinator({
      toolCalls: fakeToolCalls(['APPROVAL_PENDING', 'APPROVAL_PENDING', 'APPROVED']),
      sessionService: session, ...fastClock,
    });

    const decision = await coord.awaitDecision('S', 'TC1');

    expect(decision).toBe('approved');
    expect(session.events[0]?.ev).toBe('HUMAN_REQUIRED');
    const last = session.events[session.events.length - 1];
    expect(last?.ev).toBe('HUMAN_DECIDED');
    expect(last?.ctx).toEqual({ humanDecisionRecorded: true });
  });

  it('denied: returns denied and still resumes the session', async () => {
    const session = fakeSession();
    const coord = new NodeApprovalCoordinator({
      toolCalls: fakeToolCalls(['APPROVAL_PENDING', 'DENIED']),
      sessionService: session, ...fastClock,
    });

    const decision = await coord.awaitDecision('S', 'TC1');

    expect(decision).toBe('denied');
    expect(session.events.map((e) => e.ev)).toContain('HUMAN_DECIDED');
  });

  it('timeout: returns timeout when no decision arrives within the budget', async () => {
    const session = fakeSession();
    let t = 0;
    const coord = new NodeApprovalCoordinator({
      toolCalls: fakeToolCalls(['APPROVAL_PENDING']), // never decides
      sessionService: session,
      pollIntervalMs: 1,
      maxWaitMs: 5,
      nowMs: () => (t += 3), // advances past the 5ms budget quickly
      sleep: async () => {},
    });

    const decision = await coord.awaitDecision('S', 'TC1');
    expect(decision).toBe('timeout');
  });

  it('does not throw when the session transition is rejected (best-effort)', async () => {
    const throwingSession = {
      transition: async () => { throw new Error('not in RUNNING'); },
    };
    const coord = new NodeApprovalCoordinator({
      toolCalls: fakeToolCalls(['APPROVED']),
      sessionService: throwingSession, ...fastClock,
    });
    await expect(coord.awaitDecision('S', 'TC1')).resolves.toBe('approved');
  });
});
