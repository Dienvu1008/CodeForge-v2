// extractJson — tolerate the wrappers real models put around JSON (reasoning <think> blocks,
// markdown fences, a leading sentence) so the Planner/structured-output pipeline parses output
// from reasoning models (deepseek-r1) and chat models, not only models that emit bare JSON.
// It must NEVER repair malformed JSON — only strip KNOWN wrappers; JSON.parse remains the judge.
import { describe, it, expect } from 'vitest';
import { extractJson, validateModelOutput } from '@codeforge/agent-core';

describe('extractJson', () => {
  it('returns pure JSON unchanged', () => {
    expect(extractJson('{"ok":true}')).toBe('{"ok":true}');
    expect(extractJson('  {"a":1}  ')).toBe('{"a":1}');
  });

  it('strips <think>…</think> reasoning (deepseek-r1 style)', () => {
    const raw = '<think>\nLet me plan this. The user wants two tasks.\n</think>\n{"tasks":[]}';
    expect(JSON.parse(extractJson(raw))).toEqual({ tasks: [] });
  });

  it('unwraps a ```json fenced block', () => {
    const raw = 'Here is the plan:\n```json\n{"tasks":[{"id":"T1"}]}\n```\n';
    expect(JSON.parse(extractJson(raw))).toEqual({ tasks: [{ id: 'T1' }] });
  });

  it('unwraps a bare ``` fence', () => {
    expect(JSON.parse(extractJson('```\n{"x":1}\n```'))).toEqual({ x: 1 });
  });

  it('slices a JSON object embedded in prose', () => {
    const raw = 'Sure! {"tasks":[],"reason":"ok"} Hope that helps.';
    expect(JSON.parse(extractJson(raw))).toEqual({ tasks: [], reason: 'ok' });
  });

  it('handles braces inside strings when slicing', () => {
    const raw = 'result: {"msg":"use { and } carefully","n":2} done';
    expect(JSON.parse(extractJson(raw))).toEqual({ msg: 'use { and } carefully', n: 2 });
  });

  it('slices a top-level array', () => {
    expect(JSON.parse(extractJson('output: [1,2,3]'))).toEqual([1, 2, 3]);
  });

  it('combines think + fence', () => {
    const raw = '<think>reasoning</think>\n```json\n{"done":true}\n```';
    expect(JSON.parse(extractJson(raw))).toEqual({ done: true });
  });

  it('does NOT repair malformed JSON (still fails to parse)', () => {
    expect(() => JSON.parse(extractJson('{"a": }'))).toThrow();
  });
});

describe('validateModelOutput tolerates wrapped output end-to-end', () => {
  it('parses a planner-style object wrapped in think + fence', () => {
    const raw = '<think>decompose into one task</think>\n```json\n{"tasks":[{"id":"T1","description":"do it","strategy":"generate"}],"edges":[],"reason":"r"}\n```';
    const result = validateModelOutput(raw, { schema: { tasks: { type: 'array', required: true } } });
    expect(result.ok).toBe(true);
  });
});
