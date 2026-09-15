// ModelGateway contract — Coding Agent Architecture Target §19-20, CONTEXT_SPEC §14,
// SECURITY_MODEL §4, §10. All LLM calls go through this (MG-001). Output is UNTRUSTED
// (SE-010) and must pass structured validation before becoming a proposal (MG-002).
//
// This is a CONTRACT (interface) only. Concrete adapters (Ollama) and test doubles
// (FakeModel) implement it elsewhere. Kept in agent-core so the domain owns the boundary,
// while the LLM itself stays an adapter (DC-002).

export type ModelPurpose =
  | 'plan'
  | 'critique'
  | 'replan'
  | 'execute'
  | 'analyze_failure'
  | 'summarize';

// Failure classes for model calls (§20, SECURITY_MODEL §4.3).
export type ModelErrorCode =
  | 'MODEL_OUTPUT_INVALID'
  | 'MODEL_TIMEOUT'
  | 'MODEL_UNAVAILABLE'
  | 'MODEL_CONTEXT_OVERFLOW'
  | 'MODEL_TOOL_CALL_INVALID';

export class ModelError extends Error {
  public readonly code: ModelErrorCode;
  constructor(code: ModelErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'ModelError';
    this.code = code;
  }
}

export interface ModelIdentity {
  readonly name: string;
  readonly version: string;
  readonly endpoint: string;
}

export interface ModelRequest {
  readonly purpose: ModelPurpose;
  /** id of the ContextSnapshot this call is grounded in (provenance chain) */
  readonly contextSnapshotId?: string;
  readonly systemPrompt: string;
  readonly taskPrompt: string;
  /** JSON Schema the raw output must satisfy (structured output) */
  readonly responseSchema?: unknown;
  readonly maxOutputTokens: number;
  readonly temperature: number;
}

export interface ModelResponse {
  /** raw text as returned by the model — UNTRUSTED until validated (SE-010) */
  readonly raw: string;
  readonly model: ModelIdentity;
  /** token accounting for budget (best-effort) */
  readonly promptTokens?: number;
  readonly outputTokens?: number;
}

/**
 * The single boundary through which the runtime talks to any LLM.
 * `generate` returns a raw response or throws a ModelError. It never decides anything —
 * validation, policy, and state transitions happen in the deterministic runtime.
 */
export interface ModelGateway {
  readonly identity: ModelIdentity;
  generate(request: ModelRequest): Promise<ModelResponse>;
}
