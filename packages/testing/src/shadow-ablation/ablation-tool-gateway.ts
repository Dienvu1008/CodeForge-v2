/*
 * Copyright 2026 DienVu (Dienvu1008)
 * SPDX-License-Identifier: Apache-2.0
 */

// AblationToolGateway (design C7) — EP-TOOL-POLICY, EP-SCHEMA and the pass-policy half of
// EP-APPROVAL. A SUBCLASS of the Kernel's ToolGateway (no agent-core edit): the schema check, the
// state machine, persistence and events all run in `super.request`. The ledger's Kernel decision is
// computed with the Kernel's own `determineAction` against the ENFORCED policy; the TG-007/SE-009
// hard overrides (DESTRUCTIVE never auto-approves, PRIVILEGED always denied) live inside
// `determineAction`, so they are part of that decision with no re-implementation (Requirement 4.3).
//
//   enforce: super is built with the enforced policy; the entry is read from the returned state
//            (DENIED → block, APPROVAL_PENDING → require_approval, APPROVED → allow). Behavior is
//            exactly the Kernel's (Requirement 4.2).
//   shadow:  super is built with SHADOW_PASS_POLICY; the entry carries the enforced-policy decision
//            and `wouldBlock` when that decision would have stopped the call but it went through
//            (Requirement 5.1). A `require_approval` call the pass policy auto-approved also gets the
//            EP-APPROVAL entry the enforce arm would have hit (DESTRUCTIVE is still APPROVAL_PENDING
//            because of TG-007 and is recorded by ShadowApprovalCoordinator instead).
//
// Schema failures are never shadowed (the call cannot be represented): recorded and rethrown in
// both modes. Without wired schemas EP-SCHEMA is recorded once as inactive (Requirement 4.5).
import {
  ToolGateway,
  ToolGatewayError,
  determineAction,
  type PolicyAction,
  type ToolCall,
  type ToolGatewayDeps,
  type ToolPolicy,
} from '@codeforge/agent-core';
import { previewArgs, type DecisionLedger, type KernelDecision } from './decision-ledger.js';

/**
 * Pass policy used only by the shadow arm's gateway: every risk class `allow`, default `allow`.
 * `determineAction` still coerces DESTRUCTIVE → `require_approval` and PRIVILEGED → `deny`
 * (TG-007/SE-009 cannot be configured away), which is intended: the Kernel stays the Kernel.
 */
export const SHADOW_PASS_POLICY: ToolPolicy = Object.freeze({
  policyId: 'shadow-pass-v1',
  version: 1,
  rules: Object.freeze([
    { toolName: '*', riskClass: 'READ_ONLY', action: 'allow' },
    { toolName: '*', riskClass: 'LOW_RISK', action: 'allow' },
    { toolName: '*', riskClass: 'MODIFY_WORKSPACE', action: 'allow' },
    { toolName: '*', riskClass: 'NETWORK', action: 'allow' },
    { toolName: '*', riskClass: 'PACKAGE_INSTALL', action: 'allow' },
    { toolName: '*', riskClass: 'SYSTEM', action: 'allow' },
    { toolName: '*', riskClass: 'DESTRUCTIVE', action: 'allow' },
    { toolName: '*', riskClass: 'PRIVILEGED', action: 'allow' },
  ] as const),
  defaultAction: 'allow',
});

export type ArmMode = 'enforce' | 'shadow';
export type ApprovalResolution = 'none' | 'deny';

export interface AblationToolGatewayOptions {
  readonly mode: ArmMode;
  /** `buildToolPolicy(trace.wiring.autonomy)` — the policy the enforce arm runs with. */
  readonly enforcedPolicy: ToolPolicy;
  /** Enforce-arm model of the absent human: no coordinator (`none`) or deny-all (`deny`). */
  readonly approvalResolution: ApprovalResolution;
  readonly ledger: DecisionLedger;
}

/** Reason recorded for the EP-APPROVAL entry the enforce arm would have produced. */
export function approvalBlockReason(resolution: ApprovalResolution): string {
  return resolution === 'deny' ? 'simulated_human_denied' : 'no_approval_coordinator';
}

function toKernelDecision(action: PolicyAction): KernelDecision {
  return action === 'deny' ? 'block' : action;
}

function decisionFromState(state: ToolCall['state']): KernelDecision {
  if (state === 'DENIED') return 'block';
  if (state === 'APPROVAL_PENDING') return 'require_approval';
  return 'allow';
}

export class AblationToolGateway extends ToolGateway {
  // Names deliberately differ from ToolGateway's private members (`policy`, `deps`, ...).
  private readonly ablation: AblationToolGatewayOptions;
  private readonly schemasWired: boolean;
  private readonly schemaRegistry: ToolGatewayDeps['schemas'];
  private schemaInactiveRecorded = false;

  constructor(deps: ToolGatewayDeps, opts: AblationToolGatewayOptions) {
    super({ ...deps, policy: opts.mode === 'enforce' ? opts.enforcedPolicy : SHADOW_PASS_POLICY });
    this.ablation = opts;
    this.schemaRegistry = deps.schemas;
    this.schemasWired = deps.schemas !== undefined && Object.keys(deps.schemas).length > 0;
  }

  get mode(): ArmMode {
    return this.ablation.mode;
  }

  /** `inactive` when the wiring passes no argument schemas (Requirement 4.5). */
  get schemaCheck(): 'active' | 'inactive' {
    return this.schemasWired ? 'active' : 'inactive';
  }

  override async request(call: ToolCall): Promise<ToolCall> {
    const { ledger, mode, enforcedPolicy } = this.ablation;
    const tool = call.toolName;
    const argsPreview = previewArgs(call.arguments);

    // Kernel decision under the ENFORCED policy (TG-007/SE-009 overrides included).
    const kernelAction = determineAction(call.toolName, call.riskClass, enforcedPolicy);
    const kernel = toKernelDecision(kernelAction);

    if (!this.schemasWired && !this.schemaInactiveRecorded) {
      this.schemaInactiveRecorded = true;
      ledger.record({
        tool, argsPreview, point: 'EP-SCHEMA', decision: 'allow',
        reason: 'inactive: no argument schemas wired', effective: 'allow', wouldBlock: false,
      });
    }

    let result: ToolCall;
    try {
      result = await super.request(call);
    } catch (err) {
      if (err instanceof ToolGatewayError && err.code === 'SCHEMA_VALIDATION_FAILED') {
        ledger.record({
          tool, argsPreview, point: 'EP-SCHEMA', decision: 'block',
          reason: 'SCHEMA_VALIDATION_FAILED', effective: 'block', wouldBlock: false,
        });
      }
      throw err;
    }

    if (this.schemaRegistry?.[call.toolName] !== undefined) {
      ledger.record({
        tool, argsPreview, point: 'EP-SCHEMA', decision: 'allow',
        reason: 'schema_valid', effective: 'allow', wouldBlock: false,
      });
    }

    const policyReason = `${enforcedPolicy.policyId}:${call.riskClass}:${kernelAction}`;

    if (mode === 'enforce') {
      // The gateway ran the enforced policy, so the returned state IS the Kernel decision.
      const decision = decisionFromState(result.state);
      ledger.record({
        tool, argsPreview, point: 'EP-TOOL-POLICY', decision, reason: policyReason,
        // require_approval: no coordinator ends the run, deny-all denies it — blocked either way.
        effective: decision === 'allow' ? 'allow' : 'block',
        wouldBlock: false,
      });
      return result;
    }

    // Shadow: the pass policy decided; only a TG-007/SE-009 override can still stop the call
    // here (PRIVILEGED → DENIED). APPROVAL_PENDING proceeds via ShadowApprovalCoordinator.
    const effective = result.state === 'DENIED' ? 'block' : 'allow';
    ledger.record({
      tool, argsPreview, point: 'EP-TOOL-POLICY', decision: kernel, reason: policyReason,
      effective,
      wouldBlock: kernel !== 'allow' && effective === 'allow',
    });

    if (kernel === 'require_approval' && result.state === 'APPROVED') {
      ledger.record({
        tool, argsPreview, point: 'EP-APPROVAL', decision: 'block',
        reason: approvalBlockReason(this.ablation.approvalResolution),
        effective: 'allow', wouldBlock: true,
      });
    }
    return result;
  }
}
