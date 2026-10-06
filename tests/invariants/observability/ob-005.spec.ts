// OB-005 — Runtime projection / read-model không phải authority; không có đường ghi
// vào state authoritative.
//
// Enforced by RuntimeProjection (P9.2): computeRuntimeProjection is a pure reducer of a
// plain-data RuntimeInput → a read-model DTO. It holds no repository handle, exposes no
// mutator, and the DTO it returns is inert data a consumer cannot write back through.
import { describe, it, expect } from 'vitest';
import {
  computeRuntimeProjection,
  type RuntimeInput,
} from '@codeforge/agent-core';

function input(over: Partial<RuntimeInput> = {}): RuntimeInput {
  return {
    sessionId: 'S', sessionState: 'RUNNING', goalId: 'G', graphVersion: 1,
    workspaceRevisionId: 'R', tasks: [], edges: [], activeRuns: [], ...over,
  };
}

describe('OB-005 — runtime projection is not authority', () => {
  it('the projection is a pure reducer — input is plain data, output has no callable', () => {
    const p = computeRuntimeProjection(input({
      tasks: [{ taskId: 'a', state: 'PASSED', attempts: 1 }],
    }));
    // No part of the read-model is a function / handle (nothing to call to mutate state).
    const walk = (v: unknown): void => {
      if (typeof v === 'function') throw new Error('projection exposed a callable');
      if (v && typeof v === 'object') for (const x of Object.values(v)) walk(x);
    };
    walk(p);
    expect(p.sessionId).toBe('S'); // derived view only
  });

  it('deriving a projection does not mutate its input', () => {
    const i = input({ tasks: [{ taskId: 'b', state: 'READY', attempts: 0 }, { taskId: 'a', state: 'PASSED', attempts: 1 }] });
    const snapshot = JSON.stringify(i);
    computeRuntimeProjection(i);
    expect(JSON.stringify(i)).toEqual(snapshot);
  });
});
