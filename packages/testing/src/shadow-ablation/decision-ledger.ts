/*
 * Copyright 2026 DienVu (Dienvu1008)
 * SPDX-License-Identifier: Apache-2.0
 */

// Decision ledger (design C4) — the single instrument every enforcement-point observer writes to,
// in BOTH arms. It holds no policy logic: observers compute the Kernel decision with the Kernel's
// own functions and hand the result here. The current step is advanced by the replay gateway
// (`setStep`) before each execute-purpose response, so downstream observers attribute their entries
// to the proposal being processed without TaskExecutor cooperation (Requirement 4.1).
//
// Tool arguments are stored only as a redacted, truncated preview (Requirement 10.8): never raw.
import { redactJson } from '@codeforge/infrastructure';

export type EnforcementPointId =
  | 'EP-TOOL-POLICY'
  | 'EP-APPROVAL'
  | 'EP-SCHEMA'
  | 'EP-PATH'
  | 'EP-SHELL'
  | 'EP-ENV'
  | 'EP-VERIFY'
  | 'EP-COMPLETION';

export type KernelDecision = 'allow' | 'require_approval' | 'block' | 'filter';

export type ProposalSource = 'organic' | 'injected';

export interface LedgerEntry {
  /** `ReplayStatus.steps` index of the proposal (-1 before the first proposal is served). */
  readonly step: number;
  readonly source: ProposalSource;
  readonly corpusId?: string;
  /** Tool name, or `'done'` for a completion proposal. */
  readonly tool: string;
  /** `previewArgs(args)`: secret keys + redactJson → JSON → truncated to 200 chars (+ `…`). */
  readonly argsPreview: string;
  readonly point: EnforcementPointId;
  readonly decision: KernelDecision;
  readonly reason: string;
  /** What governed the action in THIS arm. */
  readonly effective: 'allow' | 'block' | 'filter';
  /** Shadow arm: the Kernel decision would have stopped the action but it was let through. */
  readonly wouldBlock: boolean;
}

export interface ExecutedAction {
  readonly step: number;
  readonly tool: string;
  readonly argsPreview: string;
  readonly outcome: 'SUCCEEDED' | 'FAILED' | 'TIMEOUT';
  readonly effect: 'sandbox' | 'simulated' | 'none';
  /** Sandbox-relative paths (or simulated outside paths). */
  readonly touched: readonly string[];
}

export interface ContainmentEvent {
  readonly step: number;
  readonly kind: 'escape-simulated' | 'command-simulated' | 'kernelMiss';
  readonly op: string;
  readonly target: string;
  /** Content SHA-256 (hex) for simulated writes. */
  readonly sha256?: string;
}

export interface GuardEvent {
  readonly step: number;
  readonly guard: 'P12.11' | 'P12.13' | 'IDEMPOTENCY';
}

export interface LedgerSnapshot {
  entries: LedgerEntry[];
  executed: ExecutedAction[];
  containment: ContainmentEvent[];
  guards: GuardEvent[];
}

/** Maximum length of an argument preview before the ellipsis (Requirement 10.8). */
export const ARGS_PREVIEW_MAX = 200;

/** Same placeholder as the infrastructure redactor (`redaction/redactor.ts`). */
const REDACTED = '[REDACTED]';

/**
 * Object keys whose VALUE is a secret regardless of its shape. `redactJson` only matches secret
 * patterns inside strings, so `{"password":"hunter2"}` would otherwise pass through unchanged.
 */
const SECRET_KEY =
  /^(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|authorization|auth|credentials?|cookie|session[_-]?id|client[_-]?secret)$/i;

/** Deep copy with every value held under a secret-like key replaced by the placeholder. */
function redactSecretKeys(value: unknown, ancestors: Set<object> = new Set()): unknown {
  if (value === null || typeof value !== 'object') return value;
  // A true cycle is unserializable: bail out (previewArgs catches and returns its placeholder).
  // Only the current path is tracked, so a shared, non-cyclic reference is still redacted.
  if (ancestors.has(value)) throw new TypeError('cyclic arguments');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return value.map((v) => redactSecretKeys(v, ancestors));
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEY.test(k) ? REDACTED : redactSecretKeys(v, ancestors);
    }
    return out;
  } finally {
    ancestors.delete(value);
  }
}

/**
 * Redacted, truncated preview of tool arguments, shared by every observer and the report:
 * secret-like keys → placeholder, then `redactJson` (secret patterns in strings) → `JSON.stringify`
 * → at most {@link ARGS_PREVIEW_MAX} chars, then `…` if cut. Redaction happens BEFORE truncation
 * so a secret can never survive by being cut mid-pattern. Never throws: unserializable input
 * (cycles, BigInt) yields a fixed placeholder.
 */
export function previewArgs(args: unknown): string {
  let json: string | undefined;
  try {
    json = JSON.stringify(redactJson(redactSecretKeys(args)));
  } catch {
    return '[unserializable]';
  }
  if (json === undefined) return '';
  if (json.length <= ARGS_PREVIEW_MAX) return json;
  let cut = ARGS_PREVIEW_MAX;
  // Do not split a UTF-16 surrogate pair.
  const last = json.charCodeAt(cut - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut -= 1;
  return `${json.slice(0, cut)}…`;
}

export class DecisionLedger {
  private step = -1;
  private source: ProposalSource = 'organic';
  private corpusId: string | undefined;
  private readonly entries: LedgerEntry[] = [];
  private readonly actions: ExecutedAction[] = [];
  private readonly containment: ContainmentEvent[] = [];
  private readonly guards: GuardEvent[] = [];

  currentStep(): number {
    return this.step;
  }

  setStep(step: number, source: ProposalSource, corpusId?: string): void {
    this.step = step;
    this.source = source;
    this.corpusId = source === 'injected' ? corpusId : undefined;
  }

  record(e: Omit<LedgerEntry, 'step' | 'source' | 'corpusId'>): void {
    const entry: LedgerEntry = {
      ...e,
      step: this.step,
      source: this.source,
      ...(this.corpusId !== undefined ? { corpusId: this.corpusId } : {}),
    };
    this.entries.push(Object.freeze(entry));
  }

  executed(a: Omit<ExecutedAction, 'step'>): void {
    this.actions.push(Object.freeze({ ...a, touched: Object.freeze([...a.touched]), step: this.step }));
  }

  contained(c: Omit<ContainmentEvent, 'step'>): void {
    this.containment.push(Object.freeze({ ...c, step: this.step }));
  }

  guard(g: Omit<GuardEvent, 'step'>): void {
    this.guards.push(Object.freeze({ ...g, step: this.step }));
  }

  /** Copies of the recorded arrays, in recording order (entries themselves are frozen). */
  snapshot(): LedgerSnapshot {
    return {
      entries: [...this.entries],
      executed: [...this.actions],
      containment: [...this.containment],
      guards: [...this.guards],
    };
  }
}
