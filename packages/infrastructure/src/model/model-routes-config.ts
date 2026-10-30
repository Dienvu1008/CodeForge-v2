/*
 * Copyright 2026 DienVu (Dienvu1008)
 * SPDX-License-Identifier: Apache-2.0
 */

// model-routes-config — load + validate a per-purpose model-routing config from a JSON file, and
// resolve it into a RoutingGatewayConfig the RoutingModelGateway consumes.
//
// Secret handling (deliberate): the file NEVER contains an API key. Each cloud entry names an
// environment variable via `apiKeyEnv`; the key is read from process.env at load time. This keeps
// secrets out of the repo/config file and out of any error message or log.
//
// Shape of the file (all specs validated; unknown purposes rejected):
//   {
//     "default": { "provider": "ollama", "model": "qwen2.5-coder", "endpoint": "http://localhost:11434" },
//     "routes": {
//       "plan":      { "provider": "openai-compatible", "model": "gpt-4o-mini",
//                      "endpoint": "https://api.openai.com/v1", "apiKeyEnv": "OPENAI_API_KEY" },
//       "architect": { "provider": "openai-compatible", "model": "gpt-4o",
//                      "endpoint": "https://api.openai.com/v1", "apiKeyEnv": "OPENAI_API_KEY" }
//     }
//   }
import { readFileSync } from 'node:fs';
import type { ModelPurpose } from '@codeforge/agent-core';
import type { ProviderSpec, ModelProvider } from './provider-adapter.js';
import type { RoutingGatewayConfig } from './routing-gateway.js';

export class ModelRoutesConfigError extends Error {
  constructor(message: string) { super(message); this.name = 'ModelRoutesConfigError'; }
}

// The valid ModelPurpose values (kept in sync with agent-core's ModelPurpose union). A route
// keyed by anything else is rejected so a typo cannot silently never-match.
const VALID_PURPOSES: ReadonlySet<string> = new Set<ModelPurpose>([
  'plan', 'critique', 'replan', 'execute', 'analyze_failure', 'summarize', 'architect',
]);

const VALID_PROVIDERS: ReadonlySet<string> = new Set<ModelProvider>(['ollama', 'openai-compatible']);

/** One entry as written in the file — like a ProviderSpec but with `apiKeyEnv` instead of a raw key. */
interface RawSpec {
  readonly provider?: unknown;
  readonly model?: unknown;
  readonly endpoint?: unknown;
  readonly apiKeyEnv?: unknown;
  readonly timeoutMs?: unknown;
  readonly options?: unknown;
  readonly headers?: unknown;
}

interface RawConfig {
  readonly default?: unknown;
  readonly routes?: unknown;
}

/**
 * Resolve one RawSpec into a ProviderSpec, reading the API key from the named env var. `where` is
 * used only in error messages (e.g. "default", "routes.plan"). Never logs the key.
 */
function resolveSpec(raw: RawSpec, where: string, env: NodeJS.ProcessEnv): ProviderSpec {
  if (typeof raw.provider !== 'string' || !VALID_PROVIDERS.has(raw.provider)) {
    throw new ModelRoutesConfigError(`${where}: provider must be one of ${[...VALID_PROVIDERS].join(', ')}`);
  }
  if (typeof raw.model !== 'string' || raw.model.trim().length === 0) {
    throw new ModelRoutesConfigError(`${where}: model must be a non-empty string`);
  }
  const provider = raw.provider as ModelProvider;

  let endpoint: string | undefined;
  if (raw.endpoint !== undefined) {
    if (typeof raw.endpoint !== 'string') throw new ModelRoutesConfigError(`${where}: endpoint must be a string`);
    endpoint = raw.endpoint;
  }
  if (provider === 'openai-compatible' && (endpoint === undefined || endpoint.trim().length === 0)) {
    throw new ModelRoutesConfigError(`${where}: openai-compatible requires an endpoint (the …/v1 base URL)`);
  }

  // Resolve the API key from the named env var (the file never holds the key itself).
  let apiKey: string | undefined;
  if (raw.apiKeyEnv !== undefined) {
    if (typeof raw.apiKeyEnv !== 'string' || raw.apiKeyEnv.trim().length === 0) {
      throw new ModelRoutesConfigError(`${where}: apiKeyEnv must be a non-empty environment variable name`);
    }
    const val = env[raw.apiKeyEnv];
    if (val === undefined || val.length === 0) {
      // Name the env var (safe) — never a value.
      throw new ModelRoutesConfigError(`${where}: environment variable ${raw.apiKeyEnv} is not set (needed for the API key)`);
    }
    apiKey = val;
  }

  let timeoutMs: number | undefined;
  if (raw.timeoutMs !== undefined) {
    if (typeof raw.timeoutMs !== 'number' || !Number.isFinite(raw.timeoutMs) || raw.timeoutMs <= 0) {
      throw new ModelRoutesConfigError(`${where}: timeoutMs must be a positive number`);
    }
    timeoutMs = raw.timeoutMs;
  }

  if (raw.options !== undefined && (typeof raw.options !== 'object' || raw.options === null)) {
    throw new ModelRoutesConfigError(`${where}: options must be an object`);
  }
  if (raw.headers !== undefined && (typeof raw.headers !== 'object' || raw.headers === null)) {
    throw new ModelRoutesConfigError(`${where}: headers must be an object`);
  }

  return {
    provider,
    model: raw.model,
    ...(endpoint !== undefined ? { endpoint } : {}),
    ...(apiKey !== undefined ? { apiKey } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(raw.options !== undefined ? { options: raw.options as Record<string, unknown> } : {}),
    ...(raw.headers !== undefined ? { headers: raw.headers as Record<string, string> } : {}),
  };
}

/**
 * Parse an already-read config OBJECT into a RoutingGatewayConfig. Pure except for reading env via
 * the injected `env` (defaults to process.env). Separated from file I/O so it is unit-testable.
 */
export function parseModelRoutes(obj: unknown, env: NodeJS.ProcessEnv = process.env): RoutingGatewayConfig {
  if (typeof obj !== 'object' || obj === null) {
    throw new ModelRoutesConfigError('config must be a JSON object');
  }
  const raw = obj as RawConfig;
  if (raw.default === undefined) {
    throw new ModelRoutesConfigError('config.default is required (the fallback spec for unmapped purposes)');
  }
  const def = resolveSpec(raw.default as RawSpec, 'default', env);

  const routes: Partial<Record<ModelPurpose, ProviderSpec>> = {};
  if (raw.routes !== undefined) {
    if (typeof raw.routes !== 'object' || raw.routes === null) {
      throw new ModelRoutesConfigError('config.routes must be an object');
    }
    for (const [purpose, spec] of Object.entries(raw.routes as Record<string, unknown>)) {
      if (!VALID_PURPOSES.has(purpose)) {
        throw new ModelRoutesConfigError(`routes.${purpose}: unknown purpose (valid: ${[...VALID_PURPOSES].join(', ')})`);
      }
      routes[purpose as ModelPurpose] = resolveSpec(spec as RawSpec, `routes.${purpose}`, env);
    }
  }

  return { default: def, routes };
}

/** Load + parse a model-routes config file. Throws ModelRoutesConfigError on any problem. */
export function loadModelRoutes(path: string, env: NodeJS.ProcessEnv = process.env): RoutingGatewayConfig {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    throw new ModelRoutesConfigError(`cannot read model-routes file at ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch {
    throw new ModelRoutesConfigError(`model-routes file at ${path} is not valid JSON`);
  }
  return parseModelRoutes(obj, env);
}
