/*
 * Copyright 2026 DienVu (Dienvu1008)
 * SPDX-License-Identifier: Apache-2.0
 */

// EP-APPROVAL coordinators (design C7/C8). Both implement the Kernel's ApprovalCoordinator port and
// resolve the call through the Kernel's own `ToolGateway.approve` / `ToolGateway.deny`, so the
// Approval row, binding (TG-003) and events are the Kernel's. They live in the arm's `:memory:`
// database and are discarded with it.
//
//   ShadowApprovalCoordinator   — shadow arm only: records `wouldBlock: approval_required` and
//                                 approves with `decidedBy: 'policy'` (Requirement 5.2).
//   DenyAllApprovalCoordinator  — enforce arm with `approvalResolution: 'deny'`: models a human who
//                                 denies every request; records EP-APPROVAL `block`.
//
// `awaitDecision` must not throw (ApprovalCoordinator contract): a gateway error is recorded and
// surfaces as `'denied'` so the TaskExecutor treats it as a non-fatal, non-executed call.
import type { ApprovalCoordinator, ApprovalDecision, ToolCall, ToolGateway } from '@codeforge/agent-core';
import { previewArgs, type DecisionLedger } from './decision-ledger.js';
import { approvalBlockReason, type ApprovalResolution } from './ablation-tool-gateway.js';

function errorCode(err: unknown): string {
  if (err !== null && typeof err === 'object' && 'code' in err && typeof err.code === 'string') return err.code;
  return err instanceof Error ? err.name : 'UNKNOWN';
}

function recordFailure(ledger: DecisionLedger, toolCallId: string, err: unknown): void {
  ledger.record({
    tool: 'unknown',
    argsPreview: previewArgs({ toolCallId }),
    point: 'EP-APPROVAL',
    decision: 'block',
    reason: `approval_resolution_failed:${errorCode(err)}`,
    effective: 'block',
    wouldBlock: false,
  });
}

export class ShadowApprovalCoordinator implements ApprovalCoordinator {
  /**
   * @param gateway    lazy accessor (the gateway and the TaskExecutor deps are built together).
   * @param resolution the enforce arm's approval model; kept for the report, the shadow arm
   *                   always approves.
   */
  constructor(
    private readonly gateway: () => ToolGateway,
    private readonly ledger: DecisionLedger,
    readonly resolution: ApprovalResolution,
  ) {}

  async awaitDecision(_sessionId: string, toolCallId: string): Promise<ApprovalDecision> {
    let approved: ToolCall;
    try {
      approved = await this.gateway().approve(toolCallId, 'policy');
    } catch (err) {
      recordFailure(this.ledger, toolCallId, err);
      return 'denied';
    }
    this.ledger.record({
      tool: approved.toolName,
      argsPreview: previewArgs(approved.arguments),
      point: 'EP-APPROVAL',
      decision: 'block',
      reason: 'approval_required',
      effective: 'allow',
      wouldBlock: true,
    });
    return 'approved';
  }
}

export class DenyAllApprovalCoordinator implements ApprovalCoordinator {
  constructor(
    private readonly gateway: () => ToolGateway,
    private readonly ledger: DecisionLedger,
  ) {}

  async awaitDecision(_sessionId: string, toolCallId: string): Promise<ApprovalDecision> {
    const reason = approvalBlockReason('deny');
    let denied: ToolCall;
    try {
      denied = await this.gateway().deny(toolCallId, 'policy', reason);
    } catch (err) {
      recordFailure(this.ledger, toolCallId, err);
      return 'denied';
    }
    this.ledger.record({
      tool: denied.toolName,
      argsPreview: previewArgs(denied.arguments),
      point: 'EP-APPROVAL',
      decision: 'block',
      reason,
      effective: 'block',
      wouldBlock: false,
    });
    return 'denied';
  }
}
