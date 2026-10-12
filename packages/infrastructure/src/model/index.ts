// Phase 2 — P2-MG1: Ollama ModelGateway adapter.
export { OllamaModelGateway } from './ollama-gateway.js';
export type { OllamaConfig } from './ollama-gateway.js';
// Multi-provider: an OpenAI Chat Completions-compatible adapter (OpenAI, OpenRouter, Groq,
// Together, DeepSeek, Mistral, LM Studio, llama.cpp, vLLM, LiteLLM, …).
export { OpenAiCompatibleModelGateway } from './openai-compatible-gateway.js';
export type { OpenAiCompatibleConfig } from './openai-compatible-gateway.js';
// Model management (list + pull) — separate from the gateway (admin, not generation).
export { OllamaModelAdmin, OllamaModelAdminError } from './ollama-admin.js';
export type { OllamaModelInfo, PullProgress, OllamaModelAdminConfig } from './ollama-admin.js';
// Runtime-switchable gateway: lets the user pick the active model without a restart (MG-001).
export { SwitchableModelGateway } from './switchable-gateway.js';
export type { SwitchableGatewayConfig, ProviderSpec, ModelProvider } from './switchable-gateway.js';
