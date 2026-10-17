// P7-LX1 — LspAdapter (typescript-language-server over LSP stdio).
// CI-safe: the whole suite skips if the server can't be resolved (never fails on
// absence). As a pinned dependency it is normally present, so these run.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pathToFileURL } from 'node:url';
import {
  LspAdapter, LspError, LspPool,
  TYPESCRIPT_LSP_SERVER, DEFAULT_LSP_SERVERS, lspServerForExtension,
  type LspServerSpec,
} from '@codeforge/infrastructure';

const available = LspAdapter.isAvailable();

const SOURCE =
  'export function greet(name: string): string {\n' +
  '  return "hi " + name;\n' +
  '}\n' +
  'export const used = greet("x");\n' +
  'export class Thing { run(): number { return 1; } }\n';

const URI = pathToFileURL(process.cwd() + '/_lsp_doc.ts').href;

describe('P7-LX1 LspAdapter — unit (no server needed)', () => {
  it('exposes isAvailable()', () => {
    expect(typeof LspAdapter.isAvailable()).toBe('boolean');
  });

  it('throws NOT_STARTED when querying before start()', async () => {
    const a = new LspAdapter();
    await expect(a.documentSymbol(URI, SOURCE)).rejects.toBeInstanceOf(LspError);
    await expect(a.documentSymbol(URI, SOURCE)).rejects.toMatchObject({ code: 'NOT_STARTED' });
  });

  it('stop() is a no-op when never started', async () => {
    const a = new LspAdapter();
    await expect(a.stop()).resolves.toBeUndefined();
  });

  it('default adapter announces the typescript languageId', () => {
    expect(new LspAdapter().languageId).toBe('typescript');
  });
});

// ── P12.16: server registry + pool (no server process needed) ─────────────────

describe('LSP server registry', () => {
  it('TS/JS server handles the TS/JS extensions', () => {
    expect(TYPESCRIPT_LSP_SERVER.languageId).toBe('typescript');
    for (const ext of ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']) {
      expect(TYPESCRIPT_LSP_SERVER.extensions).toContain(ext);
    }
  });

  it('lspServerForExtension routes a .ts file to the TS server, case-insensitively', () => {
    expect(lspServerForExtension('.ts')).toBe(TYPESCRIPT_LSP_SERVER);
    expect(lspServerForExtension('.TSX')).toBe(TYPESCRIPT_LSP_SERVER);
  });

  it('lspServerForExtension returns null for an unregistered extension', () => {
    expect(lspServerForExtension('.py')).toBeNull();
    expect(lspServerForExtension('.go')).toBeNull();
  });

  it('an adapter built from a custom spec announces that spec languageId', () => {
    const fakeSpec: LspServerSpec = {
      languageId: 'python',
      extensions: ['.py'],
      resolveLaunch: () => ({ command: 'pyright-langserver', args: ['--stdio'] }),
    };
    expect(new LspAdapter({ server: fakeSpec }).languageId).toBe('python');
    // A spec that resolves a (fake) launch reports available even without the TS package.
    expect(LspAdapter.isAvailable(fakeSpec)).toBe(true);
  });

  it('isAvailable(spec) is false when the spec cannot resolve its launch', () => {
    const missing: LspServerSpec = {
      languageId: 'nope',
      extensions: ['.nope'],
      resolveLaunch: () => { throw new LspError('SERVER_NOT_FOUND', 'absent'); },
    };
    expect(LspAdapter.isAvailable(missing)).toBe(false);
  });
});

describe('LspPool — routing + graceful degradation', () => {
  it('returns null for a file whose extension has no registered server', async () => {
    const pool = new LspPool({ rootDir: process.cwd() });
    expect(await pool.forFile('main.py')).toBeNull();   // no python server registered by default
    expect(pool.supports('main.py')).toBe(false);
    await pool.stopAll();
  });

  it('returns null (never throws) when the matched server is unavailable', async () => {
    const unavailable: LspServerSpec = {
      languageId: 'ghost', extensions: ['.ghost'],
      resolveLaunch: () => { throw new LspError('SERVER_NOT_FOUND', 'absent'); },
    };
    const pool = new LspPool({ rootDir: process.cwd(), servers: [unavailable] });
    expect(await pool.forFile('x.ghost')).toBeNull();
    expect(pool.supports('x.ghost')).toBe(false);
    await pool.stopAll();
  });

  it('DEFAULT_LSP_SERVERS contains exactly the TS/JS server for now', () => {
    expect(DEFAULT_LSP_SERVERS).toContain(TYPESCRIPT_LSP_SERVER);
    expect(DEFAULT_LSP_SERVERS.length).toBe(1);
  });
});

describe.skipIf(!available)('P7-LX1 LspAdapter — live server (skipped if absent)', () => {
  let adapter: LspAdapter;

  beforeAll(async () => {
    adapter = new LspAdapter({ requestTimeoutMs: 20000 });
    await adapter.start(process.cwd());
  }, 30000);

  afterAll(async () => {
    await adapter.stop();
  });

  it('documentSymbol returns the top-level symbols', async () => {
    const syms = await adapter.documentSymbol(URI, SOURCE);
    const names = syms.map((s) => s.name);
    expect(names).toContain('greet');
    expect(names).toContain('Thing');
    // Each symbol has a well-formed range.
    for (const s of syms) {
      expect(s.range.start.line).toBeGreaterThanOrEqual(0);
      expect(typeof s.kind).toBe('number');
    }
  }, 30000);

  it('definition returns a well-formed location for a symbol usage', async () => {
    // Exact token-column mapping varies by TS version, so we assert the shape of
    // the response (a valid Location) rather than a specific line — the contract
    // under test is that definition() round-trips LSP and returns plain data.
    const locs = await adapter.definition(URI, SOURCE, { line: 3, character: 13 });
    expect(Array.isArray(locs)).toBe(true);
    for (const l of locs) {
      expect(typeof l.uri).toBe('string');
      expect(l.range.start.line).toBeGreaterThanOrEqual(0);
      expect(l.range.end.line).toBeGreaterThanOrEqual(l.range.start.line);
    }
  }, 30000);

  it('references finds usages of a declaration', async () => {
    // "greet" declaration is on line 0, col ~16.
    const locs = await adapter.references(URI, SOURCE, { line: 0, character: 16 });
    expect(Array.isArray(locs)).toBe(true);
    expect(locs.length).toBeGreaterThanOrEqual(1); // at least the declaration/usage
  }, 30000);

  it('start() is idempotent (reuses the session)', async () => {
    await expect(adapter.start(process.cwd())).resolves.toBeUndefined();
    const syms = await adapter.documentSymbol(URI, SOURCE);
    expect(syms.length).toBeGreaterThan(0);
  }, 30000);

  it('LspPool.forFile routes a .ts file to a started TS adapter', async () => {
    const pool = new LspPool({ rootDir: process.cwd(), requestTimeoutMs: 20000 });
    try {
      expect(pool.supports('src/foo.ts')).toBe(true);
      const a = await pool.forFile('src/foo.ts');
      expect(a).not.toBeNull();
      expect(a!.languageId).toBe('typescript');
      // Reuses the same adapter instance for another TS file.
      expect(await pool.forFile('src/bar.tsx')).toBe(a);
    } finally {
      await pool.stopAll();
    }
  }, 40000);
});
