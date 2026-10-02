// tool-call-schema — P3-TE1. JSON schema for the model's tool-call proposal.
//
// The model may respond with either:
//   (a) A tool call proposal: { type: "tool_call", toolName, arguments, reasoning? }
//   (b) A completion signal:  { type: "done", summary }
//
// This schema is passed to parseModelOutput (MG-002/003 bounded retry + SE-010 validation).
// The model is NOT authority — the runtime interprets the proposal (MG-006).

import type { OutputSchema } from '../security/structured-output-validator.js';

// ── Schema ────────────────────────────────────────────────────────────────────

/**
 * Schema for model output during task execution (purpose = 'execute').
 *
 * Two accepted shapes:
 *   { "type": "tool_call", "toolName": "write_file", "arguments": { ... }, "reasoning": "..." }
 *   { "type": "done",      "summary": "Task complete: ..." }
 */
export const TOOL_CALL_PROPOSAL_SCHEMA: OutputSchema = {
  type: { type: 'string', required: true, enum: ['tool_call', 'done'] },
  // tool_call fields (required when type == 'tool_call', but schema is top-level so
  // toolName is optional at this layer; semantic check enforces the per-type rules).
  toolName:  { type: 'string' },
  arguments: { type: 'object' },
  reasoning: { type: 'string' },
  // done fields
  summary:   { type: 'string' },
};

// ── Parsed types ──────────────────────────────────────────────────────────────

export interface RawToolCallProposal {
  readonly type:      'tool_call';
  readonly toolName:  string;
  readonly arguments: Record<string, unknown>;
  readonly reasoning?: string;
}

export interface RawDoneSignal {
  readonly type:    'done';
  readonly summary: string;
}

export type RawExecuteOutput = RawToolCallProposal | RawDoneSignal;

// ── Semantic validation ───────────────────────────────────────────────────────

/**
 * Validate execute-purpose model output semantics (SE-003: runtime decides, not model).
 *
 * Rules:
 *   - If type == 'tool_call': toolName must be present and non-empty.
 *   - If type == 'done':      summary must be present and non-empty.
 */
export function validateExecuteSemantics(parsed: unknown): string | undefined {
  if (parsed === null || typeof parsed !== 'object') {
    return 'execute output must be a JSON object';
  }
  const obj = parsed as Record<string, unknown>;

  if (obj['type'] === 'tool_call') {
    if (typeof obj['toolName'] !== 'string' || obj['toolName'].trim() === '') {
      return 'tool_call proposal must include a non-empty "toolName"';
    }
    if (obj['arguments'] === undefined || obj['arguments'] === null) {
      return 'tool_call proposal must include "arguments" (may be an empty object)';
    }
    if (typeof obj['arguments'] !== 'object' || Array.isArray(obj['arguments'])) {
      return '"arguments" must be a plain object';
    }
    return undefined;
  }

  if (obj['type'] === 'done') {
    if (typeof obj['summary'] !== 'string' || obj['summary'].trim() === '') {
      return 'done signal must include a non-empty "summary"';
    }
    return undefined;
  }

  return `unknown execute output type: "${String(obj['type'])}"`;
}
