// SwitchableRuntimeModelSelector — the infrastructure side of P12.9 mission-driven routing.
//
// agent-core's orchestrator hands this a MODEL ID the mission router chose (it never knows the
// provider/endpoint/key — DC-002). This class owns the id → ProviderSpec map and applies the
// switch to the single SwitchableModelGateway (MG-001). An id that is not in the map is a no-op
// (the active model is left unchanged), so a mission recommending a model we don't have configured
// never breaks the run. Never logs the API key.
import type { RuntimeModelSelector } from '@codeforge/agent-core';
import type { SwitchableModelGateway } from './switchable-gateway.js';
import type { ProviderSpec } from './provider-adapter.js';

export interface SwitchableRuntimeModelSelectorConfig {
  /** The one gateway reference whose active model/provider this selector switches. */
  readonly gateway: SwitchableModelGateway;
  /** Known model ids → how to run them. An id not present here is ignored (no switch). */
  readonly specsById: ReadonlyMap<string, ProviderSpec>;
  /** Optional sink for a human-readable note on each applied switch (never includes the key). */
  readonly onSwitch?: (note: string) => void;
}

export class SwitchableRuntimeModelSelector implements RuntimeModelSelector {
  private readonly gateway: SwitchableModelGateway;
  private readonly specsById: ReadonlyMap<string, ProviderSpec>;
  private readonly onSwitch: ((note: string) => void) | undefined;

  constructor(config: SwitchableRuntimeModelSelectorConfig) {
    this.gateway = config.gateway;
    this.specsById = config.specsById;
    this.onSwitch = config.onSwitch;
  }

  /**
   * Apply a mission-recommended model id. Looks it up in the configured map and switches the
   * gateway to that provider/model. No-ops when: the id is already active, or the id is unknown
   * (not configured). Never throws from a lookup miss — an unknown id simply leaves the current
   * model in place (fail-safe; the orchestrator also guards with try/catch).
   */
  selectModel(id: string): void {
    const next = id.trim();
    if (next.length === 0) return;
    if (next === this.gateway.model) return; // already active
    const spec = this.specsById.get(next);
    if (spec === undefined) return; // unknown id → leave the current model unchanged
    this.gateway.setProvider(spec);
    // Note the provider + model + endpoint only — never the key.
    if (this.onSwitch !== undefined) {
      this.onSwitch(`model switched to ${spec.provider} '${spec.model}'${spec.endpoint !== undefined ? ` @ ${spec.endpoint}` : ''}`);
    }
  }
}
