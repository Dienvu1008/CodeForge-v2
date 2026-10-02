// IdempotencyEngine — P4-IK1. TG-006: ToolCall idempotency key computation + deduplication.
//
// Enforces TG-006: every ToolCall for a MODIFY_WORKSPACE / DESTRUCTIVE / SYSTEM tool
// must carry an idempotency key. For 'content-hash' tools the key is derived from
// (toolName, arguments) so duplicate calls with identical arguments are detected
// and skipped — preventing e.g. double-write_file on the same path with the same
// content if the model loops.
//
// Design:
//   - Pure domain logic (no I/O, no FS, no SQLite) → lives in agent-core.
//   - State: one `IdempotencyEngine` instance is created per TaskRun and holds the
//     set of seen keys. It is NOT persisted — deduplication is intra-run only.
//   - Cross-run deduplication (e.g. retry after crash) requires a persistent store
//     and is deferred to Phase 5 (RecoveryEngine).
//   - Strategy lookup: caller passes the ToolRegistry to resolve idempotencyStrategy.
//     If the tool is not in the registry, defaults to 'none' (no deduplication).
import { createHash } from 'node:crypto';
import type { ToolDefinition } from '../tool/tool-registry.js';

// ── IdempotencyResult ─────────────────────────────────────────────────────────

export interface IdempotencyResult {
  /**
   * The computed idempotency key, or undefined when strategy is 'none'.
   * Set on ToolCall.idempotencyKey before persisting (TG-006).
   */
  readonly idempotencyKey: string | undefined;
  /**
   * True when this (toolName, args) combination was already executed
   * in the current run with the same idempotency key.
   * TaskExecutor should skip ToolGateway.execute() and return a cached result.
   */
  readonly isDuplicate: boolean;
}

// ── IdempotencyEngine ─────────────────────────────────────────────────────────

/**
 * Intra-run idempotency tracking for tool calls.
 *
 * Create one instance per TaskRun:
 *   const idempotency = new IdempotencyEngine();
 *
 * Before calling ToolGateway.request():
 *   const { idempotencyKey, isDuplicate } = idempotency.check(def, args);
 *   if (isDuplicate) { // skip; return cached success }
 *   // attach idempotencyKey to ToolCall
 *
 * After successful ToolGateway.execute():
 *   idempotency.markExecuted(idempotencyKey);
 */
export class IdempotencyEngine {
  /** Keys of tool calls that completed successfully in this run. */
  private readonly executed = new Set<string>();

  /**
   * Compute the idempotency key for (toolDefinition, arguments) and check
   * whether it was already executed in this run.
   *
   * @param def   ToolDefinition from the registry (carries idempotencyStrategy).
   * @param args  The raw arguments object from the model proposal.
   * @returns     { idempotencyKey, isDuplicate }
   */
  check(def: ToolDefinition, args: Record<string, unknown>): IdempotencyResult {
    if (def.idempotencyStrategy === 'none') {
      return { idempotencyKey: undefined, isDuplicate: false };
    }

    if (def.idempotencyStrategy === 'content-hash') {
      const key = this.computeContentHash(def.toolName, args);
      return { idempotencyKey: key, isDuplicate: this.executed.has(key) };
    }

    // 'custom' — caller must supply the key; engine just checks whether it was seen.
    // We compute a hash the same way so callers CAN use this for custom tools too.
    const key = this.computeContentHash(def.toolName, args);
    return { idempotencyKey: key, isDuplicate: this.executed.has(key) };
  }

  /**
   * Mark an idempotency key as successfully executed.
   * Call this after ToolGateway.execute() returns a SUCCEEDED ToolCall.
   * No-op for undefined keys (strategy='none').
   */
  markExecuted(idempotencyKey: string | undefined): void {
    if (idempotencyKey !== undefined) {
      this.executed.add(idempotencyKey);
    }
  }

  /**
   * Reset all seen keys (e.g. for a retry run on the same instance).
   * Typically you'd create a new instance per run, but reset() is useful in tests.
   */
  reset(): void {
    this.executed.clear();
  }

  /** Number of unique keys tracked so far. */
  get size(): number {
    return this.executed.size;
  }

  // ── private ──────────────────────────────────────────────────────────────────

  /**
   * SHA-256 of `toolName + ":" + canonical JSON args`.
   * Canonical = keys sorted alphabetically, no whitespace (deterministic).
   */
  private computeContentHash(toolName: string, args: Record<string, unknown>): string {
    const canonical = `${toolName}:${JSON.stringify(sortKeys(args))}`;
    return createHash('sha256').update(canonical, 'utf8').digest('hex');
  }
}

// ── sortKeys ──────────────────────────────────────────────────────────────────

/**
 * Recursively sort object keys for canonical JSON serialisation.
 * Arrays preserve order (order matters for arrays like `paths: [...]`).
 */
function sortKeys(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(sortKeys);
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    sorted[key] = sortKeys((value as Record<string, unknown>)[key]);
  }
  return sorted;
}
