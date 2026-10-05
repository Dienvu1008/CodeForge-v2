// P6-TS1/SX1 — TreeSitterAdapter + SymbolExtractor.
// Verifies cross-platform WASM parsing + symbol extraction on real source.
import { describe, it, expect, beforeAll } from "vitest";
import { TreeSitterAdapter, SymbolExtractor, TreeSitterError } from "@codeforge/infrastructure";

const TS_SOURCE = [
  "",
  "export function greet(name: string): string {",
  "  return 'hello ' + name;",
  "}",
  "",
  "export class Greeter {",
  "  private prefix: string;",
  "  constructor(prefix: string) { this.prefix = prefix; }",
  "  greet(name: string): string { return this.prefix + name; }",
  "}",
  "",
  "interface Config {",
  "  readonly timeout: number;",
  "}",
  "",
  "type Alias = string | number;",
  "",
  "enum Color { Red, Green, Blue }",
  "",
  "const helper = (x: number): number => x * 2;",
  "",
].join("\n");

// Single shared adapter — web-tree-sitter uses a global WASM runtime, so parallel
// adapter instances parsing concurrently can race on shared state. One adapter,
// initialized once, keeps the tests deterministic.
let adapter: TreeSitterAdapter;
let extractor: SymbolExtractor;

beforeAll(async () => {
  adapter = new TreeSitterAdapter();
  await adapter.initialize();
  extractor = new SymbolExtractor(adapter);
});

describe("P6-TS1 TreeSitterAdapter", () => {
  it("lists supported languages", () => {
    const langs = adapter.supportedLanguages();
    expect(langs).toContain("typescript");
    expect(langs).toContain("javascript");
    expect(langs).toContain("dart");
    expect(langs).toContain("python");
  });

  it("parses a TypeScript file and returns a syntax tree", async () => {
    const tree = await adapter.parse("greet.ts", TS_SOURCE, "typescript");
    expect(tree.language).toBe("typescript");
    expect(tree.root.type).toBe("program");
    expect(tree.root.namedChildren.length).toBeGreaterThan(0);
  });

  it("caches parse results by content hash (same tree reference)", async () => {
    const t1 = await adapter.parse("cached.ts", TS_SOURCE, "typescript");
    const t2 = await adapter.parse("cached.ts", TS_SOURCE, "typescript");
    expect(t1).toBe(t2);
  });

  it("re-parses after invalidate()", async () => {
    const t1 = await adapter.parse("inv.ts", TS_SOURCE, "typescript");
    adapter.invalidate("inv.ts");
    const t2 = await adapter.parse("inv.ts", TS_SOURCE, "typescript");
    expect(t1).not.toBe(t2);
  });

  it("throws UNSUPPORTED_LANGUAGE for unknown language", async () => {
    await expect(adapter.parse("x.rs", "fn main() {}", "rust"))
      .rejects.toMatchObject({ code: "UNSUPPORTED_LANGUAGE" });
  });

  it("parses JavaScript source", async () => {
    const tree = await adapter.parse("a.js", "function f() { return 1; }", "javascript");
    expect(tree.root.type).toBe("program");
  });

  it("parses Python source", async () => {
    const tree = await adapter.parse("a.py", "def f():\n  return 1\n", "python");
    expect(tree.root.type).toBe("module");
  });

  it("NOT_INITIALIZED error when parse() called before initialize()", async () => {
    const fresh = new TreeSitterAdapter();
    await expect(fresh.parse("x.ts", "const x = 1;", "typescript"))
      .rejects.toMatchObject({ code: "NOT_INITIALIZED" });
  });

  it("TreeSitterError carries a code", () => {
    const e = new TreeSitterError("PARSE_FAILED", "boom");
    expect(e.code).toBe("PARSE_FAILED");
    expect(e.name).toBe("TreeSitterError");
  });
});

describe("P6-SX1 SymbolExtractor", () => {
  it("extracts the top-level function", async () => {
    const syms = await extractor.extract(TS_SOURCE, "typescript");
    expect(syms.map((s) => s.name)).toContain("greet");
  });

  it("extracts the class", async () => {
    const syms = await extractor.extract(TS_SOURCE, "typescript");
    const greeter = syms.find((s) => s.name === "Greeter");
    expect(greeter).toBeDefined();
    expect(greeter?.kind).toBe("class");
  });

  it("extracts the interface", async () => {
    const syms = await extractor.extract(TS_SOURCE, "typescript");
    expect(syms.map((s) => s.name)).toContain("Config");
  });

  it("extracts the type alias", async () => {
    const syms = await extractor.extract(TS_SOURCE, "typescript");
    expect(syms.map((s) => s.name)).toContain("Alias");
  });

  it("extracts the enum", async () => {
    const syms = await extractor.extract(TS_SOURCE, "typescript");
    expect(syms.map((s) => s.name)).toContain("Color");
  });

  it("extracts arrow-function const binding", async () => {
    const syms = await extractor.extract(TS_SOURCE, "typescript");
    expect(syms.map((s) => s.name)).toContain("helper");
  });

  it("marks exported symbols as exported", async () => {
    const syms = await extractor.extract(TS_SOURCE, "typescript");
    const greet = syms.find((s) => s.name === "greet");
    expect(greet?.exported).toBe(true);
  });

  it("reports start/end lines", async () => {
    const syms = await extractor.extract(TS_SOURCE, "typescript");
    const greet = syms.find((s) => s.name === "greet");
    expect(greet?.startLine).toBeGreaterThanOrEqual(0);
    expect(greet?.endLine).toBeGreaterThanOrEqual(greet!.startLine);
  });

  it("returns empty array for unsupported language (graceful degradation)", async () => {
    const syms = await extractor.extract("fn main() {}", "rust");
    expect(syms).toEqual([]);
  });

  it("extracts python function and class", async () => {
    const py = "def my_func():\n  pass\n\nclass MyClass:\n  pass\n";
    const syms = await extractor.extract(py, "python");
    const names = syms.map((s) => s.name);
    expect(names).toContain("my_func");
    expect(names).toContain("MyClass");
  });
});
