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
export type { SwitchableGatewayConfig } from './switchable-gateway.js';
// Shared provider spec + adapter factory (used by both switchable + routing gateways).
export { buildAdapter, DEFAULT_OLLAMA_ENDPOINT } from './provider-adapter.js';
export type { ProviderSpec, ModelProvider } from './provider-adapter.js';
// Per-purpose routing gateway: route each call to a model chosen by its ModelPurpose (MG-001).
export { RoutingModelGateway } from './routing-gateway.js';
export type { RoutingGatewayConfig } from './routing-gateway.js';
// Load per-purpose routing from a JSON file (API keys via env refs, never in the file).
export { loadModelRoutes, parseModelRoutes, ModelRoutesConfigError } from './model-routes-config.js';
// P12.9: apply a mission-recommended model id by switching the switchable gateway (id→ProviderSpec).
export { SwitchableRuntimeModelSelector } from './model-selector.js';
export type { SwitchableRuntimeModelSelectorConfig } from './model-selector.js';
