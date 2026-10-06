// MultiAgentCoordinator (P8-MA1) — deterministic merger of sub-agent output into
// PROPOSALS. Enforces AU-002 (no new authority) and AU-007 (sub-agent output is a
// proposal, never authority).
//
// A sub-agent (planner / critic / executor fan-out) runs through the existing kernel
// and returns plain data. This coordinator is a PURE, TOTAL function of those results:
// it normalizes and merges them into a deterministically-ordered set of proposals that
// the runtime then decides on. It performs no I/O, holds no commit authority, and
// cannot complete a task.
//
// Why this cannot become a new authority:
//   - AU-002: every graph change a sub-agent suggests is emitted as a GraphMutation with
//     status 'PROPOSED' and provenance.source.kind = 'model'. It MUST still pass the
//     graph validator (GR-5 / GI-009) and be committed by the runtime — the coordinator
//     never calls GraphCommitService and never stamps 'VALIDATED' / 'COMMITTED'.
//   - AU-007: a sub-agent can suggest a task is "done", but that is only a
//     CompletionProposal. TI-005 / CompletionGate remains the sole path to PASSED; the
//     coordinator carries the suggestion through, it never satisfies the gate.
//   - A result claiming runtime/user authority (source.kind 'runtime' | 'user', or a
//     mutation already stamped 'VALIDATED' / 'COMMITTED') is rejected as malformed —
//     a sub-agent is a 'model' source and may only PROPOSE.
import type { GraphMutation, MutationStatus } from '../graph/types.js';
import type { Provenance, ProvenanceSourceKind } from '../domain/provenance.js';

// ── Sub-agent input ───────────────────────────────────────────────────────────

/** A single thing a sub-agent suggests. Discriminated so the runtime can route it. */
export type SubAgentSuggestion =
  | { readonly kind: 'graph'; readonly mutation: GraphMutation }
  | { readonly kind: 'completion'; readonly taskId: string; readonly rationale: string };

/** Plain-data result returned by one sub-agent run (through the kernel). */
export interface SubAgentResult {
  /** Stable id of the sub-agent (e.g. 'planner', 'critic', 'executor-3'). */
  readonly agentId: string;
  /** Provenance of this result — a sub-agent is a 'model' source (never runtime/user). */
  readonly provenance: Provenance;
  /** What the sub-agent suggests. May be empty (sub-agent had nothing to add). */
  readonly suggestions: readonly SubAgentSuggestion[];
}

// ── Proposals (output) ──────────────────────────────────────────────────────────

/** A graph change a sub-agent suggests. Always PROPOSED — never committed here. */
export interface GraphProposal {
  readonly kind: 'graph';
  readonly agentId: string;
  /** Mutation normalized to status 'PROPOSED', proposedBy carried as its origin. */
  readonly mutation: GraphMutation;
}

/** A "task is done" suggestion. Advisory only — CompletionGate (TI-005) still decides. */
export interface CompletionProposal {
  readonly kind: 'completion';
  readonly agentId: string;
  readonly taskId: string;
  readonly rationale: string;
}

export type Proposal = GraphProposal | CompletionProposal;

export interface CoordinationOutcome {
  /** Deterministically-ordered proposals for the runtime to decide on. */
  readonly proposals: readonly Proposal[];
  /** Results rejected as malformed (claimed authority), with why. Deterministic order. */
  readonly rejected: readonly RejectedResult[];
}

export type RejectReason =
  | 'authority-source'   // provenance.source.kind was runtime/user (not a model proposal)
  | 'already-committed'; // mutation arrived stamped VALIDATED/COMMITTED (bypass attempt)

export interface RejectedResult {
  readonly agentId: string;
  readonly reason: RejectReason;
}

// ── MultiAgentCoordinator ─────────────────────────────────────────────────────

/** Source kinds a sub-agent result may legitimately carry. A sub-agent is a model. */
const ALLOWED_SOURCE_KINDS: ReadonlySet<ProvenanceSourceKind> = new Set(['model', 'tool']);

/** Mutation statuses that mean "the runtime already decided" — a sub-agent may not send these. */
const AUTHORITATIVE_STATUSES: ReadonlySet<MutationStatus> = new Set(['VALIDATED', 'COMMITTED']);

export class MultiAgentCoordinator {
  /**
   * Merge sub-agent results into a deterministic set of proposals.
   *
   * Pure + total: ordering is by (agentId, suggestion index) with results pre-sorted by
   * agentId, so the same inputs always produce the same outcome regardless of arrival
   * order (AU-002/007 are deterministic, auditable — SC-006 spirit). No I/O, no mutation
   * of inputs, no authority exercised.
   */
  coordinate(results: readonly SubAgentResult[]): CoordinationOutcome {
    const proposals: Proposal[] = [];
    const rejected: RejectedResult[] = [];

    // Deterministic order independent of arrival order: sort results by agentId.
    const ordered = [...results].sort((a, b) => compareStr(a.agentId, b.agentId));

    for (const result of ordered) {
      const guard = this.guard(result);
      if (guard !== null) {
        rejected.push({ agentId: result.agentId, reason: guard });
        continue;
      }
      for (const s of result.suggestions) {
        proposals.push(this.toProposal(result.agentId, s));
      }
    }

    return { proposals, rejected };
  }

  // ── internals ────────────────────────────────────────────────────────────────

  /**
   * Reject a result that claims authority a sub-agent cannot hold.
   * Returns the reject reason, or null if the result is a legitimate proposal source.
   */
  private guard(result: SubAgentResult): RejectReason | null {
    // AU-007: a sub-agent is a model/tool source. A result claiming to be the runtime
    // or the user is a forged-authority attempt — reject it.
    if (!ALLOWED_SOURCE_KINDS.has(result.provenance.source.kind)) {
      return 'authority-source';
    }
    // AU-002: a graph suggestion must arrive as a mere proposal. A mutation already
    // stamped VALIDATED/COMMITTED would bypass the validator/commit authority — reject.
    for (const s of result.suggestions) {
      if (s.kind === 'graph' && AUTHORITATIVE_STATUSES.has(s.mutation.status)) {
        return 'already-committed';
      }
    }
    return null;
  }

  /** Normalize one suggestion into a proposal (never authority). */
  private toProposal(agentId: string, s: SubAgentSuggestion): Proposal {
    if (s.kind === 'graph') {
      // Force status to PROPOSED — the runtime's validator + GraphCommitService (GI-009)
      // remain the only path from PROPOSED to COMMITTED. We never pre-decide that here.
      const mutation: GraphMutation = { ...s.mutation, status: 'PROPOSED' };
      return { kind: 'graph', agentId, mutation };
    }
    return { kind: 'completion', agentId, taskId: s.taskId, rationale: s.rationale };
  }
}

/** Total, locale-independent string order (deterministic across platforms). */
function compareStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
