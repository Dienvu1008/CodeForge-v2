// C9 — FakeModel acceptance (PHASE_0_ACCEPTANCE §3.12, FM-1..FM-8).
import { describe, it, expect } from 'vitest';
import { FakeModel } from '@codeforge/testing';
import { ModelError, type ModelRequest } from '@codeforge/agent-core';

function req(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    purpose: 'plan',
    systemPrompt: 'system',
    taskPrompt: 'do the thing',
    maxOutputTokens: 100,
    temperature: 0,
    ...overrides,
  };
}

describe('FakeModel — FM-1 implements ModelGateway', () => {
  it('exposes identity and generate()', () => {
    const m = new FakeModel();
    expect(m.identity.name).toBe('fake-model');
    expect(typeof m.generate).toBe('function');
  });
});

describe('FakeModel — FM-2 setResponse deterministic', () => {
  it('returns the mapped response for a matching prompt, repeatably', async () => {
    const m = new FakeModel();
    m.setResponse(/thing/, '{"ok":true}');
    const a = await m.generate(req());
    const b = await m.generate(req());
    expect(a.raw).toBe('{"ok":true}');
    expect(b.raw).toBe(a.raw);
  });

  it('matches on systemPrompt too', async () => {
    const m = new FakeModel();
    m.setResponse(/SECRET/, 'matched-system');
    const r = await m.generate(req({ systemPrompt: 'has SECRET marker', taskPrompt: 'x' }));
    expect(r.raw).toBe('matched-system');
  });
});

describe('FakeModel — FM-3 setSequence deterministic', () => {
  it('consumes responses in order', async () => {
    const m = new FakeModel();
    m.setSequence(['one', 'two', 'three']);
    expect((await m.generate(req())).raw).toBe('one');
    expect((await m.generate(req())).raw).toBe('two');
    expect((await m.generate(req())).raw).toBe('three');
  });

  it('falls back to rules/default after sequence is exhausted', async () => {
    const m = new FakeModel();
    m.setSequence(['only']);
    expect((await m.generate(req())).raw).toBe('only');
    // default echo (deterministic) once sequence is empty
    expect((await m.generate(req({ purpose: 'critique' }))).raw).toBe('{"purpose":"critique"}');
  });
});

describe('FakeModel — FM-4 setError throws typed error', () => {
  it('rejects with the queued ModelError once', async () => {
    const m = new FakeModel();
    m.setError(new ModelError('MODEL_TIMEOUT', 'slow'));
    await expect(m.generate(req())).rejects.toMatchObject({
      name: 'ModelError',
      code: 'MODEL_TIMEOUT',
    });
    // subsequent call no longer errors
    const r = await m.generate(req());
    expect(r.raw).toContain('purpose');
  });
});

describe('FakeModel — FM-6/FM-7 callCount & history', () => {
  it('tracks call count and history deterministically (no wall-clock)', async () => {
    const m = new FakeModel();
    await m.generate(req({ taskPrompt: 'first' }));
    await m.generate(req({ taskPrompt: 'second' }));
    expect(m.callCount).toBe(2);
    expect(m.lastPrompt).toBe('second');
    expect(m.history.map((h) => h.at)).toEqual([0, 1]); // logical index, not time
    expect(m.history[0]?.request.taskPrompt).toBe('first');
  });

  it('reset() clears state', async () => {
    const m = new FakeModel();
    await m.generate(req());
    m.reset();
    expect(m.callCount).toBe(0);
    expect(m.lastPrompt).toBeUndefined();
  });
});

describe('FakeModel — FM-8 no real LLM / no randomness', () => {
  it('default output is a pure function of the request purpose', async () => {
    const m1 = new FakeModel();
    const m2 = new FakeModel();
    const r1 = await m1.generate(req({ purpose: 'analyze_failure' }));
    const r2 = await m2.generate(req({ purpose: 'analyze_failure' }));
    expect(r1.raw).toBe(r2.raw);
    expect(r1.raw).toBe('{"purpose":"analyze_failure"}');
  });
});

// ---- P1-F1 extensions ----

describe('FakeModel — P1-F1 response functions (pure, deterministic)', () => {
  it('setResponse accepts a function of the request', async () => {
    const m = new FakeModel();
    m.setResponse(/thing/, (r) => `{"purpose":"${r.purpose}","echo":"${r.taskPrompt}"}`);
    const out = await m.generate(req({ taskPrompt: 'do the thing' }));
    expect(out.raw).toBe('{"purpose":"plan","echo":"do the thing"}');
  });

  it('setSequence accepts functions and fixed strings mixed', async () => {
    const m = new FakeModel();
    m.setSequence(['first', (r) => `second:${r.purpose}`]);
    expect((await m.generate(req())).raw).toBe('first');
    expect((await m.generate(req({ purpose: 'critique' }))).raw).toBe('second:critique');
  });
});

describe('FakeModel — P1-F1 logical delay (no wall-clock)', () => {
  it('records the configured delay on each call without sleeping', async () => {
    const m = new FakeModel();
    m.setDelay(500);
    const before = Date.now();
    await m.generate(req());
    await m.generate(req());
    const elapsed = Date.now() - before;
    // It did NOT actually sleep 1000ms — delays are logical metadata.
    expect(elapsed).toBeLessThan(500);
    expect(m.history.map((h) => h.delayMs)).toEqual([500, 500]);
    expect(m.totalDelayMs).toBe(1000);
  });

  it('setDelaySequence applies per-call latencies then falls back to setDelay', async () => {
    const m = new FakeModel();
    m.setDelay(10).setDelaySequence([100, 200]);
    await m.generate(req());
    await m.generate(req());
    await m.generate(req()); // sequence exhausted -> default 10
    expect(m.history.map((h) => h.delayMs)).toEqual([100, 200, 10]);
    expect(m.totalDelayMs).toBe(310);
  });

  it('rejects a negative delay', () => {
    const m = new FakeModel();
    expect(() => m.setDelay(-1)).toThrow(RangeError);
    expect(() => m.setDelaySequence([0, -5])).toThrow(RangeError);
  });
});

describe('FakeModel — P1-F1 rich history for UX', () => {
  it('records the response returned for each successful call', async () => {
    const m = new FakeModel();
    m.setSequence(['{"a":1}']);
    await m.generate(req());
    expect(m.history[0]?.response).toBe('{"a":1}');
    expect(m.history[0]?.errorCode).toBeUndefined();
  });

  it('records the error code on a failing call (and still logs the call)', async () => {
    const m = new FakeModel();
    m.setError(new ModelError('MODEL_CONTEXT_OVERFLOW', 'too big'));
    await expect(m.generate(req())).rejects.toMatchObject({ code: 'MODEL_CONTEXT_OVERFLOW' });
    expect(m.callCount).toBe(1);
    expect(m.history[0]?.errorCode).toBe('MODEL_CONTEXT_OVERFLOW');
    expect(m.history[0]?.response).toBeUndefined();
  });

  it('reset() clears delays and history', async () => {
    const m = new FakeModel();
    m.setDelay(50);
    await m.generate(req());
    m.reset();
    expect(m.totalDelayMs).toBe(0);
    expect(m.callCount).toBe(0);
  });
});
