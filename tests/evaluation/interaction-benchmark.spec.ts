/*
 * Copyright 2026 DienVu (Dienvu1008)
 * SPDX-License-Identifier: Apache-2.0
 */

// codeforge-interaction dataset guard. CI-safe (no model): proves every hidden check is
// SATISFIABLE (a reference solution passes), NOT trivially satisfied (an empty seed workspace fails),
// and HIDDEN (no seed file reveals the intent). Without this, a pass/fail difference between the
// off / assume / ask arms could come from a broken check instead of from the agent.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { loadBenchmarkFile, BenchmarkCheckRunner, WorkspaceProcessSupervisor } from '@codeforge/infrastructure';

const PATH = join(__dirname, '..', '..', 'benchmarks', 'codeforge-interaction', 'benchmark.json');
const benchmark = loadBenchmarkFile(PATH);

const CSV = `function parse(text) {
  const rows = []; let row = []; let field = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') q = false;
      else field += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\\n' || ch === '\\r') {
      if (ch === '\\r' && text[i + 1] === '\\n') i++;
      row.push(field); field = ''; if (row.some((f) => f !== '')) rows.push(row); row = [];
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}
function toObjects(text) {
  const [head, ...rest] = parse(text);
  return rest.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])));
}
if (require.main === module) {
  const fs = require('fs');
  const [, , input, output] = process.argv;
  fs.writeFileSync(output, JSON.stringify(toObjects(fs.readFileSync(input, 'utf8')), null, 2));
}
module.exports = { parse, toObjects };
`;

/** Reference solutions (relative path → content) proving each hidden check is satisfiable. */
const REFERENCE: Record<string, Record<string, string>> = {
  'IV-01': { 'temp.js': 'const r1 = (x) => Math.round(x * 10) / 10;\nmodule.exports = { cToF: (c) => r1(c * 9 / 5 + 32), fToC: (f) => r1((f - 32) * 5 / 9) };\n' },
  'IV-02': { 'slug.js': "module.exports = { slugify: (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') };\n" },
  'IV-03': { 'wordcount.js': 'module.exports = { countWords(t) { const o = {}; for (const w of (t.toLowerCase().match(/[a-z]+/g) || [])) o[w] = (o[w] || 0) + 1; return o; } };\n' },
  'IV-04': { 'money.js': "module.exports = { formatCents(c) { const a = Math.abs(c); const d = String(Math.floor(a / 100)).replace(/\\B(?=(\\d{3})+(?!\\d))/g, ','); return (c < 0 ? '-' : '') + '$' + d + '.' + String(a % 100).padStart(2, '0'); } };\n" },
  'IV-05': { 'validate.js': 'module.exports = { isValidEmail: (s) => /^[^\\s@]+@[^\\s@.][^\\s@]*\\.[^\\s@]*[^\\s@.]$/.test(s) };\n' },
  'IV-06': { 'dates.js': "const d = (s) => Date.parse(s + 'T00:00:00Z');\nmodule.exports = { daysBetween: (a, b) => Math.round(Math.abs(d(b) - d(a)) / 86400000) };\n" },
  'IM-01': { 'csv2json.js': CSV },
  'IM-02': { 'cache.js': 'module.exports = { createCache({ max }) { const m = new Map(); return { get(k) { if (!m.has(k)) return undefined; const v = m.get(k); m.delete(k); m.set(k, v); return v; }, set(k, v) { m.delete(k); m.set(k, v); if (m.size > max) m.delete(m.keys().next().value); } }; } };\n' },
  'IM-03': { 'ratelimit.js': 'module.exports = { createLimiter({ limit, windowMs }) { const log = new Map(); return { allow(key, now) { const ts = (log.get(key) || []).filter((t) => t > now - windowMs); if (ts.length >= limit) { log.set(key, ts); return false; } ts.push(now); log.set(key, ts); return true; } }; } };\n' },
  'IM-04': { 'todos.js': "const fs = require('fs');\nmodule.exports = { createStore(file) { const load = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return []; } }; const save = (l) => fs.writeFileSync(file, JSON.stringify(l)); return { add(text) { const l = load(); const id = l.length + 1; l.push({ id, text, done: false }); save(l); return id; }, complete(id) { const l = load(); for (const i of l) if (i.id === id) i.done = true; save(l); }, list: () => load() }; } };\n" },
  'IM-05': { 'md2html.js': "const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');\nconst inline = (s) => esc(s).replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>').replace(/\\*(.+?)\\*/g, '<em>$1</em>').replace(/\\[([^\\]]+)\\]\\(([^)]+)\\)/g, '<a href=\"$2\">$1</a>');\nmodule.exports = { render(md) { const out = []; let list = false; for (const line of md.split('\\n')) { const h = /^(#{1,6}) (.*)$/.exec(line); const li = /^[-*] (.*)$/.exec(line); if (li) { if (!list) { out.push('<ul>'); list = true; } out.push('<li>' + inline(li[1]) + '</li>'); continue; } if (list) { out.push('</ul>'); list = false; } if (h) out.push('<h' + h[1].length + '>' + inline(h[2]) + '</h' + h[1].length + '>'); else if (line.trim()) out.push('<p>' + inline(line) + '</p>'); } if (list) out.push('</ul>'); return out.join('\\n'); } };\n" },
  'IM-06': { 'events.js': "module.exports = { createEmitter() { const m = new Map(); const api = { on(e, f) { (m.get(e) || m.set(e, []).get(e)).push(f); return api; }, off(e, f) { m.set(e, (m.get(e) || []).filter((g) => g !== f && g.orig !== f)); return api; }, once(e, f) { const w = (...a) => { api.off(e, w); f(...a); }; w.orig = f; return api.on(e, w); }, emit(e, ...a) { for (const f of [...(m.get(e) || [])]) { try { f(...a); } catch { /* isolate */ } } return api; } }; return api; } };\n" },
};

function workspace(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'cf-ix-'));
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
  return root;
}
async function runChecks(taskId: string, files: Record<string, string>) {
  const task = benchmark.tasks.find((t) => t.id === taskId)!;
  const root = workspace({ ...task.seedFiles, ...files });
  try {
    const runner = new BenchmarkCheckRunner({ supervisor: new WorkspaceProcessSupervisor({ workspaceRoot: root }), workspaceRoot: root, defaultTimeoutMs: 30000 });
    return await runner.runAll(task.verification);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

describe('codeforge-interaction dataset', () => {
  it('has 6 vague + 6 multi-approach cases, each with a simulated user, 4 held out', () => {
    const kinds = benchmark.tasks.map((t) => t.interaction);
    expect(kinds.filter((k) => k === 'vague')).toHaveLength(6);
    expect(kinds.filter((k) => k === 'multi-approach')).toHaveLength(6);
    expect(benchmark.tasks.every((t) => t.simulatedUser !== undefined)).toBe(true);
    expect(benchmark.tasks.filter((t) => t.heldOut)).toHaveLength(4);
    expect(benchmark.tasks.filter((t) => t.interaction === 'multi-approach').every((t) => (t.simulatedUser?.prefer?.length ?? 0) > 0)).toBe(true);
  });

  it('the hidden intent is never in the workspace the agent sees', () => {
    for (const t of benchmark.tasks) {
      const seen = Object.values(t.seedFiles).join('\n') + t.description;
      for (const c of t.verification) {
        // Every check is an inline `node -e` script, so nothing about it is seeded.
        expect(c.kind).toBe('command');
        expect(c.target).toBe('node');
        expect(c.args?.[0]).toBe('-e');
      }
      // Vague goals do not name the module they must create.
      if (t.interaction === 'vague') {
        const file = /([a-z0-9]+\.js)/.exec(t.simulatedUser!.intent)![1]!;
        expect(seen.includes(file), `${t.id} leaks ${file}`).toBe(false);
      }
    }
  });

  it.each(benchmark.tasks.map((t) => t.id))('%s: reference solution passes every hidden check', async (id) => {
    const outcomes = await runChecks(id, REFERENCE[id]!);
    for (const o of outcomes) expect(o.passed, `${o.description}: ${o.detail ?? ''}`).toBe(true);
  }, 60000);

  it.each(benchmark.tasks.map((t) => t.id))('%s: the untouched seed workspace fails', async (id) => {
    const outcomes = await runChecks(id, {});
    expect(outcomes.some((o) => !o.passed)).toBe(true);
  }, 60000);

  it('the no-dependencies check fails when an npm dependency is added', async () => {
    const outcomes = await runChecks('IM-01', { ...REFERENCE['IM-01'], 'package.json': '{"name":"ix","dependencies":{"csv-parse":"^5.0.0"}}' });
    expect(outcomes.find((o) => o.description.includes('no third-party'))?.passed).toBe(false);
  }, 60000);
});