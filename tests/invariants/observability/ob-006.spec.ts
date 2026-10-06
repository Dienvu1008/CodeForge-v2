// OB-006 — Mọi control request phải qua ControlPlane admission + Policy; UI không có
// authority riêng.
//
// Enforced by ControlPlane (P9.7): admit() is the single admission point. A request from
// any surface (dashboard, telegram, vscode, cli) with the same intent + target admits to
// the SAME kernel action — the surface is audit-only and never changes the outcome. A
// request that is not admissible yields NO action, so a UI cannot reach a kernel mutator
// without passing admission.
import { describe, it, expect } from 'vitest';
import {
  ControlPlane,
  type ControlRequest,
  type ControlStateInput,
} from '@codeforge/agent-core';

const plane = new ControlPlane();

type Surface = 'dashboard' | 'telegram' | 'vscode' | 'cli' | 'api';
function request(surface: Surface, intent: ControlRequest['intent']): ControlRequest {
  return { intent, sessionId: 'S', requestedBy: { kind: 'user', id: 'u', surface } };
}
const running: ControlStateInput = { sessionId: 'S', sessionState: 'RUNNING' };

describe('OB-006 — control requests pass through ControlPlane admission', () => {
  it('the same intent from different UIs admits to the identical kernel action', () => {
    const surfaces = ['dashboard', 'telegram', 'vscode', 'cli'] as const;
    const results = surfaces.map((s) => plane.admit(request(s, 'pause'), running));
    // Every surface yields the same admitted action — no UI has private authority.
    for (const r of results) expect(r).toEqual(results[0]);
    expect(results[0]).toMatchObject({ admitted: true, action: { kind: 'session_transition', event: 'PAUSE_REQUESTED' } });
  });

  it('a non-admissible control request produces no kernel action', () => {
    // resume is only admissible from PAUSED; from RUNNING it must be rejected with no action.
    const r = plane.admit(request('telegram', 'resume'), running);
    expect(r.admitted).toBe(false);
    expect('action' in r).toBe(false);
  });

  it('admission reads only the request + current state (deterministic, no surface effect)', () => {
    const a = plane.admit(request('dashboard', 'cancel'), running);
    const b = plane.admit(request('cli', 'cancel'), running);
    expect(a).toEqual(b);
  });
});
