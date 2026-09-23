// StructuredOutputValidator — SECURITY_MODEL §4, P1.5-SE1.
//
// Enforces SE-010 (model output is untrusted input) and SE-003 (LLM cannot bypass
// deterministic policy). Every LLM response MUST pass this pipeline before it becomes
// a proposal that the runtime can act on:
//
//   Raw string → parse → required-field check → type check → semantic check → Validated<T>
//
// Design rules:
//   - NEVER "fix" or guess model output. If it fails → ModelOutputError, not a patch.
//   - NEVER use output to skip or override a validation step (SE-003).
//   - Pure + deterministic: same raw string → same result (no side effects, no I/O).
//   - No external runtime deps (no ajv, no zod) — keeps agent-core dependency-free (DC-002).
//
// Bounded retry: callers may retry up to MAX_RETRIES on MODEL_OUTPUT_INVALID.
// MG-003: do NOT retry silently on every failure class — TIMEOUT and UNAVAILABLE
// escalate, only INVALID is retryable.

import type { ModelPurpose } from '../model/gateway.js';

/** Max bounded retry count for MODEL_OUTPUT_INVALID (SECURITY_MODEL §4.4). */
export const MAX_OUTPUT_RETRIES = 2;

// ── Error types ───────────────────────────────────────────────────────────────

export type OutputValidationCode =
  | 'PARSE_FAILED'       // raw string is not valid JSON
  | 'SCHEMA_INVALID'     // required fields missing or wrong type
  | 'SEMANTIC_INVALID'   // business-rule violation (value out of range, forbidden field, etc.)
  | 'INJECTION_ATTEMPT'; // raw string contains prompt-injection markers (SE-010 defense)

export class ModelOutputError extends Error {
  public readonly code: OutputValidationCode;
  public readonly raw: string;
  public readonly retryable: boolean;

  constructor(code: OutputValidationCode, raw: string, message?: string) {
    super(message ?? code);
    this.name = 'ModelOutputError';
    this.code = code;
    this.raw = raw;
    // INJECTION_ATTEMPT is not retryable — the model is actively malicious.
    this.retryable = code !== 'INJECTION_ATTEMPT';
  }
}

// ── Schema descriptor ─────────────────────────────────────────────────────────

/** A simple field descriptor used to express the required schema of a model output. */
export interface FieldDescriptor {
  readonly type: 'string' | 'number' | 'boolean' | 'object' | 'array' | 'any';
  /** If true the field must be present and non-null (default: false = optional). */
  readonly required?: boolean;
  /** Allowed string values (enum check, optional). */
  readonly enum?: readonly string[];
  /** Min value for numbers (inclusive). */
  readonly min?: number;
  /** Max value for numbers (inclusive). */
  readonly max?: number;
}

/** Schema descriptor: keys map to field rules. */
export type OutputSchema = Readonly<Record<string, FieldDescriptor>>;

// ── Injection markers (SE-010 defense layer) ──────────────────────────────────

/**
 * Patterns that indicate a prompt-injection attempt embedded in model output.
 * These are heuristic, not exhaustive — the primary defense is the PromptBoundary
 * (context marking) and the policy gate, not this list. But known patterns are
 * caught here as an early signal (SE-002 defense-in-depth).
 */
const INJECTION_PATTERNS: readonly RegExp[] = [
  /ignore\s+(all\s+)?(previous|prior|above)\s+instructions?/i,
  /you\s+are\s+now\s+a?\s*(different|new)\s+(agent|assistant|model)/i,
  /system\s*:\s*you/i,
  /\[\s*system\s*\]/i,
  /<\s*system\s*>/i,
];

function hasInjectionMarker(raw: string): boolean {
  return INJECTION_PATTERNS.some((p) => p.test(raw));
}

// ── Core validator ────────────────────────────────────────────────────────────

export interface ValidateOptions {
  /**
   * JSON schema to validate the parsed object against.
   * If omitted, only parse + injection check are performed.
   */
  readonly schema?: OutputSchema;
  /**
   * Purpose of the model call — used in error messages and for purpose-specific
   * semantic checks (e.g. 'plan' output must not contain `state` fields, TI-003).
   */
  readonly purpose?: ModelPurpose;
  /**
   * Additional semantic check function. Receives the parsed object and returns
   * a rejection reason string, or undefined if the object passes.
   * This is the hook for purpose-specific policy (SE-003: runtime decides, not model).
   */
  readonly semanticCheck?: (parsed: unknown) => string | undefined;
}

export interface ValidateResult<T = unknown> {
  readonly ok: true;
  readonly value: T;
}
export interface ValidateFailure {
  readonly ok: false;
  readonly error: ModelOutputError;
}

export type ValidationOutcome<T = unknown> = ValidateResult<T> | ValidateFailure;

/**
 * Validate raw model output through the 3-stage pipeline (SECURITY_MODEL §4.2):
 *   Stage 1 — Parse (JSON.parse).
 *   Stage 2 — Schema validation (required fields, types, enums, ranges).
 *   Stage 3 — Semantic validation (caller-supplied hook, purpose-specific rules).
 *
 * SE-010: raw is treated as untrusted input throughout.
 * SE-003: even if the model output looks "correct", the semantic check (runtime code)
 *         has the final word — the model cannot supply a value that skips this gate.
 */
export function validateModelOutput<T = unknown>(
  raw: string,
  options: ValidateOptions = {},
): ValidationOutcome<T> {
  // ── Stage 0: injection check ────────────────────────────────────────────────
  if (hasInjectionMarker(raw)) {
    return {
      ok: false,
      error: new ModelOutputError(
        'INJECTION_ATTEMPT',
        raw,
        'model output contains a prompt-injection marker (SE-010)',
      ),
    };
  }

  // ── Stage 1: parse ──────────────────────────────────────────────────────────
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      ok: false,
      error: new ModelOutputError('PARSE_FAILED', raw, 'model output is not valid JSON'),
    };
  }

  // ── Stage 2: schema validation ──────────────────────────────────────────────
  if (options.schema !== undefined) {
    const schemaError = checkSchema(parsed, options.schema, raw);
    if (schemaError !== undefined) return { ok: false, error: schemaError };
  }

  // ── Stage 3: semantic validation ────────────────────────────────────────────
  if (options.semanticCheck !== undefined) {
    const reason = options.semanticCheck(parsed);
    if (reason !== undefined) {
      return {
        ok: false,
        error: new ModelOutputError('SEMANTIC_INVALID', raw, reason),
      };
    }
  }

  return { ok: true, value: parsed as T };
}

// ── Schema check implementation ───────────────────────────────────────────────

function checkSchema(
  parsed: unknown,
  schema: OutputSchema,
  raw: string,
): ModelOutputError | undefined {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return new ModelOutputError(
      'SCHEMA_INVALID',
      raw,
      'model output must be a JSON object at the top level',
    );
  }

  const obj = parsed as Record<string, unknown>;

  for (const [field, descriptor] of Object.entries(schema)) {
    const value = obj[field];
    const present = field in obj && value !== null && value !== undefined;

    if (descriptor.required === true && !present) {
      return new ModelOutputError(
        'SCHEMA_INVALID',
        raw,
        `required field "${field}" is missing or null`,
      );
    }

    if (!present) continue; // optional, absent → ok

    // Type check.
    const typeError = checkFieldType(field, value, descriptor, raw);
    if (typeError !== undefined) return typeError;

    // Enum check (strings only).
    if (descriptor.enum !== undefined && typeof value === 'string') {
      if (!(descriptor.enum as readonly string[]).includes(value)) {
        return new ModelOutputError(
          'SCHEMA_INVALID',
          raw,
          `field "${field}" value "${value}" is not in the allowed set: ${descriptor.enum.join(', ')}`,
        );
      }
    }

    // Range check (numbers only).
    if (typeof value === 'number') {
      if (descriptor.min !== undefined && value < descriptor.min) {
        return new ModelOutputError(
          'SCHEMA_INVALID',
          raw,
          `field "${field}" value ${value} is below minimum ${descriptor.min}`,
        );
      }
      if (descriptor.max !== undefined && value > descriptor.max) {
        return new ModelOutputError(
          'SCHEMA_INVALID',
          raw,
          `field "${field}" value ${value} exceeds maximum ${descriptor.max}`,
        );
      }
    }
  }

  return undefined;
}

function checkFieldType(
  field: string,
  value: unknown,
  descriptor: FieldDescriptor,
  raw: string,
): ModelOutputError | undefined {
  if (descriptor.type === 'any') return undefined;

  const actual = Array.isArray(value) ? 'array' : typeof value;
  if (actual !== descriptor.type) {
    return new ModelOutputError(
      'SCHEMA_INVALID',
      raw,
      `field "${field}" expected type ${descriptor.type}, got ${actual}`,
    );
  }
  return undefined;
}
