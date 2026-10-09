// Metrics computation — pure (agent-core). Derives Metric readings from the evidence a runner
// collects for a case: the check outcomes, the runtime trace (DomainEvents), the set of changed
// files, and timing. The metric SET is open (§15): add a producer here without touching the
// runner or the evaluator.
import type { Metric, BenchmarkTask } from '../domain/evaluation.js';
import type { DomainEvent } from '../domain/event.js';

/** Everything a runner gathers about a single case, handed to the metric producers. */
export interface CaseEvidence {
  readonly task: BenchmarkTask;
  /** Deterministic check outcomes (the authority behind the verdict). */
  readonly checks: readonly { readonly passed: boolean }[];
  /** Runtime trace for this case's session (as returned by EventLog.query). May be empty. */
  readonly events: readonly DomainEvent[];
  /** Paths the agent changed in the isolated workspace. */
  readonly filesChanged: readonly string[];
  readonly durationMs: number;
  /** Optional direct counters the runner can supply (fallbacks when not derivable from events). */
  readonly counters?: {
    readonly toolCalls?: number;
    readonly modelTokens?: number;
    readonly retries?: number;
    readonly iterations?: number;
  };
}

const num = (b: boolean): number => (b ? 1 : 0);

function countEvents(events: readonly DomainEvent[], type: string): number {
  return events.filter((e) => e.type === type).length;
}

/** Sum a numeric payload field across all events of a given type (0 when absent). */
function sumPayloadField(events: readonly DomainEvent[], type: string, field: string): number {
  let total = 0;
  for (const e of events) {
    if (e.type !== type) continue;
    const p = e.payload as Record<string, unknown> | undefined;
    const v = p?.[field];
    if (typeof v === 'number' && Number.isFinite(v)) total += v;
  }
  return total;
}

/**
 * Compute the canonical metric set for a case. Deterministic over the evidence. Boolean metrics
 * are encoded as 0/1. Counts prefer the runtime trace, falling back to runner counters.
 */
export function computeMetrics(ev: CaseEvidence): readonly Metric[] {
  const metrics: Metric[] = [];
  const allChecksPassed = ev.checks.length > 0 && ev.checks.every((c) => c.passed);

  // ── Correctness ──────────────────────────────────────────────────────────────
  metrics.push({ name: 'checks_total', group: 'correctness', value: ev.checks.length, unit: 'count' });
  metrics.push({ name: 'checks_passed', group: 'correctness', value: ev.checks.filter((c) => c.passed).length, unit: 'count' });
  metrics.push({ name: 'all_checks_passed', group: 'correctness', value: num(allChecksPassed) });

  // ── Efficiency ───────────────────────────────────────────────────────────────
  metrics.push({ name: 'runtime_ms', group: 'efficiency', value: ev.durationMs, unit: 'ms' });
  const toolCalls = countEvents(ev.events, 'TOOL_CALL_ENDED') || (ev.counters?.toolCalls ?? 0);
  metrics.push({ name: 'tool_calls', group: 'efficiency', value: toolCalls, unit: 'count' });
  const runs = countEvents(ev.events, 'TASK_RUN_ENDED') || (ev.counters?.iterations ?? 0);
  metrics.push({ name: 'task_runs', group: 'efficiency', value: runs, unit: 'count' });
  if (ev.counters?.modelTokens !== undefined) {
    metrics.push({ name: 'model_tokens', group: 'efficiency', value: ev.counters.modelTokens, unit: 'tokens' });
  }

  // ── Context (the "context cost" signal — read before/after a context-strategy change) ──
  // Sourced from CONTEXT_SNAPSHOT_BUILT events the TaskExecutor emits after each snapshot build.
  // A task may build several snapshots (one per task_run), so tokens/items are summed and the
  // snapshot count is reported, letting a reader compute per-snapshot averages if desired.
  const ctxSnapshots = countEvents(ev.events, 'CONTEXT_SNAPSHOT_BUILT');
  metrics.push({ name: 'context_snapshots', group: 'context', value: ctxSnapshots, unit: 'count' });
  metrics.push({ name: 'context_tokens_used', group: 'context', value: sumPayloadField(ev.events, 'CONTEXT_SNAPSHOT_BUILT', 'tokenUsed'), unit: 'tokens' });
  metrics.push({ name: 'context_items', group: 'context', value: sumPayloadField(ev.events, 'CONTEXT_SNAPSHOT_BUILT', 'itemCount'), unit: 'count' });
  metrics.push({ name: 'context_codebase_items', group: 'context', value: sumPayloadField(ev.events, 'CONTEXT_SNAPSHOT_BUILT', 'codebaseItemCount'), unit: 'count' });

  // ── Scope ────────────────────────────────────────────────────────────────────
  metrics.push({ name: 'files_changed', group: 'scope', value: ev.filesChanged.length, unit: 'count' });
  const maxFiles = ev.task.expected?.maxFilesChanged;
  if (maxFiles !== undefined) {
    metrics.push({ name: 'scope_violation', group: 'scope', value: num(ev.filesChanged.length > maxFiles) });
  }

  // ── Recovery ─────────────────────────────────────────────────────────────────
  const failures = countEvents(ev.events, 'FAILURE_DETECTED');
  const recoveries = countEvents(ev.events, 'RECOVERY_ACTION_CHOSEN');
  metrics.push({ name: 'failures_detected', group: 'recovery', value: failures, unit: 'count' });
  metrics.push({ name: 'recovery_actions', group: 'recovery', value: recoveries, unit: 'count' });

  // ── Governance (any denied/unauthorized tool call is a red flag) ───────────────
  const denied = countEvents(ev.events, 'TOOL_CALL_DENIED');
  metrics.push({ name: 'policy_denied_tool_calls', group: 'governance', value: denied, unit: 'count' });

  // ── Routing (observability of the mission model decision, when present) ────────
  const modelSelected = countEvents(ev.events, 'MISSION_MODEL_SELECTED');
  metrics.push({ name: 'mission_model_selected', group: 'routing', value: modelSelected, unit: 'count' });

  // ── Planning (architecture gate activity, when present) ────────────────────────
  const gateBlocked = countEvents(ev.events, 'MISSION_ARCHITECTURE_GATE_BLOCKED');
  metrics.push({ name: 'architecture_gate_blocked', group: 'planning', value: gateBlocked, unit: 'count' });

  return metrics;
}

/** Look up a metric value by name (0 when absent). */
export function metricValue(metrics: readonly Metric[], name: string): number {
  return metrics.find((m) => m.name === name)?.value ?? 0;
}
