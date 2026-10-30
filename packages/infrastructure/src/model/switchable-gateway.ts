/*
 * Copyright 2026 DienVu (Dienvu1008)
 * SPDX-License-Identifier: Apache-2.0
 */

// SwitchableModelGateway — a ModelGateway whose ACTIVE model AND provider can be changed at
// runtime, so the user can pick a different model (a stronger local Ollama model, or a commercial
// / free cloud provider over the OpenAI-compatible protocol) from the dashboard without restarting.
//
// It still implements the single ModelGateway contract (MG-001): the runtime holds ONE gateway
// reference; this wrapper swaps which underlying adapter that reference delegates to. A switch
// only takes effect for the NEXT generate() call — an in-flight call finishes on the adapter it
// started with (determinism within a call). It never decides anything; it only forwards generate()
// and reports identity.
//
// Backwards-compatible: the original Ollama-only constructor + setModel(name) API are preserved
// (default provider = 'ollama'), so existing callers (runtime CLI, observability service) are
// unchanged. New: setProvider(spec) switches provider+model+endpoint+key in one call.
import type { ModelGateway, ModelRequest, ModelResponse, ModelIdentity } from '@codeforge/agent-core';
import { buildAdapter, type ProviderSpec, type ModelProvider } from './provider-adapter.js';

// Re-export so existing importers of these types from switchable-gateway keep working.
export type { ProviderSpec, ModelProvider } from './provider-adapter.js';

export interface SwitchableGatewayConfig {
  readonly endpoint: string;
  readonly initialModel: string;
  readonly timeoutMs?: number;
  readonly options?: Readonly<Record<string, unknown>>;
}

export class SwitchableModelGateway implements ModelGateway {
  private current: ModelGateway;
  private _spec: ProviderSpec;
  private readonly _defaultTimeoutMs: number | undefined;
  private readonly _defaultOptions: Readonly<Record<string, unknown>> | undefined;

  constructor(config: SwitchableGatewayConfig) {
    this._defaultTimeoutMs = config.timeoutMs;
    this._defaultOptions = config.options;
    this._spec = {
      provider: 'ollama',
      model: config.initialModel,
      endpoint: config.endpoint,
      ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
      ...(config.options !== undefined ? { options: config.options } : {}),
    };
    this.current = buildAdapter(this._spec);
  }

  /** The model id currently in effect. */
  get model(): string { return this._spec.model; }

  /** The provider currently in effect. */
  get provider(): ModelProvider { return this._spec.provider; }

  /** Identity of the currently-selected model (MG-004). */
  get identity(): ModelIdentity { return this.current.identity; }

  /**
   * Switch the active model WITHIN the current provider (backwards-compatible API). No-op when the
   * model is already selected. Returns the new model id. For a cross-provider switch, use
   * setProvider().
   */
  setModel(model: string): string {
    const next = model.trim();
    if (next === '' || next === this._spec.model) return this._spec.model;
    this.setProvider({ ...this._spec, model: next });
    return this._spec.model;
  }

  /**
   * Switch provider + model (+ endpoint/key/options) in one call. Rebuilds the inner adapter so
   * subsequent generate() calls target the new provider. Fail-safe: an unknown provider throws
   * before replacing the live adapter, so the current one keeps working. Returns the new model id.
   */
  setProvider(spec: ProviderSpec): string {
    const next: ProviderSpec = {
      ...spec,
      model: spec.model.trim(),
      // Inherit the construction-time defaults when the caller omits them.
      ...(spec.timeoutMs === undefined && this._defaultTimeoutMs !== undefined ? { timeoutMs: this._defaultTimeoutMs } : {}),
      ...(spec.options === undefined && this._defaultOptions !== undefined ? { options: this._defaultOptions } : {}),
    };
    const built = buildAdapter(next); // may throw for an unknown provider — current adapter untouched
    this._spec = next;
    this.current = built;
    return this._spec.model;
  }

  generate(request: ModelRequest): Promise<ModelResponse> {
    return this.current.generate(request);
  }
}
