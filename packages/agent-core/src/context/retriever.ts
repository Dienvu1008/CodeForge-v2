// Retriever — CONTEXT_SPEC §4, P2-CX1.
//
// Baseline Phase 2 retriever: diff-based workspace files + direct-inject for
// task/goal/graph. No Tree-sitter/LSP (Phase 6).
//
// CX-002: every item must have provenance (caller supplies ProvenanceTracker).
// CX-006: snapshot must record workspaceRevision.
// Determinism: same request → same candidate set (sorted, no randomness).
import type {
  ContextItem,
  ContextItemKind,
  ContextSource,
  TrustLevel,
  BuildReason,
} from '../domain/context.js';
import type { WorkspaceRevision } from '../domain/workspace-revision.js';
import type { Task } from '../domain/task.js';
import type { Goal } from '../domain/goal.js';
import type { Provenance } from '../domain/provenance.js';
import { countTokens } from './token-counter.js';

// ── RetrieveRequest ───────────────────────────────────────────────────────────

export interface RetrieveRequest {
  readonly sessionId: string;
  readonly taskId?: string;
  readonly taskRunId?: string;
  readonly workspaceRevision: WorkspaceRevision;
  readonly buildReason: BuildReason;
  /** Concrete data to inject directly (pinned, highest priority). */
  readonly taskData?:  Task;
  readonly goalData?:  Goal;
  /** All workspace file paths + contents available for retrieval. */
  readonly workspaceFiles?: ReadonlyMap<string, string>;
  /** Paths changed in the current taskRun (diff-based affected set). */
  readonly changedPaths?: readonly string[];
  /** Graph summary text (optional). */
  readonly graphSummary?: string;
  /** Failure evidence text (optional). */
  readonly failureEvidence?: string;
  /** Hard limit on candidate items returned. */
  readonly maxItems?: number;
}

// ── Retriever ─────────────────────────────────────────────────────────────────

export interface RetrieverDeps {
  readonly nextId: () => string;
  readonly now:    () => string;
}

export class Retriever {
  constructor(private readonly deps: RetrieverDeps) {}

  /**
   * Retrieve candidate ContextItems for a build request.
   * Order: pinned items first (task/goal/graph), then changed files, then other files.
   * Deterministic: items sorted by (pinned desc, priority desc, path asc).
   */
  retrieve(request: RetrieveRequest): readonly ContextItem[] {
    const items: ContextItem[] = [];

    // 1. Task definition (pinned, trusted, priority 100).
    if (request.taskData !== undefined) {
      items.push(this.makeItem({
        kind:      'task_definition',
        content:   this.taskContent(request.taskData),
        source:    { kind: 'task', artifactId: request.taskData.taskId },
        trust:     'trusted',
        reason:    'task to execute',
        priority:  100,
        pinned:    true,
        sessionId: request.sessionId,
      }));
    }

    // 2. Goal description (pinned, trusted, priority 100).
    if (request.goalData !== undefined) {
      items.push(this.makeItem({
        kind:      'acceptance_criteria',
        content:   this.goalContent(request.goalData),
        source:    { kind: 'goal', artifactId: request.goalData.goalId },
        trust:     'trusted',
        reason:    'goal definition',
        priority:  100,
        pinned:    true,
        sessionId: request.sessionId,
      }));
    }

    // 3. Graph summary (pinned, trusted, priority 85).
    if (request.graphSummary !== undefined && request.graphSummary.length > 0) {
      items.push(this.makeItem({
        kind:      'graph_summary',
        content:   request.graphSummary,
        source:    { kind: 'graph' },
        trust:     'trusted',
        reason:    'task graph context',
        priority:  85,
        pinned:    true,
        sessionId: request.sessionId,
      }));
    }

    // 4. Failure evidence (pinned, untrusted, priority 90).
    if (request.failureEvidence !== undefined && request.failureEvidence.length > 0) {
      items.push(this.makeItem({
        kind:      'failure_evidence',
        content:   request.failureEvidence,
        source:    { kind: 'artifact' },
        trust:     'untrusted',
        reason:    'failure evidence for analysis',
        priority:  90,
        pinned:    true,
        sessionId: request.sessionId,
      }));
    }

    // 5. Changed workspace files (untrusted, priority 80).
    const changedSet = new Set(request.changedPaths ?? []);
    for (const path of [...changedSet].sort()) {
      const content = request.workspaceFiles?.get(path) ?? '';
      if (content.length === 0) continue;
      items.push(this.makeItem({
        kind:      'file_full',
        content,
        source:    {
          kind: 'workspace_file',
          path,
          revisionId: request.workspaceRevision.revisionId,
        },
        trust:     'untrusted',
        reason:    'directly changed in task run',
        priority:  80,
        pinned:    false,
        sessionId: request.sessionId,
      }));
    }

    // 6. Other workspace files (untrusted, priority 40 — fill-in).
    if (request.workspaceFiles !== undefined) {
      const maxItems = request.maxItems ?? 50;
      for (const [path, content] of [...request.workspaceFiles.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        if (changedSet.has(path)) continue; // already included above
        if (content.length === 0) continue;
        if (items.length >= maxItems) break;
        items.push(this.makeItem({
          kind:      'file_full',
          content,
          source:    {
            kind: 'workspace_file',
            path,
            revisionId: request.workspaceRevision.revisionId,
          },
          trust:     'untrusted',
          reason:    'workspace context',
          priority:  40,
          pinned:    false,
          sessionId: request.sessionId,
        }));
      }
    }

    return items.slice(0, request.maxItems ?? items.length);
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  private makeItem(opts: {
    kind:      ContextItemKind;
    content:   string;
    source:    ContextSource;
    trust:     TrustLevel;
    reason:    string;
    priority:  number;
    pinned:    boolean;
    sessionId: string;
  }): ContextItem {
    const provenance: Provenance = {
      provenanceId: this.deps.nextId(),
      source:       { kind: 'runtime', id: opts.source.kind },
      inputs:       [],
      reason:       opts.reason,
      at:           this.deps.now(),
    };
    return {
      itemId:      this.deps.nextId(),
      kind:        opts.kind,
      source:      opts.source,
      content:     opts.content,
      tokenCount:  countTokens(opts.content),
      trust:       opts.trust,
      reason:      opts.reason,
      provenance,
      priority:    opts.priority,
      pinned:      opts.pinned,
      truncated:   false,
    };
  }

  private taskContent(task: Task): string {
    const lines: string[] = [
      `Task: ${task.description}`,
    ];
    if (task.acceptanceCriteria.length > 0) {
      lines.push('Acceptance criteria:');
      for (const ac of task.acceptanceCriteria) {
        lines.push(`  - ${ac.description}`);
      }
    }
    if (task.constraints.length > 0) {
      lines.push('Constraints:');
      for (const c of task.constraints) {
        lines.push(`  - ${c.description}`);
      }
    }
    return lines.join('\n');
  }

  private goalContent(goal: Goal): string {
    const lines: string[] = [`Goal: ${goal.description}`];
    if (goal.acceptanceCriteria.length > 0) {
      lines.push('Acceptance criteria:');
      for (const ac of goal.acceptanceCriteria) {
        lines.push(`  - ${ac.description}`);
      }
    }
    return lines.join('\n');
  }
}
