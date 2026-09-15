// CrashInjector interface (C10) — PHASE_0_ACCEPTANCE §4.5, EVALUATION_MODEL §8.
//
// Phase 0 delivers only the INTERFACE (so crash-recovery tests can be written against it).
// The full implementation that actually injects faults into the runtime is Phase 1.

export type CrashPoint =
  | 'before-transition'
  | 'during-transition'
  | 'after-commit'
  | 'during-tool-call'
  | 'during-verification'
  | 'during-checkpoint'
  | 'during-migration';

export const CRASH_POINTS: readonly CrashPoint[] = [
  'before-transition',
  'during-transition',
  'after-commit',
  'during-tool-call',
  'during-verification',
  'during-checkpoint',
  'during-migration',
];

export interface CrashInjector {
  /** Register an action to run when execution reaches `point` (used to simulate a crash). */
  at(point: CrashPoint, action: () => void): void;
  /** List the crash points this injector supports. */
  list(): readonly CrashPoint[];
  /** Clear all registered injections. */
  reset(): void;
}

/**
 * A no-op CrashInjector for Phase 0: records registrations and points but never fires.
 * Phase 1 replaces this with a real injector wired into the runtime.
 */
export class NoopCrashInjector implements CrashInjector {
  private readonly registered = new Map<CrashPoint, () => void>();

  at(point: CrashPoint, action: () => void): void {
    this.registered.set(point, action);
  }

  list(): readonly CrashPoint[] {
    return CRASH_POINTS;
  }

  reset(): void {
    this.registered.clear();
  }

  /** Test helper: how many injections are currently registered. */
  get registeredCount(): number {
    return this.registered.size;
  }
}
