// P9.11 — VscodeControlMapper: pure mapping layer (offline, no vscode runtime needed).
// Proves OB-006: a VS Code command maps to the SAME ControlRequest shape as dashboard/
// Telegram — the surface is 'vscode' (audit only) and admission is identical.
import { describe, it, expect } from 'vitest';
import {
  commandToControlRequest,
  webviewMessageToControlRequest,
  isControlCommand,
  projectionToStatusViewModel,
  metricsToViewModel,
  type VscodeCommandId,
  type WebviewControlMessage,
} from '../../packages/vscode-extension/src/vscode-control-mapper.js';
import type { RuntimeProjection, SessionMetrics } from '@codeforge/agent-core';

describe('P9.11 VscodeControlMapper — command → ControlRequest (OB-006)', () => {
  it('maps each VS Code command to the correct ControlIntent', () => {
    const commands: Array<[VscodeCommandId, string]> = [
      ['codeforge.pause', 'pause'],
      ['codeforge.resume', 'resume'],
      ['codeforge.cancel', 'cancel'],
      ['codeforge.checkpoint', 'checkpoint'],
    ];
    for (const [cmd, intent] of commands) {
      const req = commandToControlRequest(cmd, 'S');
      expect(req.intent).toBe(intent);
      expect(req.requestedBy.surface).toBe('vscode');
      expect(req.sessionId).toBe('S');
    }
  });

  it('produces the same ControlRequest shape as dashboard/telegram (one-control-path)', () => {
    const req = commandToControlRequest('codeforge.pause', 'S');
    // Same shape: intent + sessionId + requestedBy{kind,id,surface}. The ControlPlane
    // admits based on intent + session state; surface is audit-only.
    expect(req).toEqual({
      intent: 'pause',
      sessionId: 'S',
      requestedBy: { kind: 'user', id: 'vscode-user', surface: 'vscode' },
    });
  });

  it('isControlCommand recognizes known commands and rejects unknown ones', () => {
    expect(isControlCommand('codeforge.pause')).toBe(true);
    expect(isControlCommand('codeforge.dashboard')).toBe(false);
    expect(isControlCommand('some.other.command')).toBe(false);
  });
});

describe('P9.11 VscodeControlMapper — webview message → ControlRequest', () => {
  it('maps a webview control message with optional targets/reason', () => {
    const msg: WebviewControlMessage = { type: 'control', intent: 'deny', sessionId: 'S', toolCallId: 'TC1', reason: 'unsafe' };
    const req = webviewMessageToControlRequest(msg);
    expect(req.intent).toBe('deny');
    expect(req.toolCallId).toBe('TC1');
    expect(req.reason).toBe('unsafe');
    expect(req.requestedBy.surface).toBe('vscode');
  });

  it('omits optional fields when not present (no undefined spread)', () => {
    const msg: WebviewControlMessage = { type: 'control', intent: 'pause', sessionId: 'S' };
    const req = webviewMessageToControlRequest(msg);
    expect('toolCallId' in req).toBe(false);
    expect('taskId' in req).toBe(false);
    expect('reason' in req).toBe(false);
  });
});

describe('P9.11 VscodeControlMapper — view-model formatters', () => {
  it('projectionToStatusViewModel formats a projection for the panel', () => {
    const p: RuntimeProjection = {
      sessionId: 'S', sessionState: 'RUNNING', goalId: 'G', graphVersion: 3,
      workspaceRevisionId: 'R', model: 'qwen2.5-coder', provider: 'ollama',
      tasks: [], activeTaskIds: [], blockedTaskIds: [], passedTaskIds: [], activeRunCount: 0,
      counts: { total: 5, passed: 2, active: 1, blocked: 1, failed: 1, pending: 0 },
      budget: { state: 'ACTIVE', limits: { wallClockMs: 1000, modelTokens: 100, toolCalls: 10, recoveryAttempts: 2 },
                consumed: { wallClockMs: 500, modelTokens: 50, toolCalls: 5, recoveryAttempts: 0 },
                remaining: { wallClockMs: 500, modelTokens: 50, toolCalls: 5, recoveryAttempts: 2 }, pressure: 0.5 },
    };
    const vm = projectionToStatusViewModel(p);
    expect(vm.state).toBe('RUNNING');
    expect(vm.model).toBe('qwen2.5-coder');
    expect(vm.budgetPressure).toBe('50%');
    expect(vm.taskSummary).toContain('5 tasks');
  });

  it('metricsToViewModel formats session metrics for the panel', () => {
    const m: SessionMetrics = {
      sessionId: 'S', eventCount: 42, spanMs: 65000, outcome: 'COMPLETED',
      taskRunsStarted: 3, taskRunsEnded: 3, tasksCreated: 2,
      tools: { requested: 5, approved: 4, denied: 1, started: 4, ended: 4 },
      verification: { started: 2, ended: 2, passed: 1, failed: 1 },
      recovery: { failuresDetected: 1, recoveryActions: 1, taskRetries: 1 },
      intervention: { approvalsRequested: 1, approvalsGranted: 1, approvalsDenied: 0, overrides: 0, controlActions: 0 },
      graphMutationsCommitted: 1, checkpointsCreated: 2, eventTypeCounts: [],
    };
    const vm = metricsToViewModel(m);
    expect(vm.events).toBe(42);
    expect(vm.span).toBe('1m5s');
    expect(vm.outcome).toBe('COMPLETED');
    expect(vm.tools).toBe('4/5');
    expect(vm.verifications).toContain('1✓');
    expect(vm.failures).toContain('1 retries');
  });
});
