// LessonWriter — Phase 11 (P11.2). Distills lessons from a SelfModel and persists them
// with provenance (LE-005), enforcing a bounded retention policy (LE-006).
//
// Mirrors MemoryWriter (Phase 7): persistence goes through the LearningStore interface, so
// this writer lives in agent-core and does not depend on the infrastructure SQLite layer.
// Retention is enforced ONLY here (write-path); the store merely executes evictOldest.
//
// Determinism: distill() is a pure function of the SelfModel — it produces the same ordered
// list of lesson payloads for the same model. write-time only adds ids/timestamps/provenance
// via injected deps (no wall-clock, no randomness baked in).
//
// LE-008: lessons are built ONLY from the SelfModel's classification stats, which already
// contain no secrets (see SelfModelBuilder). The writer never reads raw events/evidence.
import type {
  LearningStore,
  Lesson,
  LessonPayload,
  LessonScope,
  LessonKind,
} from '../domain/learning.js';
import { lessonKey } from '../domain/learning.js';
import type { SelfModel } from '../domain/self-model.js';
import type { Provenance, ProvenanceSourceKind } from '../domain/provenance.js';

// ── Config ───────────────────────────────────────────────────────────────────

export interface LessonRetentionPolicy {
  /** Max lessons kept per (scope, kind) bucket. Oldest beyond this are evicted. */
  readonly maxPerScopeKind: number;
}

/** v1 default: max-count per (scope, kind), mirroring Phase 7 memory retention. */
export const DEFAULT_LESSON_RETENTION: LessonRetentionPolicy = {
  maxPerScopeKind: 200,
};

export interface LessonWriterDeps {
  readonly store:  LearningStore;
  readonly now:    () => string;
  readonly nextId: () => string;
  readonly retention?: LessonRetentionPolicy;
}

// ── Distilled payload (pure) ────────────────────────────────────────────────────

/**
 * Pure, deterministic distillation of a SelfModel into lesson payloads. Independent of the
 * writer's side effects; exported for testing and reuse. Output is in a stable order
 * (recovery outcomes by (class, action), then recurring signatures by count desc).
 */
export function distill(model: SelfModel): readonly LessonPayload[] {
  const payloads: LessonPayload[] = [];

  for (const r of model.recoveryOutcomes) {
    payloads.push({
      kind: 'recovery_outcome',
      failureClass: r.failureClass,
      action: r.action,
      total: r.total,
      succeeded: r.succeeded,
      failed: r.failed,
      aborted: r.aborted,
    });
  }

  // Only persist signatures that actually RECURRED (count > 1) — a one-off signature is not
  // yet a "lesson". This keeps the store focused and bounded.
  for (const s of model.failureSignatures) {
    if (s.count > 1) {
      payloads.push({
        kind: 'failure_recurrence',
        signature: s.signature,
        failureClass: s.failureClass,
        count: s.count,
      });
    }
  }

  return payloads;
}

// ── LessonWriter ────────────────────────────────────────────────────────────────

export class LessonWriter {
  private readonly retention: LessonRetentionPolicy;

  constructor(private readonly deps: LessonWriterDeps) {
    this.retention = deps.retention ?? DEFAULT_LESSON_RETENTION;
  }

  /**
   * Distill `model` into lessons and append them at `scope`, then enforce the retention
   * bound per (scope, kind). Returns the lessons written. `sourceSessionIds` (defaults to
   * the model's own sessionIds) is recorded in provenance (LE-005). Idempotent only in the
   * sense that it is safe to call repeatedly — the store is append-only, so repeated calls
   * append newer snapshots which supersede older ones by (key, recency).
   */
  async writeFromModel(
    model: SelfModel,
    scope: LessonScope = 'project',
    source?: { readonly kind: ProvenanceSourceKind; readonly id: string },
  ): Promise<readonly Lesson[]> {
    const payloads = distill(model);
    const written: Lesson[] = [];
    const touchedKinds = new Set<LessonKind>();

    for (const payload of payloads) {
      const at = this.deps.now();
      const provenance: Provenance = {
        provenanceId: this.deps.nextId(),
        source: source ?? { kind: 'runtime', id: 'lesson-writer' },
        // Reference the sessions this lesson was distilled from (LE-005 traceability).
        inputs: [...model.sessionIds],
        reason: `distilled ${payload.kind} from ${model.sessionIds.length} session(s)`,
        at,
      };
      const lesson: Lesson = {
        lessonId: this.deps.nextId(),
        kind: payload.kind,
        scope,
        key: lessonKey(payload),
        payload,
        provenance,
        createdAt: at,
      };
      await this.deps.store.insert(lesson);
      written.push(lesson);
      touchedKinds.add(payload.kind);
    }

    // Enforce retention for every (scope, kind) bucket we touched.
    for (const kind of touchedKinds) {
      await this.enforceRetention(scope, kind);
    }

    return written;
  }

  /**
   * Evict lessons beyond the retention bound for a (scope, kind) bucket (LE-006). Idempotent:
   * a no-op when the bucket is already within bounds. Also exposed for explicit maintenance.
   */
  async enforceRetention(scope: LessonScope, kind: LessonKind): Promise<number> {
    const count = await this.deps.store.count(scope, kind);
    if (count <= this.retention.maxPerScopeKind) return 0;
    return this.deps.store.evictOldest(scope, kind, this.retention.maxPerScopeKind);
  }
}
