// Phase 2 — P2-MG1: Ollama ModelGateway adapter.
export { OllamaModelGateway } from './ollama-gateway.js';
export type { OllamaConfig } from './ollama-gateway.js';
// Model management (list + pull) — separate from the gateway (admin, not generation).
export { OllamaModelAdmin, OllamaModelAdminError } from './ollama-admin.js';
export type { OllamaModelInfo, PullProgress, OllamaModelAdminConfig } from './ollama-admin.js';
// Runtime-switchable gateway: lets the user pick the active model without a restart (MG-001).
export { SwitchableModelGateway } from './switchable-gateway.js';
export type { SwitchableGatewayConfig } from './switchable-gateway.js';
