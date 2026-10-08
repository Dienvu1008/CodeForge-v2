// OllamaModelAdmin — Ollama MODEL MANAGEMENT client (list + pull). This is deliberately SEPARATE
// from OllamaModelGateway: MG-001 keeps the gateway the single boundary for LLM *generation*
// calls, while model administration (listing installed models, downloading new ones) is an
// operational concern with no authority over the runtime. Nothing here can plan, execute, or
// change kernel state — it only talks to Ollama's /api/tags and /api/pull.
//
// Uses Node built-in fetch (Node 18+). No external deps.

export interface OllamaModelInfo {
  readonly name: string;
  /** Size in bytes, when reported by Ollama. */
  readonly sizeBytes?: number;
  /** Quantization level, e.g. 'Q4_K_M', when reported. */
  readonly quantization?: string;
  /** Parameter size, e.g. '7B', when reported. */
  readonly parameterSize?: string;
  /** ISO modified timestamp, when reported. */
  readonly modifiedAt?: string;
}

/** A single progress update from a streaming pull. */
export interface PullProgress {
  /** Ollama status string, e.g. 'pulling manifest', 'downloading', 'success'. */
  readonly status: string;
  /** Total bytes for the current layer, when known. */
  readonly total?: number;
  /** Completed bytes for the current layer, when known. */
  readonly completed?: number;
  /** 0–100 percent for the current layer, derived from completed/total. */
  readonly percent?: number;
  /** True on the terminal success chunk. */
  readonly done: boolean;
  /** Set when Ollama reported an error for this pull. */
  readonly error?: string;
}

export interface OllamaModelAdminConfig {
  readonly endpoint: string;
  /** Timeout for the (fast) list call. Default 10s. Pull has NO hard timeout (large downloads). */
  readonly listTimeoutMs?: number;
}

export class OllamaModelAdminError extends Error {
  constructor(message: string) { super(message); this.name = 'OllamaModelAdminError'; }
}

export class OllamaModelAdmin {
  private readonly endpoint: string;
  private readonly listTimeoutMs: number;

  constructor(config: OllamaModelAdminConfig) {
    this.endpoint = config.endpoint.replace(/\/$/, '');
    this.listTimeoutMs = config.listTimeoutMs ?? 10_000;
  }

  /** List locally-installed models (GET /api/tags). Throws OllamaModelAdminError if unreachable. */
  async listModels(): Promise<readonly OllamaModelInfo[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.listTimeoutMs);
    try {
      const res = await fetch(`${this.endpoint}/api/tags`, { signal: controller.signal });
      if (!res.ok) throw new OllamaModelAdminError(`Ollama /api/tags HTTP ${res.status}`);
      const body = (await res.json()) as { models?: unknown };
      const models = Array.isArray(body.models) ? body.models : [];
      return models.map(normalizeModel).filter((m): m is OllamaModelInfo => m !== undefined)
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    } catch (err) {
      if (err instanceof OllamaModelAdminError) throw err;
      throw new OllamaModelAdminError(
        `Ollama unreachable at ${this.endpoint}: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Pull (download) a model (POST /api/pull, NDJSON stream). Invokes onProgress for each chunk.
   * Resolves when the stream ends; rejects on a transport error. A model-level error is reported
   * via a final PullProgress with `error` set (not thrown) so the UI can show it. There is NO
   * hard timeout — model downloads can take a long time; the caller/UI owns cancellation.
   */
  async pullModel(name: string, onProgress: (p: PullProgress) => void): Promise<void> {
    const trimmed = name.trim();
    if (trimmed === '') throw new OllamaModelAdminError('model name required');

    let res: Response;
    try {
      res = await fetch(`${this.endpoint}/api/pull`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: trimmed, stream: true }),
      });
    } catch (err) {
      throw new OllamaModelAdminError(
        `Ollama unreachable at ${this.endpoint}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new OllamaModelAdminError(`Ollama /api/pull HTTP ${res.status}: ${text.slice(0, 200)}`);
    }

    const stream = res.body;
    if (stream === null) {
      // Non-streaming body (e.g. a test double): parse once.
      const text = await res.text();
      for (const line of splitLines(text)) emit(line, onProgress);
      return;
    }

    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // NDJSON: process complete lines; keep the trailing partial in the buffer.
        let nl = buffer.indexOf('\n');
        while (nl >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (line.length > 0) emit(line, onProgress);
          nl = buffer.indexOf('\n');
        }
      }
      buffer += decoder.decode();
      const tail = buffer.trim();
      if (tail.length > 0) emit(tail, onProgress);
    } catch (err) {
      throw new OllamaModelAdminError(`Ollama pull stream error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      reader.releaseLock();
    }
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────

function normalizeModel(raw: unknown): OllamaModelInfo | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const m = raw as Record<string, unknown>;
  if (typeof m.name !== 'string') return undefined;
  const details = (typeof m.details === 'object' && m.details !== null ? m.details : {}) as Record<string, unknown>;
  return {
    name: m.name,
    ...(typeof m.size === 'number' ? { sizeBytes: m.size } : {}),
    ...(typeof m.modified_at === 'string' ? { modifiedAt: m.modified_at } : {}),
    ...(typeof details.quantization_level === 'string' ? { quantization: details.quantization_level } : {}),
    ...(typeof details.parameter_size === 'string' ? { parameterSize: details.parameter_size } : {}),
  };
}

function splitLines(text: string): string[] {
  return text.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
}

function emit(line: string, onProgress: (p: PullProgress) => void): void {
  let chunk: Record<string, unknown>;
  try { chunk = JSON.parse(line) as Record<string, unknown>; } catch { return; }
  const status = typeof chunk.status === 'string' ? chunk.status : (typeof chunk.error === 'string' ? 'error' : 'unknown');
  const total = typeof chunk.total === 'number' ? chunk.total : undefined;
  const completed = typeof chunk.completed === 'number' ? chunk.completed : undefined;
  const percent = total !== undefined && total > 0 && completed !== undefined
    ? Math.round((completed / total) * 100)
    : undefined;
  const progress: PullProgress = {
    status,
    ...(total !== undefined ? { total } : {}),
    ...(completed !== undefined ? { completed } : {}),
    ...(percent !== undefined ? { percent } : {}),
    done: status === 'success',
    ...(typeof chunk.error === 'string' ? { error: chunk.error } : {}),
  };
  onProgress(progress);
}
