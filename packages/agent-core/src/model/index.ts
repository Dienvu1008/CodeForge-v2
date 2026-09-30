// Model gateway contract — boundary for all LLM calls (MG-001).
export * from './gateway.js';
// Phase 2 — P2-MG2: StructuredOutputParser (MG-002/003/006).
export {
  parseModelOutput,
  parseRawOutput,
  modelRequest,
  MAX_OUTPUT_RETRIES as MODEL_MAX_RETRIES,
  type ParseOptions,
  type OutputSchema as ModelOutputSchema,
} from './structured-output-parser.js';
