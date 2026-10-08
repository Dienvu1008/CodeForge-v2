// bundle-cli.mjs — "Hướng 1" packaging: bundle the CodeForge runtime CLI into a single
// distributable JS file with a `bin` entry, so it can be installed with `npm i -g` / run with
// `npx` on another machine. Native/asset dependencies (better-sqlite3 native binding,
// tree-sitter WASM, the TS language server) CANNOT be inlined, so they are marked EXTERNAL and
// declared as runtime deps in the generated dist/package.json — `npm install` fetches them.
//
// Run: node scripts/bundle-cli.mjs   (after `npm run build`)
// Output: dist-cli/{codeforge.mjs, package.json, README.md}
import { build } from 'esbuild';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'dist-cli');
const entry = join(root, 'packages', 'infrastructure', 'dist', 'cli', 'runtime-cli.js');

// Native + asset packages that must NOT be bundled (shipped as runtime deps instead).
const EXTERNAL = ['better-sqlite3', 'tree-sitter-wasms', 'web-tree-sitter', 'typescript-language-server'];

// Pin external versions from the infrastructure package so the dist manifest is reproducible.
const infraPkg = JSON.parse(readFileSync(join(root, 'packages', 'infrastructure', 'package.json'), 'utf8'));
const rootPkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const pickDep = (name) => infraPkg.dependencies?.[name] ?? rootPkg.dependencies?.[name] ?? '*';

mkdirSync(outDir, { recursive: true });

await build({
  entryPoints: [entry],
  outfile: join(outDir, 'codeforge.cjs'),
  bundle: true,
  platform: 'node',
  // CommonJS: node tolerates the shebang when the file is passed to `node file.cjs` AND when
  // run via the npm-generated bin launcher. (An ESM .mjs with a shebang fails `node file.mjs`.)
  format: 'cjs',
  target: 'node20',
  external: EXTERNAL,
  logLevel: 'info',
});

// Prepend the shebang as the VERY FIRST bytes of the file (node only strips a shebang at byte 0;
// esbuild's `banner` can land it on line 2). Needed for `./codeforge.cjs` direct execution on
// Unix and the npm bin launcher; harmless for `node codeforge.cjs`.
const outFile = join(outDir, 'codeforge.cjs');
const bundled = readFileSync(outFile, 'utf8');
if (!bundled.startsWith('#!')) writeFileSync(outFile, `#!/usr/bin/env node\n${bundled}`, 'utf8');

// A self-contained manifest: one bin, only the un-bundleable deps.
const distPkg = {
  name: 'codeforge-runtime',
  version: '0.12.0',
  description: 'CodeForge autonomous software-engineering runtime (bundled CLI).',
  bin: { codeforge: './codeforge.cjs' },
  engines: { node: '>=20' },
  dependencies: Object.fromEntries(EXTERNAL.map((n) => [n, pickDep(n)])),
};
writeFileSync(join(outDir, 'package.json'), JSON.stringify(distPkg, null, 2) + '\n', 'utf8');

writeFileSync(join(outDir, 'README.md'),
  '# CodeForge runtime (bundled)\n\n' +
  'Install on another machine:\n\n' +
  '```\n' +
  'cd dist-cli\n' +
  'npm install            # fetches the native deps (better-sqlite3, tree-sitter, TS LSP)\n' +
  'npm install -g .       # optional: expose the `codeforge` command globally\n' +
  '```\n\n' +
  'Run:\n\n' +
  '```\n' +
  'codeforge --workspace /path/to/project --goal "Add a hello function" --model qwen2.5-coder\n' +
  '# then open the dashboard it prints, e.g. http://localhost:9500/\n' +
  '```\n\n' +
  'Requires Node >= 20 and a running Ollama (default http://localhost:11434).\n',
  'utf8');

console.log(`Bundled CLI → ${outDir}/codeforge.cjs (+ package.json, README.md)`);
