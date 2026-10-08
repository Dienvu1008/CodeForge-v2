// Evaluation core (pure agent-core logic) — loader validation, metrics, deterministic evaluator,
// failure classification, aggregation, regression detection, report rendering. No I/O.
import { describe, it, expect } from 'vitest';
import {
  validateBenchmarkTask,
  validateBenchmark,
  computeMetrics,
  metricValue,
  evaluateCase,
  aggregate,
  compareToBaseline,
  renderReport,
  type BenchmarkTask,
  type DomainEvent,
  type RunProvenance,
  type EvaluationResult,
  type CheckOutcome,
} from '@codeforge/agent-core';

const PROV: RunProvenance = {
  agentName: 'codeforge', agentVersion: '0.12.0', gitCommit: 'abc1234', model: 'fake-model',
  runtimeConfig: {}, environment: 'test',
};

function task(over: Partial<BenchmarkTask> = {}): BenchmarkTask {
  return {
    id: 'CF-T', version: 1, category: 'BUGFIX', title: 't', description: 'd',
    seedFiles: {}, verification: [{ kind: 'command', target: 'node x', description: 'runs' }],
    difficulty: 'EASY', risk: 'LOW', timeoutMs: 1000, ...over,
  };
}

function evt(type: string): DomainEvent {
  return { eventId: 'e', sessionId: 'S', type, aggregate: { kind: 'session', id: 'S' }, payload: {}, at: 't', sequenceNumber: 0 };
}

describe('benchmark loader validation', () => {
  it('accepts a well-formed task', () => {
    const r = validateBenchmarkTask(task());
    expect(r.ok).toBe(true);
  });

  it('rejects a task with an empty verification array', () => {
    const r = validateBenchmarkTask(task({ verification: [] }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.path.endsWith('verification'))).toBe(true);
  });

  it('rejects an invalid category / difficulty / risk', () => {
    const r = validateBenchmarkTask({ ...task(), category: 'NONSENSE' });
    expect(r.ok).toBe(false);
  });

  it('rejects a benchmark with duplicate task ids', () => {
    const r = validateBenchmark({
      id: 'b', version: '1', description: 'd',
      tasks: [task({ id: 'DUP' }), task({ id: 'DUP' })],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.message.includes('duplicate'))).toBe(true);
  });

  it('validates the full benchmark shape', () => {
    const r = validateBenchmark({ id: 'b', version: '1', description: 'd', tasks: [task()] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.tasks).toHaveLength(1);
  });
});

describe('metrics', () => {
  it('derives tool_calls from the trace and files_changed from the diff', () => {
    const metrics = computeMetrics({
      task: task(), checks: [{ passed: true }],
      events: [evt('TOOL_CALL_ENDED'), evt('TOOL_CALL_ENDED'), evt('TASK_RUN_ENDED')],
      filesChanged: ['a.ts', 'b.ts'], durationMs: 42,
    });
    expect(metricValue(metrics, 'tool_calls')).toBe(2);
    expect(metricValue(metrics, 'files_changed')).toBe(2);
    expect(metricValue(metrics, 'runtime_ms')).toBe(42);
    expect(metricValue(metrics, 'all_checks_passed')).toBe(1);
  });

  it('flags a scope violation when files_changed exceeds expected.maxFilesChanged', () => {
    const metrics = computeMetrics({
      task: task({ expected: { maxFilesChanged: 1 } }), checks: [{ passed: true }],
      events: [], filesChanged: ['a', 'b', 'c'], durationMs: 1,
    });
    expect(metricValue(metrics, 'scope_violation')).toBe(1);
  });
});

describe('deterministic evaluator (agent is not the authority)', () => {
  const base = { task: task(), events: [] as DomainEvent[], filesChanged: [] as string[], startedAt: 't0', endedAt: 't1', durationMs: 5 };

  it('SUCCESS only when all checks pass', () => {
    const r = evaluateCase({ ...base, checks: [{ description: 'c', passed: true }] });
    expect(r.verdict).toBe('SUCCESS');
  });

  it('FAILURE when any check fails — regardless of what the agent "said"', () => {
    const r = evaluateCase({ ...base, checks: [{ description: 'c', passed: false }] });
    expect(r.verdict).toBe('FAILURE');
    expect(r.failureClass).toBeDefined();
  });

  it('INVALID (not FAILURE) when the run could not be judged', () => {
    const r = evaluateCase({ ...base, checks: [], invalidReason: 'workspace setup failed' });
    expect(r.verdict).toBe('INVALID');
    expect(r.failureClass).toBe('ENVIRONMENT_FAILURE');
  });

  it('TIMEOUT failure class when the case timed out', () => {
    const r = evaluateCase({ ...base, checks: [{ description: 'c', passed: false }], timedOut: true });
    expect(r.verdict).toBe('FAILURE');
    expect(r.failureClass).toBe('TIMEOUT');
  });

  it('attributes GOVERNANCE_VIOLATION when a tool call was denied during a failed case', () => {
    const r = evaluateCase({ ...base, checks: [{ description: 'c', passed: false }], events: [evt('TOOL_CALL_DENIED')] });
    expect(r.failureClass).toBe('GOVERNANCE_VIOLATION');
  });

  it('attributes PLANNING_FAILURE when no graph mutation was ever committed', () => {
    const r = evaluateCase({ ...base, checks: [{ description: 'c', passed: false }], events: [evt('TASK_RUN_ENDED')] });
    expect(r.failureClass).toBe('PLANNING_FAILURE');
  });

  it('is deterministic (same input → identical result)', () => {
    const input = { ...base, checks: [{ description: 'c', passed: true }] as CheckOutcome[] };
    expect(JSON.stringify(evaluateCase(input))).toEqual(JSON.stringify(evaluateCase(input)));
  });
});

describe('aggregation + regression', () => {
  function result(success: number, failure: number, avgToolCalls: number): EvaluationResult {
    const results = [
      ...Array.from({ length: success }, () => evaluateCase({ task: task(), checks: [{ description: 'c', passed: true }], events: [], filesChanged: [], startedAt: 't', endedAt: 't', durationMs: 1 })),
      ...Array.from({ length: failure }, () => evaluateCase({ task: task(), checks: [{ description: 'c', passed: false }], events: [], filesChanged: [], startedAt: 't', endedAt: 't', durationMs: 1 })),
    ];
    const agg = aggregate('run', 'b', '1', PROV, results, 't');
    // Override the tool_calls average deterministically for the regression test.
    return { ...agg, metricAverages: { ...agg.metricAverages, tool_calls: avgToolCalls } };
  }

  it('counts success/failure and computes success rate over judged cases', () => {
    const agg = result(6, 4, 5);
    expect(agg.total).toBe(10);
    expect(agg.success).toBe(6);
    expect(agg.successRate).toBeCloseTo(0.6, 5);
  });

  it('detects a success-rate regression', () => {
    const baseline = result(7, 3, 5);
    const current = result(5, 5, 5);
    const reg = compareToBaseline(current, baseline, 'base', 'cur');
    expect(reg.verdict).toBe('REGRESSION');
    expect(reg.successRateDelta).toBeLessThan(0);
  });

  it('detects an improvement', () => {
    const reg = compareToBaseline(result(8, 2, 5), result(6, 4, 5), 'base', 'cur');
    expect(reg.verdict).toBe('IMPROVEMENT');
  });

  it('flags a cost regression even when success is unchanged', () => {
    const baseline = result(6, 4, 4);
    const current = result(6, 4, 10); // +150% tool calls, same success
    const reg = compareToBaseline(current, baseline, 'base', 'cur');
    expect(reg.verdict).toBe('REGRESSION');
    expect(reg.notes.some((n) => n.includes('tool_calls'))).toBe(true);
  });

  it('renders a human-readable report', () => {
    const text = renderReport(result(6, 4, 5));
    expect(text).toContain('CodeForge Evaluation Report');
    expect(text).toContain('Success Rate');
    expect(text).toContain('Failure breakdown');
  });
});
