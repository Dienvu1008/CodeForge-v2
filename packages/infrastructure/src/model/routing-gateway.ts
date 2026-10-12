// RoutingModelGateway — a ModelGateway that routes each call to a provider/model chosen by the
// call's PURPOSE (plan / execute / architect / critique / analyze_failure / summarize / replan).
// This is the "shunt"-style idea: run reasoning-heavy purposes (plan, architect) on a strong
// (possibly commercial) model and I/O-heavy / mechanical purposes (execute, summarize) on a
// cheaper or local model — all behind the SINGLE ModelGateway reference the runtime holds (MG-001).
//
// It never decides anything about the task; it only forwards generate() to the adapter mapped to
// the request's purpose, falling back to a default spec for any unmapped purpose. Routing is
// DETERMINISTIC and config-driven — the LLM never chooses its own model (the central law).
//
// DC-002 / secrets: specs (incl. any API key) are held only to construct adapters; nothing here is
// logged. Adapters are built lazily and cached by spec so a provider isn't reconstructed per call.
import type { ModelGateway, ModelRequest, ModelResponse, ModelIdentity, ModelPurpose } from '@codeforge/agent-core';
import { buildAdapter, specCacheKey, type ProviderSpec } from './provider-adapter.js';

export interface RoutingGatewayConfig {
  /** Spec used for any purpose not present in `routes`. Also provides this gateway's identity. */
  readonly default: ProviderSpec;
  /** Per-purpose overrides. A purpose not listed here uses `default`. */
  readonly routes?: Partial<Record<ModelPurpose, ProviderSpec>>;
}

export class RoutingModelGateway implements ModelGateway {
  private readonly _default: ProviderSpec;
  private readonly _routes: Partial<Record<ModelPurpose, ProviderSpec>>;
  private readonly _cache = new Map<string, ModelGateway>();
  readonly identity: ModelIdentity;

  constructor(config: RoutingGatewayConfig) {
    this._default = config.default;
    this._routes = config.routes ?? {};
    // Build the default adapter eagerly so a bad default spec fails fast (and gives us identity).
    const def = this.adapterFor(this._default);
    this.identity = def.identity;
  }

  /** The spec that will serve a given purpose (its route, or the default). Pure. */
  specFor(purpose: ModelPurpose): ProviderSpec {
    return this._routes[purpose] ?? this._default;
  }

  async generate(request: ModelRequest): Promise<ModelResponse> {
    // async so a build error for a bad route surfaces as a rejected promise (not a sync throw),
    // matching how every ModelGateway reports failure.
    const spec = this.specFor(request.purpose);
    return this.adapterFor(spec).generate(request);
  }

  // ── internals ────────────────────────────────────────────────────────────────

  /** Lazily build + cache the adapter for a spec (identical specs share one instance). */
  private adapterFor(spec: ProviderSpec): ModelGateway {
    const key = specCacheKey(spec);
    let gw = this._cache.get(key);
    if (gw === undefined) {
      gw = buildAdapter(spec); // may throw for an invalid spec — surfaced to the caller
      this._cache.set(key, gw);
    }
    return gw;
  }
}
