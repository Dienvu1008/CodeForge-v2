// VscodeControlMapper (P9.11) — PURE, OFFLINE-TESTABLE mapping layer between VS Code
// commands / webview messages and the ControlRequest shape the ObservabilityService
// expects. No `vscode` import here — this file uses only @codeforge/agent-core types, so
// it can be tested under the root vitest without the VS Code runtime. Enforces OB-006: a
// VS Code command produces the SAME ControlRequest shape as dashboard/Telegram.
import type { ControlRequest, ControlIntent, RuntimeProjection, SessionMetrics } from '@codeforge/agent-core';

// ── Command → ControlRequest mapping ────────────────────────────────────────

export type VscodeCommandId =
  | 'codeforge.pause'
  | 'codeforge.resume'
  | 'codeforge.cancel'
  | 'codeforge.checkpoint';

const COMMAND_TO_INTENT: Readonly<Record<VscodeCommandId, ControlIntent>> = {
  'codeforge.pause':      'pause',
  'codeforge.resume':     'resume',
  'codeforge.cancel':     'cancel',
  'codeforge.checkpoint': 'checkpoint',
};

export function isControlCommand(commandId: string): commandId is VscodeCommandId {
  return commandId in COMMAND_TO_INTENT;
}

/**
 * Map a VS Code command id to a ControlRequest. Pure: same inputs → same request.
 * surface = 'vscode' (OB-006: identical shape to dashboard/telegram; the surface is
 * audit-only and never changes admission).
 */
export function commandToControlRequest(
  commandId: VscodeCommandId,
  sessionId: string,
  userId = 'vscode-user',
): ControlRequest {
  return {
    intent: COMMAND_TO_INTENT[commandId],
    sessionId,
    requestedBy: { kind: 'user', id: userId, surface: 'vscode' },
  };
}

// ── Webview message → ControlRequest mapping ────────────────────────────────

export interface WebviewControlMessage {
  readonly type: 'control';
  readonly intent: ControlIntent;
  readonly sessionId: string;
  readonly toolCallId?: string;
  readonly taskId?: string;
  readonly reason?: string;
}

export interface WebviewConnectMessage {
  readonly type: 'connect';
  readonly runtimeUrl: string;
  readonly sessionId: string;
}

export type WebviewInboundMessage = WebviewControlMessage | WebviewConnectMessage;

export function webviewMessageToControlRequest(
  msg: WebviewControlMessage,
  userId = 'vscode-user',
): ControlRequest {
  return {
    intent: msg.intent,
    sessionId: msg.sessionId,
    requestedBy: { kind: 'user', id: userId, surface: 'vscode' },
    ...(msg.toolCallId !== undefined ? { toolCallId: msg.toolCallId } : {}),
    ...(msg.taskId !== undefined ? { taskId: msg.taskId } : {}),
    ...(msg.reason !== undefined ? { reason: msg.reason } : {}),
  };
}

// ── JSON response → view-model for the webview ─────────────────────────────

export interface StatusViewModel {
  readonly session: string;
  readonly state: string;
  readonly graph: string;
  readonly model: string;
  readonly taskSummary: string;
  readonly budgetPressure: string;
}

export function projectionToStatusViewModel(p: RuntimeProjection): StatusViewModel {
  return {
    session: p.sessionId,
    state: p.sessionState,
    graph: `v${p.graphVersion}`,
    model: p.model ?? '-',
    taskSummary: `${p.counts.total} tasks: ${p.counts.passed}✓ ${p.counts.active}● ${p.counts.blocked}⊘ ${p.counts.failed}✗`,
    budgetPressure: p.budget ? `${Math.round(p.budget.pressure * 100)}%` : '-',
  };
}

export interface MetricsViewModel {
  readonly events: number;
  readonly span: string;
  readonly outcome: string;
  readonly tools: string;
  readonly verifications: string;
  readonly failures: string;
}

export function metricsToViewModel(m: SessionMetrics): MetricsViewModel {
  const secs = Math.round(m.spanMs / 1000);
  return {
    events: m.eventCount,
    span: secs >= 60 ? `${Math.floor(secs / 60)}m${secs % 60}s` : `${secs}s`,
    outcome: m.outcome ?? 'in-progress',
    tools: `${m.tools.ended}/${m.tools.requested}`,
    verifications: `${m.verification.passed}✓ ${m.verification.failed}✗`,
    failures: `${m.recovery.failuresDetected} (${m.recovery.taskRetries} retries)`,
  };
}
