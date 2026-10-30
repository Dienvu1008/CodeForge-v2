/*
 * Copyright 2026 DienVu (Dienvu1008)
 * SPDX-License-Identifier: Apache-2.0
 */

// model-registry-config — load a multi-model registry from a JSON file so mission-driven routing
// (P12.9) has more than one model to choose from. Each entry describes a model BOTH to the router
// (id + tier + capabilities, consumed by agent-core's ModelRegistry/routeModel) AND to the runtime
// selector (a ProviderSpec: how to actually run it). One file, one source of truth.
//
// Secrets: like the routes file, the registry file holds NO API key — a cloud entry names an env
// var via `apiKeyEnv`, read at load time. Nothing here is logged.
//
// File shape:
//   {
//     "preferred": "qwen2.5-coder:latest",            // optional: router's preferred id
//     "models": [
//       { "id": "qwen2.5-coder:latest", "tier": "SMALL",  "provider": "ollama",
//         "endpoint": "http://localhost:11434",
//         "capabilities": { "reasoning":"LOW","coding":"MEDIUM","architecture":"LOW",
//                           "context":"SMALL","toolUse":"MEDIUM","speed":"FAST" } },
//       { "id": "deepseek-r1:14b", "tier": "STRONG", "provider": "ollama",
//         "endpoint": "http://localhost:11434",
//         "capabilities": { "reasoning":"HIGH","coding":"HIGH","architecture":"HIGH",
//                           "context":"LARGE","toolUse":"MEDIUM","speed":"SLOW" } }
//     ]
//   }
import { readFileSync } from 'node:fs';
import { ModelRegistry, type RegisteredModel, type ModelCapabilities } from '@codeforge/agent-core';
import type { ProviderSpec, ModelProvider } from './provider-adapter.js';

export class ModelRegistryConfigError extends Error {
  constructor(message: string) { super(message); this.name = 'ModelRegistryConfigError'; }
}

export interface LoadedModelRegistry {
  readonly registry: ModelRegistry;
  /** id → ProviderSpec, for the RuntimeModelSelector to apply a routed id. */
  readonly specsById: ReadonlyMap<string, ProviderSpec>;
  /** The default/first model id — used to seed the gateway's starting model. */
  readonly defaultModelId: string;
  /** Optional preferred id the router should favor. */
  readonly preferredModelId: string | undefined;
}

const TIERS: ReadonlySet<string> = new Set<RegisteredModel['tier']>(['SMALL', 'MEDIUM', 'STRONG', 'ARCHITECTURE']);
const LEVELS: ReadonlySet<string> = new Set(['LOW', 'MEDIUM', 'HIGH']);
const CTX: ReadonlySet<string> = new Set(['SMALL', 'MEDIUM', 'LARGE']);
const SPEEDS: ReadonlySet<string> = new Set(['FAST', 'MEDIUM', 'SLOW']);
const PROVIDERS: ReadonlySet<string> = new Set<ModelProvider>(['ollama', 'openai-compatible']);

function lvl(v: unknown, where: string): 'LOW' | 'MEDIUM' | 'HIGH' {
  if (typeof v !== 'string' || !LEVELS.has(v)) throw new ModelRegistryConfigError(`${where}: must be LOW|MEDIUM|HIGH`);
  return v as 'LOW' | 'MEDIUM' | 'HIGH';
}

function parseCapabilities(raw: unknown, where: string): ModelCapabilities {
  if (typeof raw !== 'object' || raw === null) throw new ModelRegistryConfigError(`${where}: capabilities must be an object`);
  const c = raw as Record<string, unknown>;
  if (typeof c['context'] !== 'string' || !CTX.has(c['context'])) throw new ModelRegistryConfigError(`${where}: context must be SMALL|MEDIUM|LARGE`);
  if (typeof c['speed'] !== 'string' || !SPEEDS.has(c['speed'])) throw new ModelRegistryConfigError(`${where}: speed must be FAST|MEDIUM|SLOW`);
  return {
    reasoning: lvl(c['reasoning'], `${where}.reasoning`),
    coding: lvl(c['coding'], `${where}.coding`),
    architecture: lvl(c['architecture'], `${where}.architecture`),
    context: c['context'] as ModelCapabilities['context'],
    toolUse: lvl(c['toolUse'], `${where}.toolUse`),
    speed: c['speed'] as ModelCapabilities['speed'],
  };
}

interface RawModel {
  readonly id?: unknown;
  readonly tier?: unknown;
  readonly provider?: unknown;
  readonly endpoint?: unknown;
  readonly apiKeyEnv?: unknown;
  readonly timeoutMs?: unknown;
  readonly capabilities?: unknown;
}

/** Parse an already-read registry object. Pure except for reading env via `env`. */
export function parseModelRegistry(obj: unknown, env: NodeJS.ProcessEnv = process.env): LoadedModelRegistry {
  if (typeof obj !== 'object' || obj === null) throw new ModelRegistryConfigError('config must be a JSON object');
  const root = obj as { models?: unknown; preferred?: unknown };
  if (!Array.isArray(root.models) || root.models.length === 0) {
    throw new ModelRegistryConfigError('config.models must be a non-empty array');
  }

  const registered: RegisteredModel[] = [];
  const specsById = new Map<string, ProviderSpec>();

  root.models.forEach((m, i) => {
    const where = `models[${i}]`;
    const raw = m as RawModel;
    if (typeof raw.id !== 'string' || raw.id.trim().length === 0) throw new ModelRegistryConfigError(`${where}: id must be a non-empty string`);
    if (typeof raw.tier !== 'string' || !TIERS.has(raw.tier)) throw new ModelRegistryConfigError(`${where}: tier must be SMALL|MEDIUM|STRONG|ARCHITECTURE`);
    if (typeof raw.provider !== 'string' || !PROVIDERS.has(raw.provider)) throw new ModelRegistryConfigError(`${where}: provider must be ollama|openai-compatible`);
    const provider = raw.provider as ModelProvider;

    let endpoint: string | undefined;
    if (raw.endpoint !== undefined) {
      if (typeof raw.endpoint !== 'string') throw new ModelRegistryConfigError(`${where}: endpoint must be a string`);
      endpoint = raw.endpoint;
    }
    if (provider === 'openai-compatible' && (endpoint === undefined || endpoint.trim().length === 0)) {
      throw new ModelRegistryConfigError(`${where}: openai-compatible requires an endpoint`);
    }

    let apiKey: string | undefined;
    if (raw.apiKeyEnv !== undefined) {
      if (typeof raw.apiKeyEnv !== 'string' || raw.apiKeyEnv.trim().length === 0) throw new ModelRegistryConfigError(`${where}: apiKeyEnv must be an env var name`);
      const val = env[raw.apiKeyEnv];
      if (val === undefined || val.length === 0) throw new ModelRegistryConfigError(`${where}: environment variable ${raw.apiKeyEnv} is not set`);
      apiKey = val;
    }

    let timeoutMs: number | undefined;
    if (raw.timeoutMs !== undefined) {
      if (typeof raw.timeoutMs !== 'number' || !Number.isFinite(raw.timeoutMs) || raw.timeoutMs <= 0) throw new ModelRegistryConfigError(`${where}: timeoutMs must be a positive number`);
      timeoutMs = raw.timeoutMs;
    }

    registered.push({ id: raw.id, tier: raw.tier as RegisteredModel['tier'], capabilities: parseCapabilities(raw.capabilities, `${where}.capabilities`) });
    specsById.set(raw.id, {
      provider, model: raw.id,
      ...(endpoint !== undefined ? { endpoint } : {}),
      ...(apiKey !== undefined ? { apiKey } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    });
  });

  let preferredModelId: string | undefined;
  if (root.preferred !== undefined) {
    if (typeof root.preferred !== 'string') throw new ModelRegistryConfigError('config.preferred must be a string');
    if (!specsById.has(root.preferred)) throw new ModelRegistryConfigError(`config.preferred '${root.preferred}' is not one of the listed models`);
    preferredModelId = root.preferred;
  }

  const first = registered[0];
  if (first === undefined) throw new ModelRegistryConfigError('config.models must be a non-empty array');

  return {
    registry: new ModelRegistry(registered),
    specsById,
    defaultModelId: preferredModelId ?? first.id,
    preferredModelId,
  };
}

/** Load + parse a model-registry config file. Throws ModelRegistryConfigError on any problem. */
export function loadModelRegistry(path: string, env: NodeJS.ProcessEnv = process.env): LoadedModelRegistry {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    throw new ModelRegistryConfigError(`cannot read model-registry file at ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch {
    throw new ModelRegistryConfigError(`model-registry file at ${path} is not valid JSON`);
  }
  return parseModelRegistry(obj, env);
}
