// StructuredOutputParser — P2-MG2. SECURITY_MODEL §4, Coding Agent Architecture §20.
//
// Wraps validateModelOutput with a bounded retry loop (MG-003) and maps
// validation failures to the canonical ModelError codes.
//
// Enforces:
//   MG-002: structured output must pass schema + semantic validation.
//   MG-003: invalid output retried bounded (MAX_OUTPUT_RETRIES = 2), then escalate.
//   MG-006: model output is NOT authority — caller decides what to do with the value.
//   SE-010 (structural): raw is always treated as untrusted input throughout.
//
// Design: pure orchestration — no I/O, no LLM calls. The gateway is injected so
// tests can use FakeModel and still exercise the full retry logic.

import type { ModelGateway, ModelRequest, ModelPurpose } from './gateway.js';
import { ModelError } from './gateway.js';
import {
  validateModelOutput,
  ModelOutputError,
  MAX_OUTPUT_RETRIES,
} from '../security/structured-output-validator.js';
import type { OutputSchema, ValidateOptions } from '../security/structured-output-validator.js';

export type { OutputSchema };

// ── ParseOptions ──────────────────────────────────────────────────────────────

export interface ParseOptions<T = unknown> extends ValidateOptions {
  /**
   * When provided, the parser retries the model call with this feedback appended
   * to the task prompt (bounded to MAX_OUTPUT_RETRIES).
   */
  readonly retryFeedback?: (errorMessage: string, attempt: number) => string;
}

// ── StructuredOutputParser ────────────────────────────────────────────────────

/**
 * Ask the model for a structured response, validate it, and retry up to
 * MAX_OUTPUT_RETRIES times on retryable failures (MG-003).
 *
 * Returns a typed parsed value on success.
 * Throws ModelError on exhausted retries or non-retryable failure.
 */
export async function parseModelOutput<T = unknown>(
  gateway: ModelGateway,
  request: ModelRequest,
  options: ParseOptions<T> = {},
): Promise<T> {
  let lastError: ModelOutputError | undefined;

  for (let attempt = 0; attempt <= MAX_OUTPUT_RETRIES; attempt++) {
    // On retry: append feedback to the task prompt so the model knows what went wrong.
    const req: ModelRequest =
      attempt > 0 && options.retryFeedback !== undefined && lastError !== undefined
        ? {
            ...request,
            taskPrompt: `${request.taskPrompt}\n\n${options.retryFeedback(lastError.message, attempt)}`,
          }
        : request;

    // Call the model gateway (MG-001: already enforced by the caller injecting a gateway).
    let raw: string;
    try {
      const response = await gateway.generate(req);
      raw = response.raw; // SE-010: untrusted
    } catch (err) {
      // MODEL_TIMEOUT / MODEL_UNAVAILABLE are not retryable — escalate immediately.
      if (err instanceof ModelError) throw err;
      throw new ModelError('MODEL_UNAVAILABLE', String(err));
    }

    // Validate raw output (MG-002): parse → schema → semantic.
    const result = validateModelOutput<T>(raw, options);
    if (result.ok) {
      return result.value; // MG-006: caller decides authority, not the value itself
    }

    lastError = result.error;

    // INJECTION_ATTEMPT is non-retryable — model is actively malicious.
    if (!lastError.retryable) {
      throw new ModelError(
        'MODEL_OUTPUT_INVALID',
        `non-retryable validation failure (${lastError.code}): ${lastError.message}`,
      );
    }
  }

  // Retries exhausted (MG-003: bounded, not infinite).
  throw new ModelError(
    'MODEL_OUTPUT_INVALID',
    `model output still invalid after ${MAX_OUTPUT_RETRIES} retries: ${lastError?.message ?? 'unknown'}`,
  );
}

// ── Convenience: one-shot validation (no model call) ─────────────────────────

/**
 * Validate already-obtained raw output without calling the model again.
 * Useful when the gateway has already been called and you just need the typed value.
 */
export function parseRawOutput<T = unknown>(
  raw: string,
  options: ParseOptions<T> = {},
): T {
  const result = validateModelOutput<T>(raw, options);
  if (result.ok) return result.value;
  const err = result.error;
  throw new ModelError(
    'MODEL_OUTPUT_INVALID',
    `${err.code}: ${err.message}`,
  );
}

// ── Re-exports for convenience ────────────────────────────────────────────────

export { MAX_OUTPUT_RETRIES } from '../security/structured-output-validator.js';

// Purpose helper: build a base ModelRequest for a given purpose.
export function modelRequest(
  purpose: ModelPurpose,
  systemPrompt: string,
  taskPrompt: string,
  opts: { maxOutputTokens?: number; temperature?: number; responseSchema?: unknown } = {},
): ModelRequest {
  return {
    purpose,
    systemPrompt,
    taskPrompt,
    maxOutputTokens: opts.maxOutputTokens ?? 2048,
    temperature:     opts.temperature ?? 0,
    ...(opts.responseSchema !== undefined ? { responseSchema: opts.responseSchema } : {}),
  };
}
