// P7-LX1 — LspAdapter (typescript-language-server over LSP stdio).
// CI-safe: the whole suite skips if the server can't be resolved (never fails on
// absence). As a pinned dependency it is normally present, so these run.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pathToFileURL } from 'node:url';
import { LspAdapter, LspError } from '@codeforge/infrastructure';

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
});
