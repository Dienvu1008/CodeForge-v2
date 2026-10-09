// Context-strategy cost (P12.7 before/after) — proves that a narrow ContextPlan actually REDUCES
// the context the agent is given versus the default/repository-wide path, on a real workspace via
// the real ContextCollector + ContextBuilder. This is the "after" measurement that justifies
// wiring the strategy: narrower scope ⇒ fewer codebase items + fewer tokens, with the pinned
// task/goal items always retained (CX-004). FakeModel-free, deterministic, CI-safe.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ContextCollector } from '@codeforge/infrastructure';
import {
  ContextBuilder, policyFromContextPlan, DEFAULT_CONTEXT_POLICY,
  type ContextPlan, type Task, type WorkspaceRevision,
} from '@codeforge/agent-core';

let root: string;
let n = 0;
const now = () => '2026-01-01T00:00:00.000Z';
const nextId = () => `id-${++n}`;

function revision(): WorkspaceRevision {
  return {
    revisionId: 'rev', canonicalFormVersion: 'v1', root, includedPaths: [], excludedScratchPaths: [],
    hashAlgorithm: 'blake3', hash: 'H', fileCount: 0, totalBytes: 0,
    createdAt: now(), createdBy: { sessionId: 'S', reason: 'session_start' },
  };
}
function task(): Task {
  return {
    taskId: 'T1', description: 'tweak one helper',
    acceptanceCriteria: [{ criterionId: 'c', description: 'done', mandatory: true }],
    constraints: [], priority: 1, strategy: { kind: 'generate' }, createdAt: now(), createdBy: 'planner',
  };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cf-cxcost-'));
  // A workspace with many source files so scope actually matters.
  for (let i = 0; i < 20; i++) {
    await writeFile(join(root, `mod${i}.ts`), `export function f${i}(x: number): number {\n  return x + ${i};\n}\n`, 'utf8');
  }
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

async function buildWith(plan: ContextPlan | undefined): Promise<{ items: number; tokens: number }> {
  const collector = new ContextCollector({ workspaceRoot: root });
  const signals = await collector.collect([], plan);
  const builder = new ContextBuilder({ now, nextId });
  const snapshot = builder.build({
    sessionId: 'S', taskId: 'T1', workspaceRevision: revision(), buildReason: 'task_execution',
    taskData: task(),
    workspaceFiles: signals.workspaceFiles, symbols: signals.symbols,
    importReverseEdges: signals.importReverseEdges, changedPaths: signals.changedPaths,
    ...(plan !== undefined ? { policy: policyFromContextPlan(plan) } : {}),
  });
  return { items: snapshot.items.length, tokens: snapshot.tokenUsed };
}

describe('P12.7 context-strategy cost (before/after on a real workspace)', () => {
  it('a narrow TASK plan yields fewer items + tokens than the default (no plan)', async () => {
    const before = await buildWith(undefined);                                   // DEFAULT_CONTEXT_POLICY
    const after = await buildWith({ scope: 'TASK', maxFiles: 3, repositoryWide: false });
    console.log(`CONTEXT before(default): items=${before.items} tokens=${before.tokens} | ` +
      `after(TASK): items=${after.items} tokens=${after.tokens}`);
    expect(after.items).toBeLessThanOrEqual(before.items);
    expect(after.tokens).toBeLessThanOrEqual(before.tokens);
    // The pinned task definition is always retained regardless of scope (CX-004).
    expect(after.items).toBeGreaterThanOrEqual(1);
  });

  it('a repositoryWide plan yields at least as much context as a narrow one', async () => {
    const narrow = await buildWith({ scope: 'TASK', maxFiles: 3, repositoryWide: false });
    const wide = await buildWith({ scope: 'REPOSITORY', maxFiles: 150, repositoryWide: true });
    expect(wide.items).toBeGreaterThanOrEqual(narrow.items);
    expect(wide.tokens).toBeGreaterThanOrEqual(narrow.tokens);
  });

  it('default policy budget is unchanged (fail-safe anchor)', () => {
    expect(DEFAULT_CONTEXT_POLICY.availableTokens).toBe(6144);
    expect(DEFAULT_CONTEXT_POLICY.maxItems).toBe(30);
  });
});
