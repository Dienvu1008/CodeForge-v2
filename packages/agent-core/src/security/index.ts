// Security boundary — P1.5-SE1.
// Enforces SE-001/002 (prompt injection), SE-003/010 (model output untrusted),
// SE-004 (env allowlist). SE-005/PR-004 secret redaction lives in infrastructure/redaction.
export {
  validateModelOutput,
  ModelOutputError,
  MAX_OUTPUT_RETRIES,
  type OutputSchema,
  type FieldDescriptor,
  type OutputValidationCode,
  type ValidateOptions,
  type ValidateResult,
  type ValidateFailure,
  type ValidationOutcome,
} from './structured-output-validator.js';

export {
  markContent,
  wrapUntrusted,
  buildPrompt,
  scanForInjection,
  isSuspiciousContent,
  UNTRUSTED_OPEN,
  UNTRUSTED_CLOSE,
  BOUNDARY_SYSTEM_PREAMBLE,
  INJECTION_PATTERNS,
  type PromptSection,
  type InjectionScanResult,
} from './prompt-boundary.js';

export {
  filterEnv,
  safeEnv,
  EnvGuard,
  DEFAULT_ENV_POLICY,
  MINIMAL_ENV_POLICY,
  type EnvPolicy,
  type FilterResult,
} from './env-guard.js';
