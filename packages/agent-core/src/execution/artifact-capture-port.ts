// ArtifactCapturePort — P4-AP1. Domain contract for artifact recording.
//
// agent-core owns the CONTRACT; infrastructure owns the implementation.
// This keeps agent-core free of filesystem/SQLite imports (DC-002).
//
// Usage by TaskExecutor:
//   After ToolGateway.execute() completes, TaskExecutor calls:
//     const ids = await port.record(toolCallId, sessionId, executorResult);
//     // ids.stdoutArtifactId and ids.stderrArtifactId are available for ToolResult
//
// The concrete implementation (using ArtifactStore) lives in infrastructure.
import type { ExecutorResult } from '../tool/tool-gateway.js';

// ── ArtifactIds ───────────────────────────────────────────────────────────────

export interface ArtifactIds {
  /** ArtifactStore ID for the stdout content. Undefined if stdout was empty. */
  readonly stdoutArtifactId?: string | undefined;
  /** ArtifactStore ID for the stderr content. Undefined if stderr was empty. */
  readonly stderrArtifactId?: string | undefined;
}

// ── ArtifactCapturePort ───────────────────────────────────────────────────────

/**
 * Domain contract for persisting tool call output as artifacts (PR-001, PR-003).
 *
 * Called by TaskExecutor after each successful ToolGateway.execute() to persist
 * stdout/stderr and return artifact IDs for ToolResult wiring.
 *
 * Implementations must be append-only (PR-003): no existing artifact may be
 * modified or deleted.
 *
 * Empty strings: implementations SHOULD skip writing empty stdout/stderr
 * (no artifact ID returned for empty content).
 */
export interface ArtifactCapturePort {
  /**
   * Persist stdout and stderr from a completed tool call.
   * Returns artifact IDs for non-empty content, undefined for empty.
   */
  record(
    toolCallId: string,
    sessionId:  string,
    result:     ExecutorResult,
  ): Promise<ArtifactIds>;
}
