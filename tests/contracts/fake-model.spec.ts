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
