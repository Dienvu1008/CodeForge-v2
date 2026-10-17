// LspAdapter — P7-LX1 (P12.16: generalized to a server registry). Code intelligence via a
// Language Server (LSP over stdio).
//
// One adapter drives ONE server for ONE language family, described by an LspServerSpec. The
// default spec is typescript-language-server (a pure-Node package, pinned as a dependency so it
// is reliably present — no system install, cross-platform, headless); pass a different spec to
// drive another language's server. Adding a language = register one LspServerSpec (no change to
// the JSON-RPC core below). An LspPool maps a file extension to the right adapter.
//
// Speaks LSP JSON-RPC over the server's stdio: Content-Length framing, request/response
// correlation by id, notifications for lifecycle.
//
// Design:
//   - start() spawns + initializes the server once; reused across calls.
//   - stop() shuts it down cleanly; idempotent.
//   - documentSymbol / definition / references open the document then query.
//   - Every request has a timeout so a wedged server can never hang the caller.
//   - isAvailable() lets callers/tests skip gracefully if the server can't resolve
//     (CI-safe), though as a pinned dep it is normally present.
//   - Returns PLAIN DATA (LspSymbol / LspLocation) so it feeds the same retriever
//     interface as SX1/IG1 — no change to the context Retriever (CR1/CR2).
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { extname } from 'node:path';

// ── Language-server registry ──────────────────────────────────────────────────
//
// One LspAdapter drives ONE server for ONE language family. A server is described by an
// LspServerSpec; the registry (DEFAULT_LSP_SERVERS) maps a languageId to its spec, and an
// LspPool maps a file EXTENSION to the right adapter. This is the single place that knows
// "which server, how to launch it, and what languageId to announce" — the three facts that
// used to be hard-coded for typescript-language-server. Adding a language = add one spec.

/** A resolved launch command: the executable + its args. */
export interface ResolvedLaunch {
  readonly command: string;
  readonly args:    readonly string[];
}

/**
 * Describes one language server. `resolveLaunch()` returns how to spawn it, or throws
 * LspError('SERVER_NOT_FOUND') when the server is not installed/resolvable on this machine
 * (so isAvailable() can report false and callers degrade to tree-sitter).
 *
 * Two common shapes:
 *   - a pure-Node package server (e.g. typescript-language-server): resolveLaunch runs the
 *     resolved entry through the current `node` (process.execPath) — no system install needed.
 *   - a standalone binary on PATH (e.g. pyright-langserver, gopls): resolveLaunch returns the
 *     binary name + args directly; availability is "is it on PATH" (left to spawn to discover).
 */
export interface LspServerSpec {
  /** Language family id announced to the server in didOpen (e.g. 'typescript', 'python'). */
  readonly languageId: string;
  /** File extensions ('.ts', '.tsx', …) this server handles. Lower-case, with the dot. */
  readonly extensions: readonly string[];
  /** Resolve how to launch the server, or throw LspError('SERVER_NOT_FOUND') if unavailable. */
  readonly resolveLaunch: () => ResolvedLaunch;
}

/** The TS/JS server (typescript-language-server), launched as a Node entry via process.execPath. */
export const TYPESCRIPT_LSP_SERVER: LspServerSpec = {
  languageId: 'typescript',
  extensions: ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'],
  resolveLaunch(): ResolvedLaunch {
    const require = createRequire(import.meta.url);
    let pkgPath: string;
    try {
      pkgPath = require.resolve('typescript-language-server/package.json');
    } catch {
      throw new LspError('SERVER_NOT_FOUND', 'typescript-language-server is not installed');
    }
    const dir = pkgPath.slice(0, pkgPath.lastIndexOf('package.json'));
    return { command: process.execPath, args: [`${dir}lib/cli.mjs`, '--stdio'] };
  },
};

/** Built-in server registry, keyed by languageId. Extend by adding specs here. */
export const DEFAULT_LSP_SERVERS: readonly LspServerSpec[] = [
  TYPESCRIPT_LSP_SERVER,
];

/** Resolve the LspServerSpec for a file extension (lower-cased, with dot), or null. */
export function lspServerForExtension(
  ext: string,
  servers: readonly LspServerSpec[] = DEFAULT_LSP_SERVERS,
): LspServerSpec | null {
  const lower = ext.toLowerCase();
  return servers.find((s) => s.extensions.includes(lower)) ?? null;
}

// ── Public types ────────────────────────────────────────────────────────────

export interface LspPosition {
  readonly line:      number; // 0-indexed
  readonly character: number; // 0-indexed
}

export interface LspRange {
  readonly start: LspPosition;
  readonly end:   LspPosition;
}

export interface LspSymbol {
  readonly name:  string;
  /** LSP SymbolKind number (e.g. 12 = Function, 5 = Class). */
  readonly kind:  number;
  readonly range: LspRange;
}

export interface LspLocation {
  readonly uri:   string;
  readonly range: LspRange;
}

export class LspError extends Error {
  public readonly code: 'NOT_STARTED' | 'SPAWN_FAILED' | 'TIMEOUT' | 'SERVER_NOT_FOUND';
  constructor(code: LspError['code'], message?: string) {
    super(message ?? code);
    this.name = 'LspError';
    this.code = code;
  }
}

// ── LspAdapter ────────────────────────────────────────────────────────────────

export interface LspAdapterOptions {
  /** Per-request timeout (ms). Default 15000. */
  readonly requestTimeoutMs?: number;
  /**
   * Which language server this adapter drives. Default: the TS/JS server
   * (TYPESCRIPT_LSP_SERVER), preserving the original behavior. Pass another spec to drive a
   * different language's server (one adapter = one server/language).
   */
  readonly server?: LspServerSpec;
}

interface Pending {
  resolve: (msg: JsonRpcResponse) => void;
  timer:   NodeJS.Timeout;
}

interface JsonRpcResponse {
  readonly id?:     number;
  readonly result?: unknown;
  readonly error?:  { code: number; message: string };
}

export class LspAdapter {
  private _child: ChildProcessWithoutNullStreams | null = null;
  private _buf = Buffer.alloc(0);
  private _nextId = 1;
  private readonly _pending = new Map<number, Pending>();
  private readonly _openDocs = new Set<string>();
  private readonly _timeoutMs: number;
  private readonly _server: LspServerSpec;

  constructor(opts?: LspAdapterOptions) {
    this._timeoutMs = opts?.requestTimeoutMs ?? 15000;
    this._server    = opts?.server ?? TYPESCRIPT_LSP_SERVER;
  }

  /** The language family id this adapter announces (from its server spec). */
  get languageId(): string {
    return this._server.languageId;
  }

  /** True if the given server (default TS/JS) can be launched on this machine (CI-safe gate). */
  static isAvailable(server: LspServerSpec = TYPESCRIPT_LSP_SERVER): boolean {
    try {
      server.resolveLaunch();
      return true;
    } catch {
      return false;
    }
  }

  /** Start + initialize the server for `rootDir`. Idempotent (reuses the session). */
  async start(rootDir: string): Promise<void> {
    if (this._child !== null) return;

    const launch = this._server.resolveLaunch(); // throws SERVER_NOT_FOUND when unavailable
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(launch.command, [...launch.args], { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      throw new LspError('SPAWN_FAILED', `Failed to spawn language server: ${String(err)}`);
    }
    this._child = child;
    child.stdout.on('data', (chunk: Buffer) => this._onData(chunk));
    // stderr is diagnostics only — drain it so the pipe never blocks.
    child.stderr.on('data', () => { /* ignore */ });

    const rootUri = pathToFileURL(rootDir).href;
    await this._request('initialize', {
      processId: process.pid,
      rootUri,
      capabilities: {},
      workspaceFolders: [{ uri: rootUri, name: 'codeforge' }],
    });
    this._notify('initialized', {});
  }

  /** Shut the server down cleanly. Idempotent. */
  async stop(): Promise<void> {
    const child = this._child;
    if (child === null) return;
    try {
      await this._request('shutdown', {});
      this._notify('exit', {});
    } catch {
      // best-effort; fall through to kill
    }
    for (const p of this._pending.values()) clearTimeout(p.timer);
    this._pending.clear();
    this._openDocs.clear();
    try { child.kill(); } catch { /* already gone */ }
    this._child = null;
    this._buf = Buffer.alloc(0);
  }

  /** Document symbols for a TS/JS source. */
  async documentSymbol(uri: string, text: string): Promise<readonly LspSymbol[]> {
    this._requireStarted();
    this._ensureOpen(uri, text);
    const res = await this._request('textDocument/documentSymbol', { textDocument: { uri } });
    return toSymbols(res.result);
  }

  /** Definition location(s) for the symbol at `position`. */
  async definition(uri: string, text: string, position: LspPosition): Promise<readonly LspLocation[]> {
    this._requireStarted();
    this._ensureOpen(uri, text);
    const res = await this._request('textDocument/definition', {
      textDocument: { uri },
      position,
    });
    return toLocations(res.result);
  }

  /** Reference location(s) for the symbol at `position`. */
  async references(uri: string, text: string, position: LspPosition): Promise<readonly LspLocation[]> {
    this._requireStarted();
    this._ensureOpen(uri, text);
    const res = await this._request('textDocument/references', {
      textDocument: { uri },
      position,
      context: { includeDeclaration: true },
    });
    return toLocations(res.result);
  }

  // ── private ─────────────────────────────────────────────────────────────────

  private _requireStarted(): void {
    if (this._child === null) throw new LspError('NOT_STARTED', 'Call start() before querying');
  }

  private _ensureOpen(uri: string, text: string): void {
    if (this._openDocs.has(uri)) return;
    this._notify('textDocument/didOpen', {
      textDocument: { uri, languageId: this._server.languageId, version: 1, text },
    });
    this._openDocs.add(uri);
  }

  private _request(method: string, params: unknown): Promise<JsonRpcResponse> {
    const child = this._child;
    if (child === null) return Promise.reject(new LspError('NOT_STARTED'));
    const id = this._nextId++;
    const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, method, params }), 'utf8');
    return new Promise<JsonRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new LspError('TIMEOUT', `LSP request '${method}' timed out`));
      }, this._timeoutMs);
      this._pending.set(id, { resolve, timer });
      child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
      child.stdin.write(body);
    });
  }

  private _notify(method: string, params: unknown): void {
    const child = this._child;
    if (child === null) return;
    const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', method, params }), 'utf8');
    child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    child.stdin.write(body);
  }

  private _onData(chunk: Buffer): void {
    this._buf = Buffer.concat([this._buf, chunk]);
    for (;;) {
      const headerEnd = this._buf.indexOf('\r\n\r\n');
      if (headerEnd < 0) break;
      const header = this._buf.subarray(0, headerEnd).toString('utf8');
      const m = /Content-Length:\s*(\d+)/i.exec(header);
      if (m === null) { this._buf = this._buf.subarray(headerEnd + 4); continue; }
      const len = Number(m[1]);
      const start = headerEnd + 4;
      if (this._buf.length < start + len) break;
      const body = this._buf.subarray(start, start + len).toString('utf8');
      this._buf = this._buf.subarray(start + len);
      let msg: JsonRpcResponse;
      try { msg = JSON.parse(body) as JsonRpcResponse; } catch { continue; }
      if (msg.id !== undefined) {
        const pending = this._pending.get(msg.id);
        if (pending !== undefined) {
          clearTimeout(pending.timer);
          this._pending.delete(msg.id);
          pending.resolve(msg);
        }
      }
      // Server-initiated requests/notifications are ignored (we advertise no caps).
    }
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

interface RawDocSymbol {
  name?: unknown;
  kind?: unknown;
  range?: unknown;
  location?: { range?: unknown };
}

function toSymbols(result: unknown): LspSymbol[] {
  if (!Array.isArray(result)) return [];
  const out: LspSymbol[] = [];
  for (const r of result as RawDocSymbol[]) {
    const range = toRange(r.range ?? r.location?.range);
    if (typeof r.name === 'string' && typeof r.kind === 'number' && range !== null) {
      out.push({ name: r.name, kind: r.kind, range });
    }
  }
  return out;
}

function toLocations(result: unknown): LspLocation[] {
  const arr = Array.isArray(result) ? result : result === null || result === undefined ? [] : [result];
  const out: LspLocation[] = [];
  for (const r of arr as Array<{ uri?: unknown; range?: unknown }>) {
    const range = toRange(r.range);
    if (typeof r.uri === 'string' && range !== null) out.push({ uri: r.uri, range });
  }
  return out;
}

function toRange(raw: unknown): LspRange | null {
  if (raw === null || typeof raw !== 'object') return null;
  const r = raw as { start?: unknown; end?: unknown };
  const start = toPosition(r.start);
  const end = toPosition(r.end);
  if (start === null || end === null) return null;
  return { start, end };
}

function toPosition(raw: unknown): LspPosition | null {
  if (raw === null || typeof raw !== 'object') return null;
  const p = raw as { line?: unknown; character?: unknown };
  if (typeof p.line !== 'number' || typeof p.character !== 'number') return null;
  return { line: p.line, character: p.character };
}

// ── LspPool ───────────────────────────────────────────────────────────────────
//
// Routes a file to the right language server by its extension, lazily starting one LspAdapter
// per language family and reusing it across calls. A language whose server is unavailable
// (isAvailable=false) resolves to null so the caller degrades to tree-sitter — never a throw.
// This is the multi-language entry point: callers ask the pool for an adapter by file path.

export interface LspPoolOptions {
  /** Server registry to route against. Default: DEFAULT_LSP_SERVERS. */
  readonly servers?: readonly LspServerSpec[];
  /** Workspace root used to initialize each server session. */
  readonly rootDir: string;
  /** Forwarded to each LspAdapter. */
  readonly requestTimeoutMs?: number;
}

export class LspPool {
  private readonly servers: readonly LspServerSpec[];
  private readonly started = new Map<string, LspAdapter>();   // languageId → started adapter
  private readonly unavailable = new Set<string>();           // languageId → known-unavailable

  constructor(private readonly opts: LspPoolOptions) {
    this.servers = opts.servers ?? DEFAULT_LSP_SERVERS;
  }

  /**
   * Get a started LspAdapter for `filePath` (by extension), or null when no server handles the
   * extension or that server is unavailable on this machine. Starts the adapter on first use and
   * reuses it thereafter. Never throws for an unavailable server (degrade to tree-sitter).
   */
  async forFile(filePath: string): Promise<LspAdapter | null> {
    const spec = lspServerForExtension(extname(filePath), this.servers);
    if (spec === null || this.unavailable.has(spec.languageId)) return null;

    const existing = this.started.get(spec.languageId);
    if (existing !== undefined) return existing;

    if (!LspAdapter.isAvailable(spec)) {
      this.unavailable.add(spec.languageId);
      return null;
    }
    const adapter = new LspAdapter({ server: spec, ...(this.opts.requestTimeoutMs !== undefined ? { requestTimeoutMs: this.opts.requestTimeoutMs } : {}) });
    try {
      await adapter.start(this.opts.rootDir);
    } catch {
      this.unavailable.add(spec.languageId); // start failed — treat as unavailable, degrade
      return null;
    }
    this.started.set(spec.languageId, adapter);
    return adapter;
  }

  /** True if any registered server can handle `filePath` and is available (does not start it). */
  supports(filePath: string): boolean {
    const spec = lspServerForExtension(extname(filePath), this.servers);
    return spec !== null && !this.unavailable.has(spec.languageId) && LspAdapter.isAvailable(spec);
  }

  /** Stop every started server. Idempotent. */
  async stopAll(): Promise<void> {
    for (const adapter of this.started.values()) {
      try { await adapter.stop(); } catch { /* best-effort */ }
    }
    this.started.clear();
  }
}
