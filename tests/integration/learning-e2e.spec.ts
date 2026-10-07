// P11-I1 — Learning plane end-to-end + the central zero-authority proof (flag-off parity).
//
// Chain:
//   run history (failures + recovery actions)
//     -> SelfModelBuilder            (read-only projection, LE-004)
//     -> LessonWriter -> SqliteLearningStore  (bounded, provenance, append-only; LE-005/006)
//     -> RecoveryAdvisor / NoProgressAdvisor  (propose, advisory only; LE-001)
//     -> AdviceGate                  (clamp into the deterministic allowed-set; LE-003/007)
//     -> decide() / ContextReranker / combineNoProgress (consume gated advice)
//
// The decisive test is FLAG-OFF PARITY (LE-002): running the exact same decisions with the
// learning layer wired-but-empty, and with it entirely absent, yields BYTE-IDENTICAL runtime
// behavior — proving the learning plane holds zero authority.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  SelfModelBuilder,
  LessonWriter,
  RecoveryAdvisor,
  NoProgressAdvisor,
  ContextReranker,
  AdviceGate,
  combineNoProgress,
  decide,
  detectNoProgress,
  DEFAULT_RECOVERY_POLICY,
} from '@codeforge/agent-core';
import type {
  Failure, RecoveryAction, RecoveryKind, ContextItem, Provenance,
  SafeAdvice, SafeRecoveryOrderAdvice,
} from '@codeforge/agent-core';

/** Narrow a gated SafeAdvice|null to the recovery-order shape decide() accepts. */
function asRecoveryOrder(safe: SafeAdvice | null): SafeRecoveryOrderAdvice | undefined {
  return safe !== null && safe.kind === 'recovery_order' ? safe : undefined;
}
import {
  SqliteDatabaseAdapter,
  SqliteLearningStore,
  runMigrations,
  createMigrationRegistry,
} from '@codeforge/infrastructure';

const now = () => '2026-05-05T00:00:00.000Z';

function failure(id: string, cls: Failure['class'], sig: string): Failure {
  return {
    failureId: id, sessionId: 's1', taskId: 't1', taskRunId: `r-${id}`,
    stage: 'verify', class: cls, signature: sig, evidence: { message: 'x' },
    detectedAt: now(), classifiedBy: 'deterministic', recoveryActionIds: [],
  };
}
function recovery(id: string, failureId: string, action: RecoveryKind, outcome: RecoveryAction['outcome']): RecoveryAction {
  return {
    actionId: id, failureId, action, reason: 'r', policyVersion: 1,
    budgetConsumed: { wallClockMs: 0, modelTokens: 0, toolCalls: 0, recoveryAttempts: 0 },
    startedAt: now(), outcome,
  };
}
function prov(): Provenance {
  return { provenanceId: 'p', source: { kind: 'runtime', id: 't' }, inputs: [], reason: 'r', at: now() };
}
function ctxItem(itemId: string, priority: number, path?: string, pinned = false): ContextItem {
  return {
    itemId, kind: 'file_full',
    source: { kind: 'workspace_file', ...(path !== undefined ? { path } : {}) },
    content: itemId, tokenCount: 1, trust: 'untrusted', reason: 'r',
    provenance: prov(), priority, pinned, truncated: false,
  };
}

// History where SYNTAX has succeeded with REPLAN more than with FIX.
function history(): { failures: Failure[]; recoveries: RecoveryAction[] } {
  return {
    failures: [
      failure('f1', 'SYNTAX', 'a'), failure('f2', 'SYNTAX', 'b'), failure('f3', 'SYNTAX', 'c'),
      failure('f4', 'SYNTAX', 'a'), failure('f5', 'SYNTAX', 'a'),
    ],
    recoveries: [
      recovery('x1', 'f1', 'FIX', 'FAILED'),
      recovery('x2', 'f2', 'FIX', 'FAILED'),
      recovery('x3', 'f3', 'REPLAN', 'SUCCEEDED'),
      recovery('x4', 'f4', 'REPLAN', 'SUCCEEDED'),
    ],
  };
}

let db: SqliteDatabaseAdapter;
let store: SqliteLearningStore;
let idN = 0;

beforeEach(() => {
  db = new SqliteDatabaseAdapter(':memory:');
  db.open();
  runMigrations(db, createMigrationRegistry(), { now });
  store = new SqliteLearningStore(db);
  idN = 0;
});
afterEach(() => db.close());

describe('P11-I1 — learning plane end-to-end', () => {
  it('distills lessons from history, persists them with provenance, and advises', async () => {
    const { failures, recoveries } = history();
    const model = new SelfModelBuilder().build({ events: [], failures, recoveryActions: recoveries });

    // Persist distilled lessons (LE-005/006).
    const writer = new LessonWriter({ store, now, nextId: () => `id-${++idN}` });
    const written = await writer.writeFromModel(model, 'project');
    expect(written.length).toBeGreaterThan(0);
    for (const l of written) {
      expect(l.provenance.at).toBe(now());
      expect(l.provenance.inputs).toContain('s1');
    }
    const persisted = await store.query({ limit: 100 });
    expect(persisted.length).toBe(written.length);

    // Advise + gate + decide: SYNTAX should now try REPLAN first (its better history).
    const advisor = new RecoveryAdvisor();
    const gate = new AdviceGate();
    const raw = advisor.advise(model, 'SYNTAX');
    const safe = asRecoveryOrder(gate.sanitize(raw!, { allowedActions: DEFAULT_RECOVERY_POLICY.SYNTAX.actions }));
    const first = decide({ failureClass: 'SYNTAX', attemptsSoFar: 0, advice: safe });
    expect(first.action).toBe('REPLAN');

    // But the kernel still owns the bounds: the reachable set equals the policy's own set.
    const reachable = new Set<RecoveryKind>();
    for (let i = 0; i < DEFAULT_RECOVERY_POLICY.SYNTAX.maxAttempts; i++) {
      reachable.add(decide({ failureClass: 'SYNTAX', attemptsSoFar: i, advice: safe }).action);
    }
    expect([...reachable].sort()).toEqual([...DEFAULT_RECOVERY_POLICY.SYNTAX.actions].sort());
  });

  it('ZERO-AUTHORITY: flag-off (no learning) == learning-on-but-empty, byte-identical (LE-002)', async () => {
    const gate = new AdviceGate();
    const advisor = new RecoveryAdvisor();
    const npAdvisor = new NoProgressAdvisor();
    const reranker = new ContextReranker();

    // "Learning on but empty": a fresh store / empty history yields an empty SelfModel, so
    // every advisor returns null and every gated advice is null → consumers keep defaults.
    const emptyModel = new SelfModelBuilder().build({ events: [], failures: [], recoveryActions: [] });

    // (1) Recovery decisions across classes/attempts.
    const classes = ['SYNTAX', 'LOGIC', 'TOOL', 'ENVIRONMENT', 'DEPENDENCY', 'UNKNOWN'] as const;
    for (const cls of classes) {
      for (let i = 0; i < 4; i++) {
        const off = decide({ failureClass: cls, attemptsSoFar: i });
        const rawR = advisor.advise(emptyModel, cls);
        const safeR = asRecoveryOrder(gate.sanitize(rawR, { allowedActions: DEFAULT_RECOVERY_POLICY[cls].actions }));
        const on = decide({ failureClass: cls, attemptsSoFar: i, advice: safeR });
        expect(JSON.stringify(on)).toEqual(JSON.stringify(off)); // byte-identical
      }
    }

    // (2) Context ordering.
    const items: ContextItem[] = [
      ctxItem('pin', 100, 'task', true),
      ctxItem('a', 40, 'src/a.ts'),
      ctxItem('b', 40, 'src/b.ts'),
    ];
    const rawRerank = null; // empty model → no rerank advice
    const safeRerank = gate.sanitize(rawRerank, { candidatePaths: ['src/a.ts', 'src/b.ts'] });
    const reranked = reranker.rerank(items, safeRerank as never);
    expect(reranked).toBe(items); // identical reference — unchanged order (LE-002)

    // (3) No-progress verdict.
    const base = detectNoProgress([failure('a', 'LOGIC', 's'), failure('b', 'LOGIC', 's')], 3);
    const rawNp = npAdvisor.advise(emptyModel); // null (no recurrence)
    const safeNp = gate.sanitize(rawNp, {});
    const combined = combineNoProgress(base, safeNp as never);
    expect(JSON.stringify(combined)).toEqual(JSON.stringify(base)); // unchanged verdict
  });
});
