// Benchmark quality gate: prove every progressive task is SOLVABLE and its hidden checks are
// correct, by applying a hand-written GOLDEN solution and running the real check runner. If a
// golden solution does not pass the task's checks, the task (or its checks) is broken — a
// benchmark you cannot pass with a correct answer is worthless. This never runs the agent; it
// validates the dataset itself.
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { loadBenchmarkFile, BenchmarkCheckRunner, WorkspaceProcessSupervisor } from '../packages/infrastructure/dist/index.js';

// Golden solutions keyed by task id: a map of file path → full content the agent SHOULD produce.
const GOLDEN = {
  'PG-01': { 'src/math.js': "function sumToN(n) {\n  let total = 0;\n  for (let i = 1; i <= n; i++) total += i;\n  return total;\n}\nmodule.exports = { sumToN };\n" },
  'PG-02': { 'src/num.js': "function isPositive(n) { return n > 0; }\nfunction clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }\nmodule.exports = { isPositive, clamp };\n" },
  'PG-03': {
    'src/order.js': "function computeTotal(items) {\n  return items.reduce((a, b) => a + b, 0);\n}\nmodule.exports = { computeTotal };\n",
    'src/index.js': "const { computeTotal } = require('./order.js');\nmodule.exports = { total: (xs) => computeTotal(xs) };\n",
  },
  'PG-04': { 'src/config.js': "function parseConfig(raw) {\n  if (raw.trim().length === 0) return {};\n  return JSON.parse(raw);\n}\nmodule.exports = { parseConfig };\n" },
  'PG-05': {
    'src/pricing.js': "function tax(price) { return price * 0.1; }\nfunction discount(price, pct) { return price - price * (pct / 100); }\nmodule.exports = { tax, discount };\n",
    'src/checkout.js': "const { tax, discount } = require('./pricing.js');\nfunction checkoutTotal(price, pct) {\n  const d = discount(price, pct);\n  return d + tax(d);\n}\nmodule.exports = { checkoutTotal };\n",
  },
  'PG-06': {
    'src/sum-core.js': "function sum(xs) { return xs.reduce((a, b) => a + b, 0); }\nmodule.exports = { sum };\n",
    'src/math.js': "const { sum } = require('./sum-core.js');\nfunction sumToN(n) {\n  const xs = [];\n  for (let i = 1; i <= n; i++) xs.push(i);\n  return sum(xs);\n}\nmodule.exports = { sumToN };\n",
  },
  'PG-07': {
    'src/config.js': "const BASE_URL = 'http://localhost:3000';\nmodule.exports = { BASE_URL };\n",
    'src/a.js': "const { BASE_URL } = require('./config.js');\nmodule.exports = { aUrl: () => BASE_URL + '/a' };\n",
    'src/b.js': "const { BASE_URL } = require('./config.js');\nmodule.exports = { bUrl: () => BASE_URL + '/b' };\n",
  },
  'PG-08': {
    'src/user.js': "function getUser(id) { return { id, name: 'u' + id }; }\nmodule.exports = { getUser };\n",
    'src/profile.js': "const { getUser } = require('./user.js');\nmodule.exports = { profileName: (id) => getUser(id).name };\n",
    'src/admin.js': "const { getUser } = require('./user.js');\nmodule.exports = { adminId: (id) => getUser(id).id };\n",
  },
  'PG-09': {
    'src/domain.js': "function add(a, b) { return a + b; }\nmodule.exports = { add };\n",
    'src/app.js': "const { add } = require('./domain.js');\nfunction handle(req) { return { body: String(add(req.a, req.b)) }; }\nmodule.exports = { handle };\n",
  },
  'PG-10': { 'src/adders.js': "function makeAdders(n) {\n  const fns = [];\n  for (let i = 0; i < n; i++) {\n    fns.push((x) => x + i);\n  }\n  return fns;\n}\nmodule.exports = { makeAdders };\n" },
  'PG-11': {
    'src/queue.js': "class Queue {\n  constructor() { this.tasks = []; }\n  add(fn) { this.tasks.push(fn); }\n  async process() {\n    const out = [];\n    for (const fn of this.tasks) out.push(await fn());\n    return out;\n  }\n}\nmodule.exports = { Queue };\n",
  },
  'PG-12': {
    'src/validate.js': "function isValidEmail(s) {\n  const parts = String(s).split('@');\n  return parts.length === 2 && parts[0].length > 0 && parts[1].length > 0;\n}\nmodule.exports = { isValidEmail };\n",
    'src/signup.js': "const { isValidEmail } = require('./validate.js');\nfunction createUser(email) { return { email }; }\nfunction signup(email) { return isValidEmail(email) ? { ok: true, email } : { ok: false }; }\nmodule.exports = { createUser, signup };\n",
  },
};

const benchmark = loadBenchmarkFile('benchmarks/codeforge-progressive/benchmark.json');
let allPass = true;

for (const task of benchmark.tasks) {
  const dir = mkdtempSync(join(tmpdir(), `cf-golden-${task.id}-`));
  try {
    // Seed, then overlay the golden solution.
    const write = (rel, content) => { const abs = join(dir, rel); mkdirSync(dirname(abs), { recursive: true }); writeFileSync(abs, content); };
    for (const [p, c] of Object.entries(task.seedFiles)) write(p, c);
    const golden = GOLDEN[task.id] ?? {};
    for (const [p, c] of Object.entries(golden)) write(p, c);

    const runner = new BenchmarkCheckRunner({ supervisor: new WorkspaceProcessSupervisor({ workspaceRoot: dir }), workspaceRoot: dir });
    const outcomes = await runner.runAll(task.verification);
    const passed = outcomes.every((o) => o.passed);
    if (!passed) {
      allPass = false;
      const failed = outcomes.filter((o) => !o.passed).map((o) => `${o.description} [${o.detail}]`);
      console.log(`FAIL ${task.id}: ${failed.join(' | ')}`);
    } else {
      console.log(`PASS ${task.id} (${task.difficulty})`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
console.log(allPass ? '\nGOLDEN OK — every task is solvable and its checks are correct.' : '\nGOLDEN FAILURES — fix the dataset.');
process.exit(allPass ? 0 : 1);
