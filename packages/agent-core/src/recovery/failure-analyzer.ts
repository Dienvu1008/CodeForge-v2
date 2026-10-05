// FailureAnalyzer — P5-FA1. Builds a Failure record from observable signals.
//
// Orchestrates:
//   1. classifyFailure() → FailureClass (deterministic, RC-001).
//   2. Build signature (canonical hash for dedup).
//   3. Persist via FailureRepository.
//   4. Emit FAILURE_DETECTED event.
//
// classifiedBy='deterministic' — no LLM call in this path.
// A future LLM-based re-classifier can update the record (classifiedBy='analyzer').
import type { Failure } from '../domain/failure.js';
import type { VerificationReport } from '../domain/verification.js';
import type { TaskRun } from '../domain/task.js';
import type { DomainEvent, EventType } from '../domain/event.js';
import type { EventLog, FailureRepository } from '../repositories/index.js';
import { classifyFailure } from './failure-classifier.js';
import { createHash } from 'node:crypto';

// ── FailureAnalyzerDeps ───────────────────────────────────────────────────────

export interface FailureAnalyzerDeps {
  readonly failures: FailureRepository;
  readonly events:   EventLog;
  readonly now:      () => string;
  readonly nextId:   () => string;
}

// ── AnalyzeInput ──────────────────────────────────────────────────────────────

export interface AnalyzeInput {
  readonly sessionId:          string;
  readonly taskRun:            TaskRun;
  /**
   * Most recent VerificationReport for this run (undefined if verification
   * did not run or was skipped).
   */
  readonly verificationReport?: VerificationReport | undefined;
  /**
   * Raw stderr text from the last tool call — used for keyword classification.
   * Sourced from ArtifactStore in production; empty string when unavailable.
   */
  readonly lastStderr?: string | undefined;
}

// ── FailureAnalyzer ───────────────────────────────────────────────────────────

export class FailureAnalyzer {
  constructor(private readonly deps: FailureAnalyzerDeps) {}

  /**
   * Analyze a failed/timed-out TaskRun, create a Failure record, and emit
   * FAILURE_DETECTED. Returns the persisted Failure.
   *
   * RC-001: class is in the defined FailureClass union.
   * RC-006: provenance (classifiedBy, detectedAt, evidence) always recorded.
   */
  async analyze(input: AnalyzeInput): Promise<Failure> {
    const { sessionId, taskRun, verificationReport, lastStderr = '' } = input;

    // 1. Deterministic classification (RC-001, RC-003).
    const failureClass = classifyFailure({
      taskRunState:       taskRun.state,
      verificationReport,
      lastStderr,
    });

    // 2. Build signature (canonical hash for deduplication across retries).
    const signature = buildSignature(taskRun.taskId, failureClass, lastStderr);

    // 3. Collect evidence.
    const evidence = {
      message: buildMessage(failureClass, taskRun.state, verificationReport),
      ...(lastStderr                                      ? { stackTrace: lastStderr.slice(0, 2000) } : {}),
      ...(taskRun.state === 'TIMEOUT'                     ? { exitCode: -1 } : {}),
      ...(verificationReport?.verificationId !== undefined ? { contextSnapshotId: verificationReport.verificationId } : {}),
    };

    // 4. Build and persist Failure record (RC-006: provenance fields always set).
    const failure: Failure = {
      failureId:          this.deps.nextId(),
      sessionId,
      taskId:             taskRun.taskId,
      taskRunId:          taskRun.taskRunId,
      stage:              'verify',
      class:              failureClass,
      signature,
      evidence,
      detectedAt:         this.deps.now(),
      classifiedBy:       'deterministic',
      recoveryActionIds:  [],
    };

    await this.deps.failures.create(failure);

    // 5. Emit domain event.
    await this.emitFailureDetected(failure);

    return failure;
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  private async emitFailureDetected(failure: Failure): Promise<void> {
    const event: DomainEvent = {
      eventId:        this.deps.nextId(),
      sessionId:      failure.sessionId,
      type:           'TASK_FAILED' as EventType,
      aggregate:      { kind: 'task', id: failure.taskId },
      payload:        { failureId: failure.failureId, class: failure.class, stage: failure.stage },
      at:             failure.detectedAt,
      sequenceNumber: 0,
    };
    await this.deps.events.append(event);
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────

function buildSignature(taskId: string, failureClass: string, stderr: string): string {
  // Normalise stderr: keep first 200 chars, strip line numbers, trim whitespace.
  const normalised = stderr
    .slice(0, 200)
    .replace(/:\d+:\d+/g, ':?:?') // strip line:col numbers
    .replace(/\s+/g, ' ')
    .trim();
  const raw = `${taskId}|${failureClass}|${normalised}`;
  return createHash('sha256').update(raw, 'utf8').digest('hex').slice(0, 16);
}

function buildMessage(
  failureClass: string,
  runState: string,
  report?: VerificationReport,
): string {
  if (runState === 'TIMEOUT') return 'TaskRun timed out';
  if (report !== undefined) {
    const failedChecks = report.checks
      .filter((c) => c.status === 'FAIL' || c.status === 'ERROR')
      .map((c) => c.name)
      .join(', ');
    if (failedChecks) return `Verification failed — checks: ${failedChecks}`;
    if (report.status === 'INVALID') return 'Workspace mutated during verification (INVALID)';
  }
  return `Task failed with class ${failureClass}`;
}