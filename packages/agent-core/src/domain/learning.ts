// Learning — Phase 11 (P11.2). Distilled "lessons" derived from run history.
//
// A Lesson is a STRUCTURED, append-only fact about how past runs behaved — e.g. "for
// failure class SYNTAX, action FIX succeeded 2/5 times". Lessons are EVIDENCE, never
// authority (LE-001): downstream advisors read them and propose, but an AdviceGate
// (P11.3) clamps every proposal into an already-deterministic decision.
//
// LE-008 (no secret leak): a Lesson carries ONLY classification fields (failure class,
// recovery kind/outcome counts, normalized signatures, counts). It never stores raw
// payloads, evidence messages, stderr, file contents, or free-text model output. The
// `payload` union below is a closed set of structured shapes — there is no free-text field.
//
// The store/query contract lives here in agent-core (domain); the SQLite implementation
// lives in infrastructure — the same layering as MemoryStore (Phase 7).
import type { Provenance } from './provenance.js';
import type { FailureClass, RecoveryKind } from './failure.js';

// ── Lesson kinds + payloads ─────────────────────────────────────────────────────

export type LessonKind = 'recovery_outcome' | 'failure_recurrence';

/** Scope a lesson applies to. Mirrors MemoryScope for consistency. */
export type LessonScope = 'project' | 'session' | 'global';

/**
 * "For failure class C, recovery action A reached these terminal outcomes." The core
 * signal the RecoveryAdvisor (P11.4) reads. All fields are classification/counts only.
 */
export interface RecoveryOutcomeLesson {
  readonly kind: 'recovery_outcome';
  readonly failureClass: FailureClass;
  readonly action: RecoveryKind;
  readonly total: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly aborted: number;
}

/**
 * "This normalized failure signature recurred N times (class C)." Signature is already a
 * normalized hash (Failure.signature) — safe to store.
 */
export interface FailureRecurrenceLesson {
  readonly kind: 'failure_recurrence';
  readonly signature: string;
  readonly failureClass: FailureClass;
  readonly count: number;
}

/** Closed union of lesson payloads. No free-text member exists (LE-008). */
export type LessonPayload = RecoveryOutcomeLesson | FailureRecurrenceLesson;

// ── Record ──────────────────────────────────────────────────────────────────────

export interface Lesson {
  readonly lessonId:   string;        // ULID
  readonly kind:       LessonKind;
  readonly scope:      LessonScope;
  /**
   * Deterministic de-duplication key within (scope, kind). Two distillations of the same
   * underlying fact share a key; the store keeps them append-only but a reader can collapse
   * by key + recency. Derived purely from the payload's classification fields.
   */
  readonly key:        string;
  readonly payload:    LessonPayload;
  readonly provenance: Provenance;    // which sessions/runs produced it + reason + at (LE-005)
  readonly createdAt:  string;        // ISO 8601
}

// ── Query ─────────────────────────────────────────────────────────────────────

export interface LessonQuery {
  readonly scope?: LessonScope;
  readonly kinds?: readonly LessonKind[];
  readonly limit:  number;
}

// ── Store ──────────────────────────────────────────────────────────────────────

/**
 * Persistence contract for lessons. Append-only: no update or delete-by-id (LE-005).
 * Retention/eviction is a write-path concern handled by LessonWriter (LE-006), not the
 * store — the store only executes the evictOldest primitive. Mirrors MemoryStore so the
 * SQLite adapter and the layering stay identical to Phase 7.
 */
export interface LearningStore {
  /** Append a lesson. Fails if lessonId already exists (append-only identity). */
  insert(lesson: Lesson): Promise<void>;

  /** Retrieve lessons matching the filter, deterministically ordered (recency desc, id asc). */
  query(query: LessonQuery): Promise<readonly Lesson[]>;

  /** Count lessons in a (scope, kind) bucket — used by LessonWriter for retention. */
  count(scope: LessonScope, kind: LessonKind): Promise<number>;

  /**
   * Retention primitive: delete all but the newest `keep` lessons in a (scope, kind)
   * bucket, by the same deterministic order as query(). Returns the number evicted. The
   * store only executes this; the WHEN/HOW-MANY policy lives in LessonWriter (LE-006).
   * This is the only non-insert mutation — lessons are never updated (LE-005).
   */
  evictOldest(scope: LessonScope, kind: LessonKind, keep: number): Promise<number>;
}

// ── Key derivation (pure, deterministic) ────────────────────────────────────────

/**
 * Deterministic de-duplication key for a lesson payload. Same classification fields →
 * same key, independent of counts (counts are the mutable part a newer lesson supersedes).
 */
export function lessonKey(payload: LessonPayload): string {
  switch (payload.kind) {
    case 'recovery_outcome':
      return `recovery_outcome\u0001${payload.failureClass}\u0001${payload.action}`;
    case 'failure_recurrence':
      return `failure_recurrence\u0001${payload.signature}`;
  }
}
