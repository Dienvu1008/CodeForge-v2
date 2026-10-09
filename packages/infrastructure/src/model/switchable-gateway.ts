// SwitchableModelGateway — a ModelGateway whose ACTIVE model can be changed at runtime, so the
// user can pick a different Ollama model (e.g. a stronger one) from the dashboard without
// restarting the runtime. It still implements the single ModelGateway contract (MG-001): the
// runtime holds ONE gateway reference; this wrapper just swaps which underlying OllamaModelGateway
// (and thus which model) that reference delegates to. Switching only takes effect for the NEXT
// generate() call — an in-flight call finishes on the model it started with (determinism within a
// call). It never decides anything; it only forwards generate() and reports identity.
import type { ModelGateway, ModelRequest, ModelResponse, ModelIdentity } from '@codeforge/agent-core';
import { OllamaModelGateway, type OllamaConfig } from './ollama-gateway.js';

export interface SwitchableGatewayConfig {
  readonly endpoint: string;
  readonly initialModel: string;
  readonly timeoutMs?: number;
  readonly options?: Readonly<Record<string, unknown>>;
}

export class SwitchableModelGateway implements ModelGateway {
  private current: OllamaModelGateway;
  private _model: string;
  private readonly base: Omit<OllamaConfig, 'model'>;

  constructor(config: SwitchableGatewayConfig) {
    this._model = config.initialModel;
    this.base = {
      endpoint: config.endpoint,
      ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
      ...(config.options !== undefined ? { options: config.options } : {}),
    };
    this.current = new OllamaModelGateway({ ...this.base, model: this._model });
  }

  /** The model id currently in effect. */
  get model(): string { return this._model; }

  /** Identity of the currently-selected model (MG-004). */
  get identity(): ModelIdentity { return this.current.identity; }

  /**
   * Switch the active model. No-op when it is already selected. Rebuilds the inner gateway so
   * subsequent generate() calls target the new model. Returns the new model id.
   */
  setModel(model: string): string {
    const next = model.trim();
    if (next === '' || next === this._model) return this._model;
    this._model = next;
    this.current = new OllamaModelGateway({ ...this.base, model: next });
    return this._model;
  }

  generate(request: ModelRequest): Promise<ModelResponse> {
    return this.current.generate(request);
  }
}
