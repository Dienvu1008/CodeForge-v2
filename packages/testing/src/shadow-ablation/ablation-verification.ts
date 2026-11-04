/*
 * Copyright 2026 DienVu (Dienvu1008)
 * SPDX-License-Identifier: Apache-2.0
 */

// EP-VERIFY / EP-COMPLETION observers (design C10). SUBCLASSES of the Kernel's VerificationEngine
// and CompletionGate (no agent-core edit): the checks, the persisted report, the events and the
// completion rules all run in `super`. The ledger step for these entries is whatever the replay
// gateway last set, i.e. the step of the `done` that ended the run (Requirement 4.1).
//
//   enforce: record `allow|block` with the real status / gate reason and return the Kernel's result
//            unchanged (Requirement 4.2).
//   shadow:  `verify` returns an in-memory COPY of the report with `status: 'PASS'` (the persisted
//            report keeps the real status, so the gate still reads the truth); `canComplete`
//            returns `canComplete: true`. Each records `wouldBlock` with the real status / reason
//            when the Kernel would have stopped the promotion (Requirements 5.5, 5.6).
//
// A `super.verify` that throws produces no report to shadow: it is recorded as `block` and
// rethrown in both modes (the TaskExecutor treats it as non-fatal, the task stays VERIFYING).
import {
  CompletionGate,
  VerificationEngine,
  type CompletionCheck,
  type CompletionGateDeps,
  type VerificationEngineDeps,
  type VerificationReport,
  type VerificationScope,
  type VerifyRequest,
  type WorkspaceRevision,
} from '@codeforge/agent-core';
import { previewArgs, type DecisionLedger } from './decision-ledger.js';
import type { ArmMode } from './ablation-tool-gateway.js';

export interface AblationVerificationOptions {
  readonly mode: ArmMode;
  readonly ledger: DecisionLedger;
}

/** Reason recorded for an allowed completion (the Kernel's CompletionCheck carries none). */
export const COMPLETION_ALLOWED_REASON = 'completion_allowed';

function errorCode(err: unknown): string {
  if (err !== null && typeof err === 'object' && 'code' in err && typeof err.code === 'string') return err.code;
  return err instanceof Error ? err.name : 'UNKNOWN';
}

export class AblationVerificationEngine extends VerificationEngine {
  // Names deliberately differ from VerificationEngine's private members (`deps`, `schemaVersion`, ...).
  private readonly verifyMode: ArmMode;
  private readonly verifyLedger: DecisionLedger;

  constructor(deps: VerificationEngineDeps, opts: AblationVerificationOptions) {
    super(deps);
    this.verifyMode = opts.mode;
    this.verifyLedger = opts.ledger;
  }

  override async verify(request: VerifyRequest): Promise<VerificationReport> {
    let report: VerificationReport;
    try {
      report = await super.verify(request);
    } catch (err) {
      this.verifyLedger.record({
        tool: 'done',
        argsPreview: previewArgs({ taskId: request.taskId }),
        point: 'EP-VERIFY',
        decision: 'block',
        reason: `verify_failed:${errorCode(err)}`,
        effective: 'block',
        wouldBlock: false,
      });
      throw err;
    }

    const passed = report.status === 'PASS';
    const shadowed = !passed && this.verifyMode === 'shadow';
    this.verifyLedger.record({
      tool: 'done',
      argsPreview: previewArgs({ taskId: request.taskId, status: report.status }),
      point: 'EP-VERIFY',
      decision: passed ? 'allow' : 'block',
      reason: report.status,
      effective: passed || shadowed ? 'allow' : 'block',
      wouldBlock: shadowed,
    });
    // In-memory copy only: the repository already holds the real report.
    return shadowed ? { ...report, status: 'PASS' } : report;
  }
}

export class AblationCompletionGate extends CompletionGate {
  // Names deliberately differ from CompletionGate's private members (`deps`, `findBestReport`).
  private readonly gateMode: ArmMode;
  private readonly gateLedger: DecisionLedger;

  constructor(deps: CompletionGateDeps, opts: AblationVerificationOptions) {
    super(deps);
    this.gateMode = opts.mode;
    this.gateLedger = opts.ledger;
  }

  override async canComplete(
    taskId: string,
    currentRevision: WorkspaceRevision,
    requiredScope?: VerificationScope,
  ): Promise<CompletionCheck> {
    const check = await super.canComplete(taskId, currentRevision, requiredScope);
    const allowed = check.canComplete;
    const shadowed = !allowed && this.gateMode === 'shadow';
    this.gateLedger.record({
      tool: 'done',
      argsPreview: previewArgs({ taskId, requiredScope: check.requiredScope }),
      point: 'EP-COMPLETION',
      decision: allowed ? 'allow' : 'block',
      reason: allowed ? COMPLETION_ALLOWED_REASON : (check.reason ?? 'unknown'),
      effective: allowed || shadowed ? 'allow' : 'block',
      wouldBlock: shadowed,
    });
    return shadowed ? { ...check, canComplete: true } : check;
  }
}
