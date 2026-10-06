// InterventionRecord (P9.9) — a unified, auditable record of a human/control
// intervention (pause/resume/cancel/approve/deny/retry/checkpoint). Enforces OB-006.
//
// Pure builder: buildInterventionRecord() turns a ControlRequest + the ControlPlane's
// admission decision + the eventual outcome into one immutable record (who / what / when
// / why / target / result / policy + request identity). It performs no I/O and grants no
// authority — it only documents an intervention that already went through
// ControlPlane.admit(). Adapters persist it (e.g. to the event log) for replay/audit.
import type {
  ControlRequest,
  ControlIntent,
  ControlActor,
  AdmissionResult,
  ControlRejectReason,
} from './control-plane.js';

// ── Types ───────────────────────────────────────────────────────────────────

export type InterventionResult =
  | 'admitted'   // ControlPlane admitted the request (the action will be / was performed)
  | 'rejected'   // ControlPlane rejected it (no action)
  | 'applied'    // the admitted action was executed against the kernel
  | 'failed';    // the admitted action was attempted but the kernel call failed

export interface InterventionRecord {
  readonly interventionId: string;
  readonly sessionId: string;
  readonly intent: ControlIntent;
  /** Who requested it, including the surface (audit only). */
  readonly actor: ControlActor;
  /** When the intervention was recorded (ISO). */
  readonly at: string;
  /** Target identifiers carried from the request (tool call / task), when present. */
  readonly toolCallId?: string;
  readonly taskId?: string;
  /** Outcome of the intervention. */
  readonly result: InterventionResult;
  /** Rejection reason, when result is 'rejected'. */
  readonly rejectReason?: ControlRejectReason;
  /** Free-form reason supplied with the request (e.g. deny reason), redacted upstream. */
  readonly reason?: string;
}

export interface BuildInterventionInput {
  readonly interventionId: string;
  readonly request: ControlRequest;
  readonly admission: AdmissionResult;
  readonly at: string;
  /**
   * The execution outcome AFTER an admitted action was attempted by the adapter:
   * 'applied' (succeeded) or 'failed'. Omit when the action has not been executed yet
   * (then an admitted request records result 'admitted').
   */
  readonly executionOutcome?: 'applied' | 'failed';
}

// ── buildInterventionRecord ────────────────────────────────────────────────────

/**
 * Build an immutable intervention record. Pure + total: same input → same record.
 * A rejected admission records 'rejected' + its reason and never carries an execution
 * outcome; an admitted one records 'admitted', or the supplied 'applied'/'failed'.
 */
export function buildInterventionRecord(input: BuildInterventionInput): InterventionRecord {
  const { request: req, admission } = input;

  const result: InterventionResult = admission.admitted
    ? (input.executionOutcome ?? 'admitted')
    : 'rejected';

  return {
    interventionId: input.interventionId,
    sessionId: req.sessionId,
    intent: req.intent,
    actor: req.requestedBy,
    at: input.at,
    ...(req.toolCallId !== undefined ? { toolCallId: req.toolCallId } : {}),
    ...(req.taskId !== undefined ? { taskId: req.taskId } : {}),
    result,
    ...(admission.admitted ? {} : { rejectReason: admission.reason }),
    ...(req.reason !== undefined ? { reason: req.reason } : {}),
  };
}
