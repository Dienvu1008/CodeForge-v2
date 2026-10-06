// ContextBuilder — CONTEXT_SPEC §3/§13, P2-CX1.
//
// Orchestrates the full context pipeline → ContextSnapshot.
// CX-001: snapshot immutable after build.
// CX-002: every item has provenance.
// CX-003: untrusted content marked (TrustMarker).
// CX-004: token budget enforced (TokenBudgeter).
// CX-005: snapshot is NOT authority — it provides data to the model only.
// CX-006: snapshot bound to workspaceRevision.
import type { ContextSnapshot, ContextItem, BuildReason } from '../domain/context.js';
import type { WorkspaceRevision } from '../domain/workspace-revision.js';
import type { Task } from '../domain/task.js';
import type { Goal } from '../domain/goal.js';
import { Retriever, type RetrieveRequest, type RetrievedSymbol } from './retriever.js';
import { fitToBudget, ContextBudgetError, type BudgetConfig } from './token-budgeter.js';
import { ProvenanceTracker } from './provenance-tracker.js';
import { CANONICAL_FORM_VERSION } from '../domain/workspace-revision.js';

export { ContextBudgetError };

// ── ContextPolicy ─────────────────────────────────────────────────────────────

export interface ContextPolicy {
  readonly policyId: string;
  readonly version: number;
  /** Token budget for context items (CX-004). */
  readonly availableTokens: number;
  /** Max total items (retriever hard limit). */
  readonly maxItems: number;
  /** Allow truncating oversized non-pinned items. */
  readonly allowTruncation: boolean;
  readonly truncationMaxChars?: number;
}

export const DEFAULT_CONTEXT_POLICY: ContextPolicy = {
  policyId:           'default-cx-v1',
  version:            1,
  availableTokens:    6144,  // ≈ 6k tokens for items; system/task prompts use the rest
  maxItems:           30,
  allowTruncation:    true,
  truncationMaxChars: 1200,
};

// ── BuildContextRequest ───────────────────────────────────────────────────────

export interface BuildContextRequest {
  readonly sessionId:         string;
  readonly taskId?:           string;
  readonly taskRunId?:        string;
  readonly workspaceRevision: WorkspaceRevision;
  readonly buildReason:       BuildReason;
  readonly taskData?:         Task;
  readonly goalData?:         Goal;
  readonly workspaceFiles?:   ReadonlyMap<string, string>;
  readonly changedPaths?:     readonly string[];
  readonly graphSummary?:     string;
  readonly failureEvidence?:  string;
  /** P6-CR1: code symbols (from SymbolExtractor), each tagged with its file. */
  readonly symbols?:          readonly RetrievedSymbol[];
  /** P6-CR1: import graph reverse edges (from ImportGraphBuilder). */
  readonly importReverseEdges?: ReadonlyMap<string, ReadonlySet<string>>;
  readonly policy?:           ContextPolicy;
}

// ── ContextBuilderError ───────────────────────────────────────────────────────

export class ContextBuilderError extends Error {
  public readonly code: 'BUDGET_EXCEEDED' | 'EMPTY_CONTEXT';
  constructor(code: ContextBuilderError['code'], message?: string) {
    super(message ?? code);
    this.name = 'ContextBuilderError';
    this.code = code;
  }
}

// ── ContextBuilderDeps ────────────────────────────────────────────────────────

export interface ContextBuilderDeps {
  readonly now:    () => string;
  readonly nextId: () => string;
  readonly schemaVersion?: number;
}

// ── ContextBuilder ────────────────────────────────────────────────────────────

export class ContextBuilder {
  private readonly schema: number;

  constructor(private readonly deps: ContextBuilderDeps) {
    this.schema = deps.schemaVersion ?? 1;
  }

  /**
   * Build a ContextSnapshot from the request.
   *
   * Pipeline:
   *   1. Retrieve candidate items (Retriever).
   *   2. Fit to token budget (TokenBudgeter).
   *   3. Build snapshot (immutable after this call — CX-001).
   *
   * Throws ContextBuilderError('BUDGET_EXCEEDED') if pinned items overflow.
   */
  build(request: BuildContextRequest): ContextSnapshot {
    const policy = request.policy ?? DEFAULT_CONTEXT_POLICY;
    const retriever = new Retriever({ now: this.deps.now, nextId: this.deps.nextId });
    const tracker = new ProvenanceTracker({
      sessionId: request.sessionId,
      now:       this.deps.now,
      nextId:    this.deps.nextId,
    });

    // Step 1: Retrieve candidates.
    const retrieveReq: RetrieveRequest = {
      sessionId:         request.sessionId,
      workspaceRevision: request.workspaceRevision,
      buildReason:       request.buildReason,
      ...(request.taskId    !== undefined ? { taskId:    request.taskId }    : {}),
      ...(request.taskRunId !== undefined ? { taskRunId: request.taskRunId } : {}),
      ...(request.taskData  !== undefined ? { taskData:  request.taskData }  : {}),
      ...(request.goalData  !== undefined ? { goalData:  request.goalData }  : {}),
      ...(request.workspaceFiles !== undefined ? { workspaceFiles: request.workspaceFiles } : {}),
      ...(request.changedPaths   !== undefined ? { changedPaths:   request.changedPaths }   : {}),
      ...(request.graphSummary   !== undefined ? { graphSummary:   request.graphSummary }   : {}),
      ...(request.failureEvidence !== undefined ? { failureEvidence: request.failureEvidence } : {}),
      ...(request.symbols          !== undefined ? { symbols:          request.symbols }          : {}),
      ...(request.importReverseEdges !== undefined ? { importReverseEdges: request.importReverseEdges } : {}),
      maxItems: policy.maxItems,
    };
    const candidates = retriever.retrieve(retrieveReq);

    // Step 2: Fit to budget.
    const budgetConfig: BudgetConfig = {
      availableTokens: policy.availableTokens,
      allowTruncation: policy.allowTruncation,
      ...(policy.truncationMaxChars !== undefined ? { truncationMaxChars: policy.truncationMaxChars } : {}),
    };

    let budgetResult: ReturnType<typeof fitToBudget>;
    try {
      budgetResult = fitToBudget(candidates, budgetConfig);
    } catch (err) {
      if (err instanceof ContextBudgetError) {
        throw new ContextBuilderError('BUDGET_EXCEEDED', err.message);
      }
      throw err;
    }

    const snapshotId = this.deps.nextId();

    // Step 3: Attach inline provenance to each item (CX-002).
    const finalItems: ContextItem[] = budgetResult.items.map((item) => ({
      ...item,
      provenance: tracker.itemInlineProvenance(item.reason, item.source.kind),
    }));

    // Step 4: Build snapshot (CX-001: immutable, CX-006: bound to revision).
    const snapshot: ContextSnapshot = {
      snapshotId,
      sessionId:             request.sessionId,
      ...(request.taskId    !== undefined ? { taskId:    request.taskId }    : {}),
      ...(request.taskRunId !== undefined ? { taskRunId: request.taskRunId } : {}),
      workspaceRevision:     request.workspaceRevision, // CX-006
      canonicalFormVersion:  CANONICAL_FORM_VERSION,
      items:                 finalItems,
      tokenBudget:           policy.availableTokens,
      tokenUsed:             budgetResult.tokenUsed,
      builtBy:               this.resolveBuiltBy(request.buildReason),
      builtAt:               this.deps.now(),
      buildReason:           request.buildReason,
      policyVersion:         policy.version,
      schemaVersion:         this.schema,
    };

    return snapshot;
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private resolveBuiltBy(reason: BuildReason): ContextSnapshot['builtBy'] {
    switch (reason) {
      case 'initial_plan':         return 'planner';
      case 'replan':               return 'replanner';
      case 'task_execution':       return 'executor';
      case 'failure_analysis':     return 'analyzer';
      case 'verification_assist':  return 'verifier_assist';
      case 'user_request':         return 'planner';
      default:                     return 'planner';
    }
  }
}
