// view-model (P12.22) — pure transforms runtime read-models → tree nodes (no vscode host).
import { describe, it, expect } from 'vitest';
import {
  sessionNodes, taskGraphNodes, governanceNodes, governanceNode, changeNodes, statusBarText, taskIconId,
  findPendingApproval, approvalDetail,
} from '../../packages/vscode-extension/src/view-model.js';
import type { RuntimeProjection, DomainEvent } from '@codeforge/agent-core';
import type { ChangeView } from '../../packages/vscode-extension/src/runtime-client.js';

function task(id: string, state: string, dependsOn: string[], extra: Partial<RuntimeProjection['tasks'][number]> = {}): RuntimeProjection['tasks'][number] {
  return { taskId: id, state: state as never, isActive: false, isBlocked: false, blockedBy: [], dependsOn, ...extra };
}
function projection(tasks: RuntimeProjection['tasks'], sessionState = 'RUNNING'): RuntimeProjection {
  return {
    sessionId: 'S', sessionState: sessionState as never, graphVersion: 1,
    counts: { total: tasks.length, passed: tasks.filter((t) => t.state === 'PASSED').length, active: 0, blocked: 0, failed: 0 },
    tasks, activeTaskIds: [], blockedTaskIds: [],
  } as unknown as RuntimeProjection;
}
function ev(type: string, payload: Record<string, unknown>, at = '2026-01-01T00:00:05.000Z'): DomainEvent {
  return { eventId: 'E-' + type, sessionId: 'S', type: type as never, aggregate: { kind: 'session', id: 'S' }, payload, at, sequenceNumber: 1 } as unknown as DomainEvent;
}

describe('sessionNodes', () => {
  it('marks the attached session and shows state', () => {
    const nodes = sessionNodes([{ sessionId: 'S1', state: 'RUNNING', createdAt: 't' }, { sessionId: 'S2', state: 'COMPLETED', createdAt: 't' }], 'S1');
    expect(nodes[0]!.description).toContain('attached');
    expect(nodes[0]!.iconId).toBe('circle-filled');
    expect(nodes[1]!.iconId).toBe('pass');
  });
  it('shows a placeholder when there are no sessions', () => {
    expect(sessionNodes([], '')[0]!.label).toContain('no sessions');
  });
});

describe('taskGraphNodes', () => {
  it('nests dependents under their dependency (T2 depends on T1 → T2 is a child of T1)', () => {
    const p = projection([task('T1', 'PASSED', []), task('T2', 'RUNNING', ['T1'], { isActive: true })]);
    const roots = taskGraphNodes(p);
    expect(roots).toHaveLength(1);
    expect(roots[0]!.label).toBe('T1');
    expect(roots[0]!.children!.map((c) => c.label)).toEqual(['T2']);
    expect(roots[0]!.children![0]!.iconId).toBe('sync~spin'); // active
    expect(roots[0]!.iconId).toBe('pass');
  });
  it('falls back to a flat list when every task has a dependency (cycle-safe)', () => {
    const p = projection([task('A', 'READY', ['B']), task('B', 'READY', ['A'])]);
    const roots = taskGraphNodes(p);
    expect(roots.map((r) => r.label).sort()).toEqual(['A', 'B']);
  });
  it('placeholder when empty', () => {
    expect(taskGraphNodes(null)[0]!.label).toContain('no tasks');
  });
  it('taskIconId: VERIFYING counts as done when the session is terminal', () => {
    expect(taskIconId(task('T', 'VERIFYING', []), true)).toBe('pass');
    expect(taskIconId(task('T', 'VERIFYING', []), false)).toBe('beaker');
    expect(taskIconId(task('T', 'FAILED', []), false)).toBe('error');
  });
});

describe('governanceNodes', () => {
  it('classifies the key governance events and ignores the rest', () => {
    const nodes = governanceNodes([
      ev('VERIFICATION_ENDED', { status: 'FAIL', scope: 'AFFECTED' }),
      ev('TASK_FAILED', { class: 'LOGIC', stage: 'verify' }),
      ev('RECOVERY_ACTION_TAKEN', { action: 'FIX', outcome: 'PENDING' }),
      ev('DECISION_COMPLETED', { decision: 'done_rejected_missing_paths' }),
      ev('TOOL_CALL_APPROVED', { toolCallId: 'TC1' }),
      ev('MODEL_SELECTED', { modelId: 'x' }), // not governance → ignored
    ]);
    const labels = nodes.map((n) => n.label);
    expect(labels).toContain('verification FAIL');
    expect(labels).toContain('failure LOGIC');
    expect(labels).toContain('recovery FIX');
    expect(labels).toContain('completion gate challenged done');
    expect(labels).toContain('tool approved');
    expect(labels).not.toContain('MODEL_SELECTED');
  });
  it('returns null for a non-governance event', () => {
    expect(governanceNode(ev('CONTEXT_SNAPSHOT_BUILT', {}))).toBeNull();
  });
  it('placeholder when no governance events', () => {
    expect(governanceNodes([ev('MODEL_SELECTED', {})])[0]!.label).toContain('no governance');
  });
});

describe('changeNodes', () => {
  it('renders newest first with a diff-aware contextValue', () => {
    const changes: ChangeView[] = [
      { toolCallId: 'TC1', toolName: 'write_file', kind: 'write', state: 'SUCCEEDED', at: 't1', path: 'a.js', summary: 'write a.js', diff: '+ x' },
      { toolCallId: 'TC2', toolName: 'delete_file', kind: 'delete', state: 'SUCCEEDED', at: 't2', path: 'b.js', summary: 'delete b.js' },
    ];
    const nodes = changeNodes(changes);
    expect(nodes[0]!.value).toBe('TC2');            // newest first
    expect(nodes[0]!.contextValue).toBe('change');  // no diff
    expect(nodes[1]!.contextValue).toBe('change-diff'); // has a diff
  });
});

describe('findPendingApproval', () => {
  it('returns the pending toolCallId until it is resolved', () => {
    const pendingEvents = [ev('TOOL_CALL_REQUESTED', { toolCallId: 'TC1', state: 'APPROVAL_PENDING' })];
    expect(findPendingApproval(pendingEvents)).toBe('TC1');
    const resolved = [...pendingEvents, ev('TOOL_CALL_APPROVED', { toolCallId: 'TC1' })];
    expect(findPendingApproval(resolved)).toBeNull();
  });
  it('returns null when no approval is pending', () => {
    expect(findPendingApproval([ev('VERIFICATION_ENDED', { status: 'PASS' })])).toBeNull();
  });
  it('tracks only the latest unresolved pending call', () => {
    const events = [
      ev('TOOL_CALL_REQUESTED', { toolCallId: 'TC1', state: 'APPROVAL_PENDING' }),
      ev('TOOL_CALL_ENDED', { toolCallId: 'TC1' }),
      ev('TOOL_CALL_REQUESTED', { toolCallId: 'TC2', state: 'APPROVAL_PENDING' }),
    ];
    expect(findPendingApproval(events)).toBe('TC2');
  });
});

describe('approvalDetail', () => {
  it('names the tool + path when the change is known', () => {
    const detail = approvalDetail('TC1', [{ toolCallId: 'TC1', toolName: 'run_command', kind: 'other', state: 'APPROVAL_PENDING', at: 't', path: 'npm install', summary: 'run_command npm install' }]);
    expect(detail).toContain('run_command');
    expect(detail).toContain('npm install');
  });
  it('falls back to the id when the change is unknown', () => {
    expect(approvalDetail('TCX', [])).toContain('TCX');
  });
});

describe('changeNodes before/after', () => {
  it('a change with before/after keeps a diffable contextValue', () => {
    const nodes = changeNodes([{ toolCallId: 'TC1', toolName: 'edit_file', kind: 'edit', state: 'SUCCEEDED', at: 't', path: 'a.js', summary: 'edit a.js', diff: '- x\n+ y', before: 'x', after: 'y' }]);
    expect(nodes[0]!.contextValue).toBe('change-diff');
  });
});

describe('statusBarText', () => {
  it('summarizes the active session', () => {
    const p = projection([task('T1', 'PASSED', []), task('T2', 'RUNNING', [])]);
    (p as { counts: { total: number; passed: number } }).counts = { total: 2, passed: 1 } as never;
    expect(statusBarText(p)).toContain('CodeForge: RUNNING');
    expect(statusBarText(p)).toContain('1/2 passed');
    expect(statusBarText(null)).toContain('not connected');
  });
});
