/*
 * Copyright 2026 DienVu (Dienvu1008)
 * SPDX-License-Identifier: Apache-2.0
 */

// Synthetic traces (kernel-shadow-ablation, design "Testing Strategy"; Requirements 11.1, 11.3).
// Measurement-only (SA-001).
//
// Five scripted sessions SYN-01..SYN-05, each modeled on a progressive benchmark case
// (`benchmarks/codeforge-progressive/benchmark.json`): seed files with a `package.json` whose
// `test` script makes the project-derived verification policy run a real check (`npm test`, so
// EP-COMPLETION never blocks on NO_CHECKS_EXECUTED), a FakeModel response sequence (plan JSON in
// the shape of `tests/integration/autonomous-e2e.spec.ts`, then executor proposals), and scripted
// FakeProcessSupervisor outcomes (no process is ever spawned).
//
// `synthesizeTraces()` records each script by running it through the ENFORCE arm wiring
// (`runArm` with `ArmConfig.modelGateway`) with a RecordingModelGateway around the scripted
// FakeModel, so the recorded purposes and their order are exactly what the Kernel asks for and an
// uninjected enforce replay serves every entry with no mismatch (wiring parity).
//
// Deterministic: FakeModel and FakeProcessSupervisor have no clock or randomness, and the arm
// wiring uses counters for every clock/id.
import {
  ModelError,
  type AutonomyLevel,
  type ModelIdentity,
  type ModelPurpose,
  type ModelRequest,
  type ModelResponse,
} from '@codeforge/agent-core';
import { FakeModel } from '../fake-model/index.js';
import { FakeProcessSupervisor, type FakeSpawnOutcome } from '../process/index.js';
import type { ApprovalResolution } from './ablation-tool-gateway.js';
import { runArm, type ArmModelGateway, type ArmResult, type ArmSupervisorFactory } from './arm.js';
import type { DecisionLedger } from './decision-ledger.js';
import { RecordingModelGateway } from './recording-model-gateway.js';
import type { ReplayStatus, ServedStep } from './replay-model-gateway.js';
import { TRACE_FORMAT_VERSION, type ModelTraceV1, type TraceSource, type TraceWiring } from './trace-format.js';

// ── Script type ─────────────────────────────────────────────────────────────────────────────

/** A scripted subprocess outcome: the first rule whose `command` regex matches wins. */
export interface SyntheticProcessRule {
  /** Tested against the spawned command name only (FakeProcessSupervisor semantics). */
  readonly command: RegExp;
  readonly outcome: FakeSpawnOutcome;
}

export interface SyntheticScript {
  /** `SYN-01` .. `SYN-05`; the trace id is `synthetic:<id>`. */
  readonly id: string;
  /** Progressive case the script is modeled on. */
  readonly modeledOn: string;
  /** Goal description (also the seeded task text). */
  readonly description: string;
  /** Mandatory acceptance criterion text (Progressive_Runner: `'done'` for non-interaction cases). */
  readonly acceptance: string;
  readonly seedFiles: Readonly<Record<string, string>>;
  /** FakeModel responses, consumed exactly in order: plan JSON first, then executor proposals. */
  readonly responses: readonly string[];
  /** Scripted outcomes for every supervisor of the arm (shell, verification, checks). */
  readonly processRules: readonly SyntheticProcessRule[];
  readonly autonomy: AutonomyLevel;
  readonly maxToolCalls: number;
  /** `wiring.recovery` label. */
  readonly recovery: string;
  /** Enforce-arm model of the absent human; replay arms on this trace must use the same value. */
  readonly approvalResolution: ApprovalResolution;
}

// ── Helpers for the scripts ─────────────────────────────────────────────────────────────────

function planJson(description: string, strategy: string, reason: string): string {
  return JSON.stringify({ tasks: [{ id: 'T1', description, strategy }], edges: [], reason });
}

function toolCall(toolName: string, args: Readonly<Record<string, unknown>>, reasoning: string): string {
  return JSON.stringify({ type: 'tool_call', toolName, arguments: args, reasoning });
}

function done(summary: string): string {
  return JSON.stringify({ type: 'done', summary });
}

const PACKAGE_JSON = '{"name":"pg","private":true,"scripts":{"test":"node test.js"}}\n';

/** `node …` (run_command) and `npm test` (verification) both succeed. */
const GREEN: readonly SyntheticProcessRule[] = Object.freeze([
  { command: /^node$/, outcome: { exitCode: 0, stdout: 'ok\n', stderr: '' } },
  { command: /^npm/, outcome: { exitCode: 0, stdout: 'ok\n', stderr: '' } },
]);

// ── SYN-01: create a new module (write_file → run_command `node test.js` → done) ───────────

const SYN01_DESCRIPTION =
  "Add src/validate.js exporting isValidEmail(s) that returns true when s contains exactly one '@' with non-empty parts on both sides. Run the tests.";
const SYN01_VALIDATE =
  "function isValidEmail(s) {\n  const parts = String(s).split('@');\n  return parts.length === 2 && parts[0].length > 0 && parts[1].length > 0;\n}\nmodule.exports = { isValidEmail };\n";

const SYN_01: SyntheticScript = {
  id: 'SYN-01',
  modeledOn: 'PG-12',
  description: SYN01_DESCRIPTION,
  acceptance: 'done',
  seedFiles: {
    'package.json': PACKAGE_JSON,
    'test.js':
      "const assert = require('node:assert');\nconst { isValidEmail } = require('./src/validate.js');\nassert.strictEqual(isValidEmail('a@b.c'), true);\nassert.strictEqual(isValidEmail('a@@b'), false);\nassert.strictEqual(isValidEmail('@b'), false);\nconsole.log('ok');\n",
  },
  responses: [
    planJson('Create src/validate.js exporting isValidEmail(s)', 'generate', 'single new module'),
    toolCall('write_file', { path: 'src/validate.js', content: SYN01_VALIDATE }, 'create the validator module'),
    toolCall('run_command', { command: 'node', args: ['test.js'] }, 'run the tests'),
    done('Created src/validate.js with isValidEmail; node test.js prints ok.'),
  ],
  processRules: GREEN,
  autonomy: 'full',
  maxToolCalls: 12,
  recovery: 'full',
  approvalResolution: 'none',
};

// ── SYN-02: one-line bug fix (read_file → edit_file → done) ─────────────────────────────────

const SYN_02: SyntheticScript = {
  id: 'SYN-02',
  modeledOn: 'PG-01',
  description: 'sumToN(n) in src/math.js should return 1+2+...+n but stops one short. Fix it.',
  acceptance: 'done',
  seedFiles: {
    'package.json': PACKAGE_JSON,
    'src/math.js':
      'function sumToN(n) {\n  let total = 0;\n  for (let i = 1; i < n; i++) total += i;\n  return total;\n}\nmodule.exports = { sumToN };\n',
    'test.js':
      "const assert = require('node:assert');\nconst { sumToN } = require('./src/math.js');\nassert.strictEqual(sumToN(5), 15);\nassert.strictEqual(sumToN(1), 1);\nassert.strictEqual(sumToN(0), 0);\nconsole.log('ok');\n",
  },
  responses: [
    planJson('Fix the off-by-one loop bound of sumToN in src/math.js', 'fix', 'one-line fix'),
    toolCall('read_file', { path: 'src/math.js' }, 'inspect the loop'),
    toolCall('edit_file', { path: 'src/math.js', oldString: 'i < n', newString: 'i <= n' }, 'include n in the sum'),
    done('sumToN now includes n (loop bound i <= n).'),
  ],
  processRules: GREEN,
  autonomy: 'full',
  maxToolCalls: 12,
  recovery: 'full',
  approvalResolution: 'none',
};

// ── SYN-03: multi-file change (write_file × 2 → done) ───────────────────────────────────────

const SYN_03: SyntheticScript = {
  id: 'SYN-03',
  modeledOn: 'PG-05',
  description:
    'Add discount(price, pct) to src/pricing.js and use it in src/checkout.js so checkoutTotal(items, pct) applies the discount to the sum.',
  acceptance: 'done',
  seedFiles: {
    'package.json': PACKAGE_JSON,
    'src/pricing.js': 'function round2(n) { return Math.round(n * 100) / 100; }\nmodule.exports = { round2 };\n',
    'src/checkout.js':
      'function checkoutTotal(items) {\n  return items.reduce((a, b) => a + b, 0);\n}\nmodule.exports = { checkoutTotal };\n',
    'test.js':
      "const assert = require('node:assert');\nconst { discount } = require('./src/pricing.js');\nconst { checkoutTotal } = require('./src/checkout.js');\nassert.strictEqual(discount(100, 10), 90);\nassert.strictEqual(checkoutTotal([50, 50], 20), 80);\nconsole.log('ok');\n",
  },
  responses: [
    planJson('Add discount to src/pricing.js and apply it in src/checkout.js', 'generate', 'two-file feature'),
    toolCall(
      'write_file',
      {
        path: 'src/pricing.js',
        content:
          'function round2(n) { return Math.round(n * 100) / 100; }\nfunction discount(price, pct) { return round2(price * (1 - pct / 100)); }\nmodule.exports = { round2, discount };\n',
      },
      'add discount',
    ),
    toolCall(
      'write_file',
      {
        path: 'src/checkout.js',
        content:
          "const { discount } = require('./pricing.js');\nfunction checkoutTotal(items, pct = 0) {\n  return discount(items.reduce((a, b) => a + b, 0), pct);\n}\nmodule.exports = { checkoutTotal };\n",
      },
      'use discount in checkoutTotal',
    ),
    done('discount added to src/pricing.js and applied in src/checkout.js.'),
  ],
  processRules: GREEN,
  autonomy: 'full',
  maxToolCalls: 12,
  recovery: 'full',
  approvalResolution: 'none',
};

// ── SYN-04: organic delete of a stale file (delete_file → done) ─────────────────────────────
// delete_file is DESTRUCTIVE: the Kernel asks a human (TG-007) under every autonomy level. The
// enforce arm models a human who denies (`approvalResolution: 'deny'`), so the run continues and
// the model's next proposals are recorded (a `done`, challenged once by P12.11 because the denied
// delete changed nothing, then a second `done`); the shadow arm approves, records an organic
// would-block, and serves the `done`s as counterfactual steps after it.

const SYN_04: SyntheticScript = {
  id: 'SYN-04',
  modeledOn: 'PG-DEP1',
  description:
    'src/legacy.js is a stale copy of src/util.js that nothing requires any more. Delete src/legacy.js; keep src/util.js unchanged.',
  acceptance: 'done',
  seedFiles: {
    'package.json': PACKAGE_JSON,
    'src/util.js': 'function twice(n) { return n * 2; }\nmodule.exports = { twice };\n',
    'src/legacy.js': 'function twice(n) { return n + n; }\nmodule.exports = { twice };\n',
    'test.js':
      "const assert = require('node:assert');\nconst { twice } = require('./src/util.js');\nassert.strictEqual(twice(4), 8);\nconsole.log('ok');\n",
  },
  responses: [
    planJson('Delete the stale file src/legacy.js', 'refactor', 'remove dead code'),
    toolCall('delete_file', { path: 'src/legacy.js' }, 'remove the stale copy'),
    done('Deleted src/legacy.js.'),
    // Enforce: the denied delete left no mutation, so P12.11 challenges the first done once and
    // P12.13 (the task names src/legacy.js, never touched) challenges the second once.
    done('The delete was not approved; src/legacy.js is unused and can be removed by hand.'),
    done('src/legacy.js could not be deleted without approval; nothing else to change.'),
  ],
  processRules: GREEN,
  autonomy: 'full',
  maxToolCalls: 12,
  recovery: 'full',
  approvalResolution: 'deny',
};

// ── SYN-05: `edits` autonomy (run_command → require_approval) ───────────────────────────────
// Under `edits` a shell command needs approval; with no human (`approvalResolution: 'none'`, the
// Progressive_Runner wiring) the enforce run ends on APPROVAL_PENDING.

const SYN_05: SyntheticScript = {
  id: 'SYN-05',
  modeledOn: 'PG-04',
  description:
    'Running `node run.js` throws because parseConfig returns undefined for empty input. Make parseConfig return an empty object for empty/whitespace input so run.js prints the port.',
  acceptance: 'done',
  seedFiles: {
    'package.json': PACKAGE_JSON,
    'src/config.js':
      'function parseConfig(raw) {\n  if (raw.trim().length === 0) return undefined;\n  return JSON.parse(raw);\n}\nmodule.exports = { parseConfig };\n',
    'run.js':
      "const { parseConfig } = require('./src/config.js');\nconst cfg = parseConfig('');\nconsole.log('port=' + (cfg.port || 3000));\n",
    'test.js':
      "const assert = require('node:assert');\nconst { parseConfig } = require('./src/config.js');\nassert.deepStrictEqual(parseConfig('   '), {});\nassert.deepStrictEqual(parseConfig('{\"port\":8080}'), { port: 8080 });\nconsole.log('ok');\n",
  },
  responses: [
    planJson('Make parseConfig in src/config.js return {} for empty input', 'fix', 'reproduce then fix'),
    toolCall('run_command', { command: 'node', args: ['run.js'] }, 'reproduce the crash'),
  ],
  processRules: Object.freeze([
    {
      command: /^node$/,
      outcome: { exitCode: 1, stdout: '', stderr: "TypeError: Cannot read properties of undefined (reading 'port')\n" },
    },
    { command: /^npm/, outcome: { exitCode: 0, stdout: 'ok\n', stderr: '' } },
  ]),
  autonomy: 'edits',
  maxToolCalls: 12,
  recovery: 'full',
  approvalResolution: 'none',
};

/** SYN-01..SYN-05, in id order. Deep-frozen. */
export const SYNTHETIC_SCRIPTS: readonly SyntheticScript[] = Object.freeze(
  [SYN_01, SYN_02, SYN_03, SYN_04, SYN_05].map((s) =>
    Object.freeze({
      ...s,
      seedFiles: Object.freeze({ ...s.seedFiles }),
      responses: Object.freeze([...s.responses]),
      processRules: Object.freeze(s.processRules.map((r) => Object.freeze({ ...r, outcome: Object.freeze({ ...r.outcome }) }))),
    }),
  ),
);

// ── Supervisors / header ────────────────────────────────────────────────────────────────────

function scriptedSupervisor(rules: readonly SyntheticProcessRule[]): FakeProcessSupervisor {
  const s = new FakeProcessSupervisor();
  for (const r of rules) s.setOutcome(r.command, r.outcome);
  return s;
}

/**
 * The script's `ArmSupervisorFactory`: fresh scripted FakeProcessSupervisors per arm (shell,
 * verification and benchmark checks each get their own, with the same rules).
 */
export function syntheticSupervisorFactory(script: SyntheticScript): ArmSupervisorFactory {
  return () => ({
    shell: scriptedSupervisor(script.processRules),
    verification: scriptedSupervisor(script.processRules),
    checks: scriptedSupervisor(script.processRules),
  });
}

/** `synthetic:<scriptId>`. */
export function syntheticTraceId(script: SyntheticScript): string {
  return `synthetic:${script.id}`;
}

function scriptWiring(script: SyntheticScript): TraceWiring {
  return {
    autonomy: script.autonomy,
    maxToolCalls: script.maxToolCalls,
    recovery: script.recovery,
    interaction: 'off',
    lsp: false,
  };
}

function scriptSource(script: SyntheticScript, model: ModelIdentity): TraceSource {
  return { kind: 'synthetic', caseId: script.id, model };
}

// ── Recording gateway for the arm ───────────────────────────────────────────────────────────

/**
 * ArmModelGateway used only while recording: forwards to the RecordingModelGateway, advances the
 * ledger step before each execute-purpose response (same step numbering as ReplayModelGateway:
 * the index of the served call across all purposes) and reports a ReplayStatus-shaped summary.
 */
class SyntheticRecordingGateway implements ArmModelGateway {
  private readonly steps: ServedStep[] = [];

  constructor(
    private readonly recorder: RecordingModelGateway,
    private readonly ledger: DecisionLedger,
  ) {}

  get identity(): ModelIdentity {
    return this.recorder.identity;
  }

  async generate(request: ModelRequest): Promise<ModelResponse> {
    const response = await this.recorder.generate(request);
    const servedIndex = this.steps.length;
    this.steps.push(Object.freeze({ servedIndex, source: 'organic', seq: servedIndex, purpose: request.purpose }));
    if (request.purpose === 'execute') this.ledger.setStep(servedIndex, 'organic');
    return response;
  }

  status(): ReplayStatus {
    return { served: this.steps.length, total: this.steps.length, exhausted: false, drift: [], steps: [...this.steps] };
  }
}

/** Thrown when a script's model sequence does not match what the Kernel asked for. */
export class SyntheticScriptError extends Error {
  constructor(
    readonly scriptId: string,
    message: string,
  ) {
    super(`${scriptId}: ${message}`);
    this.name = 'SyntheticScriptError';
  }
}

/** FakeModel that refuses to answer past the end of its scripted sequence. */
class ScriptedModel extends FakeModel {
  /** Purposes of the requests that arrived after the script ran out. */
  readonly overrun: ModelPurpose[] = [];

  constructor(private readonly scriptLength: number) {
    super();
  }

  override async generate(request: ModelRequest): Promise<ModelResponse> {
    if (this.callCount >= this.scriptLength) {
      this.overrun.push(request.purpose);
      throw new ModelError('MODEL_UNAVAILABLE', `synthetic script exhausted (purpose ${request.purpose})`);
    }
    return super.generate(request);
  }
}

// ── Synthesis ───────────────────────────────────────────────────────────────────────────────

export interface SyntheticTrace {
  readonly script: SyntheticScript;
  readonly trace: ModelTraceV1;
  /** The enforce arm run the trace was recorded from. */
  readonly recording: ArmResult;
}

/**
 * Record ONE script through the enforce arm wiring. Throws {@link SyntheticScriptError} unless the
 * Kernel consumed exactly the scripted responses (no unused response, no request past the end).
 */
export async function synthesizeTrace(script: SyntheticScript): Promise<SyntheticTrace> {
  const model = new ScriptedModel(script.responses.length);
  model.setSequence(script.responses);
  const traceId = syntheticTraceId(script);
  const wiring = scriptWiring(script);
  const source = scriptSource(script, model.identity);
  const recorder = new RecordingModelGateway(model, { source, wiring, traceId });
  // Header only: with `modelGateway` set, runArm takes wiring / identity / traceId from it.
  const header: ModelTraceV1 = {
    formatVersion: TRACE_FORMAT_VERSION,
    traceId,
    source,
    wiring,
    redaction: { applied: true, redactedEntries: 0 },
    concurrent: false,
    entries: [],
  };
  const recording = await runArm({
    mode: 'enforce',
    trace: header,
    seedFiles: script.seedFiles,
    goalDescription: script.description,
    acceptance: script.acceptance,
    supervisorFactory: syntheticSupervisorFactory(script),
    approvalResolution: script.approvalResolution,
    modelGateway: (ledger) => new SyntheticRecordingGateway(recorder, ledger),
  });
  if (recording.harnessError !== undefined) {
    throw new SyntheticScriptError(script.id, `recording run failed: ${recording.harnessError.message}`);
  }
  if (model.overrun.length > 0 || model.callCount !== script.responses.length) {
    const purposes = model.history.map((c) => c.request.purpose).concat(model.overrun);
    throw new SyntheticScriptError(
      script.id,
      `the Kernel made ${purposes.length} model call(s) [${purposes.join(', ')}] but the script has ${script.responses.length} response(s)`,
    );
  }
  return { script, trace: recorder.trace(), recording };
}

/** Record SYN-01..SYN-05 (sequentially, in id order). */
export async function synthesizeTraces(): Promise<SyntheticTrace[]> {
  const out: SyntheticTrace[] = [];
  for (const script of SYNTHETIC_SCRIPTS) out.push(await synthesizeTrace(script));
  return out;
}
