/*
 * Copyright 2026 DienVu (Dienvu1008)
 * SPDX-License-Identifier: Apache-2.0
 */

// Recording model gateway (kernel-shadow-ablation, design C2). Measurement-only (SA-001).
//
// A ModelGateway decorator that forwards every request UNCHANGED to the inner gateway, returns the
// inner response object UNCHANGED, and appends one Trace_Entry per settled call (Requirement 1).
// Raw responses and error messages are passed through the existing Redactor BEFORE they are stored
// in memory (Requirement 2.2); prompts are stored as SHA-256 digests only (Requirement 2.3).
//
// Ordering: `seq` is reserved when a call STARTS, so entries are ordered by call order even when
// calls settle out of order. A second call starting while an earlier one is in flight marks the
// trace `concurrent: true` (Requirement 1.5); such traces are refused by the replay harness.
// Non-ModelError throws are harness bugs, not model behavior: they are rethrown and not recorded.
// `trace()` renumbers the recorded entries 0..n-1 in reserved order so the snapshot always has
// contiguous sequence numbers (a format requirement, Requirement 2.5).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ModelError,
  type ModelGateway,
  type ModelIdentity,
  type ModelRequest,
  type ModelResponse,
} from '@codeforge/agent-core';
import { redact } from '@codeforge/infrastructure';
import {
  TRACE_FORMAT_VERSION,
  promptDigest,
  serializeTrace,
  type ModelTraceV1,
  type TraceEntry,
  type TraceOutcome,
  type TraceSource,
  type TraceWiring,
} from './trace-format.js';

export interface RecordingOptions {
  readonly source: TraceSource;
  readonly wiring: TraceWiring;
  readonly traceId: string;
}

export class RecordingModelGateway implements ModelGateway {
  private readonly recorded: TraceEntry[] = [];
  private nextSeq = 0;
  private inFlight = 0;
  private concurrent = false;

  constructor(
    private readonly inner: ModelGateway,
    private readonly opts: RecordingOptions,
  ) {}

  /** Same identity as the inner gateway (Requirement 1.4). */
  get identity(): ModelIdentity {
    return this.inner.identity;
  }

  async generate(request: ModelRequest): Promise<ModelResponse> {
    if (this.inFlight > 0) this.concurrent = true;
    this.inFlight += 1;
    const seq = this.nextSeq;
    this.nextSeq += 1;
    const promptSha256 = promptDigest(request.systemPrompt, request.taskPrompt);
    try {
      const response = await this.inner.generate(request);
      const raw = redact(response.raw);
      const outcome: TraceOutcome = {
        kind: 'response',
        raw,
        ...(response.promptTokens !== undefined ? { promptTokens: response.promptTokens } : {}),
        ...(response.outputTokens !== undefined ? { outputTokens: response.outputTokens } : {}),
      };
      this.store(seq, request, promptSha256, outcome, raw !== response.raw);
      return response;
    } catch (err) {
      if (err instanceof ModelError) {
        const message = redact(err.message);
        this.store(
          seq,
          request,
          promptSha256,
          { kind: 'error', code: err.code, message },
          message !== err.message,
        );
      }
      throw err;
    } finally {
      this.inFlight -= 1;
    }
  }

  /** Snapshot of what was recorded so far (settled calls only), seq renumbered 0..n-1. */
  trace(): ModelTraceV1 {
    const entries = [...this.recorded]
      .sort((a, b) => a.seq - b.seq)
      .map((e, index): TraceEntry => ({ ...e, seq: index }));
    return {
      formatVersion: TRACE_FORMAT_VERSION,
      traceId: this.opts.traceId,
      source: this.opts.source,
      wiring: this.opts.wiring,
      redaction: { applied: true, redactedEntries: entries.filter((e) => e.redacted).length },
      concurrent: this.concurrent,
      entries,
    };
  }

  private store(
    seq: number,
    request: ModelRequest,
    promptSha256: string,
    outcome: TraceOutcome,
    redacted: boolean,
  ): void {
    this.recorded.push({
      seq,
      purpose: request.purpose,
      ...(request.contextSnapshotId !== undefined ? { contextSnapshotId: request.contextSnapshotId } : {}),
      promptSha256,
      outcome,
      redacted,
    });
  }
}

/** File name for a trace id: every character outside [A-Za-z0-9._-] becomes '_'. */
export function traceFileName(traceId: string): string {
  const safe = traceId.replace(/[^A-Za-z0-9._-]/g, '_');
  return `${safe === '' ? '_' : safe}.trace.json`;
}

/**
 * Write `<dir>/<sanitized traceId>.trace.json` with `serializeTrace(trace)` (Requirement 1.6).
 * Creates `dir` recursively. Returns the written path.
 */
export function writeTraceFile(dir: string, trace: ModelTraceV1): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, traceFileName(trace.traceId));
  writeFileSync(path, serializeTrace(trace), 'utf8');
  return path;
}
