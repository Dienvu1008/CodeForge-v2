/*
 * Copyright 2026 DienVu (Dienvu1008)
 * SPDX-License-Identifier: Apache-2.0
 */

// view-model (P12.22) — PURE transforms from runtime read-models into plain tree-node data the
// extension's TreeDataProviders render. No `vscode` import: the shapes are generic (label +
// description + iconId + children + a contextValue for menus), so extension.ts just maps each
// node to a vscode.TreeItem. Keeping the logic here makes it unit-testable without the VS Code
// host (same pattern as vscode-control-mapper.ts).
import type { RuntimeProjection, DomainEvent } from '@codeforge/agent-core';
import type { SessionSummary, ChangeView } from './runtime-client.js';

/** A generic tree node (extension.ts maps iconId → vscode.ThemeIcon, contextValue → menus). */
export interface ViewNode {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly tooltip?: string;
  /** VS Code ThemeIcon id, e.g. 'pass', 'error', 'sync~spin', 'circle-outline'. */
  readonly iconId?: string;
  /** Used by package.json menu `when` clauses (e.g. 'session', 'task', 'change'). */
  readonly contextValue?: string;
  readonly children?: readonly ViewNode[];
  /** Opaque payload for a click command (e.g. the sessionId / toolCallId). */
  readonly value?: string;
}

// ── Sessions ────────────────────────────────────────────────────────────────

export function sessionNodes(sessions: readonly SessionSummary[], activeSessionId: string): readonly ViewNode[] {
  if (sessions.length === 0) return [{ id: 'no-sessions', label: '(no sessions)', iconId: 'info' }];
  return sessions.map((s) => ({
    id: `session:${s.sessionId}`,
    label: s.sessionId,
    description: s.state + (s.sessionId === activeSessionId ? ' · attached' : ''),
    tooltip: `created ${s.createdAt}`,
    iconId: s.sessionId === activeSessionId ? 'circle-filled' : sessionStateIcon(s.state),
    contextValue: 'session',
    value: s.sessionId,
  }));
}

function sessionStateIcon(state: string): string {
  switch (state) {
    case 'RUNNING': return 'sync~spin';
    case 'COMPLETED': return 'pass';
    case 'ABORTED': return 'error';
    case 'AWAITING_HUMAN': return 'warning';
    default: return 'circle-outline';
  }
}

// ── Task graph ────────────────────────────────────────────────────────────────

/** VS Code ThemeIcon id for a task projection's state. */
export function taskIconId(t: RuntimeProjection['tasks'][number], sessionDone: boolean): string {
  if (sessionDone && t.state === 'VERIFYING') return 'pass'; // done, unverified
  if (t.isActive || t.state === 'RUNNING') return 'sync~spin';
  if (t.state === 'PASSED') return 'pass';
  if (t.state === 'FAILED') return 'error';
  if (t.state === 'VERIFYING') return 'beaker';
  if (t.state === 'SUPERSEDED') return 'discard';
  if (t.isBlocked) return 'circle-slash';
  if (t.state === 'READY') return 'circle-outline';
  return 'circle-outline';
}

/**
 * Build the task graph as a tree: ROOT tasks (no deps) at the top, each task's DEPENDENTS nested
 * beneath it (so expanding a task shows what depends on it). Deterministic order by taskId. A
 * node is marked once (by id) to avoid infinite nesting on a cycle; shared dependents may appear
 * under more than one parent, which is correct for a DAG rendered as a tree.
 */
export function taskGraphNodes(projection: RuntimeProjection | null): readonly ViewNode[] {
  if (projection === null || projection.tasks.length === 0) {
    return [{ id: 'no-tasks', label: '(no tasks)', iconId: 'info' }];
  }
  const sessionDone = projection.sessionState === 'COMPLETED'
    || projection.sessionState === 'ABORTED' || projection.sessionState === 'AWAITING_HUMAN';
  const tasks = [...projection.tasks].sort((a, b) => (a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0));

  // dependents: for each task, the tasks that depend on it (reverse of dependsOn).
  const dependents = new Map<string, string[]>();
  for (const t of tasks) {
    for (const dep of t.dependsOn) {
      const arr = dependents.get(dep) ?? [];
      arr.push(t.taskId);
      dependents.set(dep, arr);
    }
  }
  const byId = new Map(tasks.map((t) => [t.taskId, t]));

  const build = (taskId: string, trail: ReadonlySet<string>): ViewNode => {
    const t = byId.get(taskId)!;
    const stLabel = (sessionDone && t.state === 'VERIFYING') ? 'done (unverified)' : t.state;
    const kids = (dependents.get(taskId) ?? [])
      .filter((d) => !trail.has(d))
      .sort((a, b) => (a < b ? -1 : 1))
      .map((d) => build(d, new Set([...trail, taskId])));
    return {
      id: `task:${taskId}`,
      label: taskId,
      description: stLabel + (t.isBlocked ? ' · blocked' : ''),
      tooltip: t.dependsOn.length > 0 ? `depends on: ${t.dependsOn.join(', ')}` : 'no dependencies',
      iconId: taskIconId(t, sessionDone),
      contextValue: 'task',
      value: taskId,
      ...(kids.length > 0 ? { children: kids } : {}),
    };
  };

  const roots = tasks.filter((t) => t.dependsOn.length === 0);
  // If every task has a dependency (a cycle, or all depend on something), fall back to a flat list.
  const top = roots.length > 0 ? roots : tasks;
  return top.map((t) => build(t.taskId, new Set()));
}

// ── Governance ────────────────────────────────────────────────────────────────

/** Classify one event into a governance row, or null if it is not a governance event. */
export function governanceNode(e: DomainEvent): ViewNode | null {
  const p = (e.payload ?? {}) as Record<string, unknown>;
  const at = typeof e.at === 'string' ? e.at.slice(11, 19) : '';
  const row = (iconId: string, label: string, desc?: string): ViewNode => ({
    id: `gov:${e.eventId}`, label, ...(desc !== undefined ? { description: desc } : {}),
    iconId, contextValue: 'gov', tooltip: `${e.type} @ ${at}`,
  });
  switch (e.type) {
    case 'VERIFICATION_ENDED': {
      const ok = p['status'] === 'PASS';
      return row(ok ? 'pass' : 'error', `verification ${String(p['status'])}`, `${at} ${String(p['scope'] ?? '')}`.trim());
    }
    case 'TASK_FAILED':
    case 'FAILURE_DETECTED':
      return row('warning', `failure ${String(p['class'] ?? 'UNKNOWN')}`, `${at} ${String(p['stage'] ?? '')}`.trim());
    case 'RECOVERY_ACTION_TAKEN':
    case 'RECOVERY_ACTION_CHOSEN':
      return row('debug-restart', `recovery ${String(p['action'] ?? '?')}`, `${at} ${String(p['outcome'] ?? '')}`.trim());
    case 'TOOL_CALL_APPROVED':
      return row('thumbsup', 'tool approved', `${at} ${String(p['toolCallId'] ?? '')}`.trim());
    case 'TOOL_CALL_DENIED':
      return row('thumbsdown', 'tool denied', `${at} ${String(p['toolCallId'] ?? '')}`.trim());
    case 'MISSION_ARCHITECTURE_GATE_BLOCKED':
      return row('circle-slash', 'architecture gate BLOCKED', at);
    case 'DECISION_COMPLETED': {
      const d = p['decision'];
      if (typeof d === 'string' && d.indexOf('done_rejected') === 0) {
        const why = d === 'done_rejected_missing_paths' ? 'named files not written' : 'no change made';
        return row('circle-slash', 'completion gate challenged done', `${at} ${why}`);
      }
      return null;
    }
    default:
      return null;
  }
}

export function governanceNodes(events: readonly DomainEvent[]): readonly ViewNode[] {
  const rows: ViewNode[] = [];
  for (const e of events) {
    const n = governanceNode(e);
    if (n !== null) rows.push(n);
  }
  if (rows.length === 0) return [{ id: 'no-gov', label: '(no governance events yet)', iconId: 'info' }];
  return rows;
}

// ── Changes (used by Step 3 diff, but the node list is pure here) ──────────────

export function changeNodes(changes: readonly ChangeView[]): readonly ViewNode[] {
  if (changes.length === 0) return [{ id: 'no-changes', label: '(no changes yet)', iconId: 'info' }];
  // Newest first.
  return [...changes].reverse().map((c) => ({
    id: `change:${c.toolCallId}`,
    label: c.path ?? c.summary,
    description: `${c.kind} · ${c.state}`,
    tooltip: c.summary,
    iconId: changeIconId(c.kind),
    contextValue: c.diff !== undefined ? 'change-diff' : 'change',
    value: c.toolCallId,
  }));
}

function changeIconId(kind: ChangeView['kind']): string {
  switch (kind) {
    case 'edit': return 'edit';
    case 'write': return 'new-file';
    case 'delete': return 'trash';
    case 'move': return 'arrow-right';
    default: return 'file';
  }
}

// ── Approval detection (pure) ─────────────────────────────────────────────────

/**
 * Scan the event stream for a tool call that is APPROVAL_PENDING and not yet resolved. Mirrors
 * the dashboard's logic: a TOOL_CALL_REQUESTED with state APPROVAL_PENDING is pending until that
 * same toolCallId is approved/denied/started/ended. Returns the pending toolCallId, or null.
 */
export function findPendingApproval(events: readonly DomainEvent[]): string | null {
  let pending: string | null = null;
  for (const e of events) {
    const p = (e.payload ?? {}) as Record<string, unknown>;
    const tcId = typeof p['toolCallId'] === 'string' ? p['toolCallId'] : undefined;
    if (e.type === 'TOOL_CALL_REQUESTED' && p['state'] === 'APPROVAL_PENDING' && tcId !== undefined) {
      pending = tcId;
    }
    if (tcId !== undefined && pending === tcId &&
        (e.type === 'TOOL_CALL_APPROVED' || e.type === 'TOOL_CALL_DENIED' ||
         e.type === 'TOOL_CALL_STARTED' || e.type === 'TOOL_CALL_ENDED')) {
      pending = null;
    }
  }
  return pending;
}

/** Human-readable detail for a pending approval, enriched from the change transcript. */
export function approvalDetail(toolCallId: string, changes: readonly ChangeView[]): string {
  const c = changes.find((x) => x.toolCallId === toolCallId);
  if (c === undefined) return `Tool call ${toolCallId} is awaiting your decision.`;
  const target = c.path ? ` on ${c.path}` : '';
  return `The agent wants to run ${c.toolName}${target}. (${c.summary})`;
}

/** Status-bar summary string for the active session (compact). */
export function statusBarText(projection: RuntimeProjection | null): string {
  if (projection === null) return '$(circle-outline) CodeForge: not connected';
  const c = projection.counts;
  const budget = projection.budget ? ` · budget ${Math.round(projection.budget.pressure * 100)}%` : '';
  const icon = projection.sessionState === 'RUNNING' ? '$(sync~spin)'
    : projection.sessionState === 'COMPLETED' ? '$(pass)'
    : projection.sessionState === 'AWAITING_HUMAN' ? '$(warning)'
    : projection.sessionState === 'ABORTED' ? '$(error)' : '$(circle-outline)';
  return `${icon} CodeForge: ${projection.sessionState} · ${c.passed}/${c.total} passed${budget}`;
}
