// Learning module — Phase 11 (Intelligence Plane / self-model / learning).
//
// Everything here is ADVISORY and holds NO runtime authority (LE-001). The SelfModel is a
// read-only, deterministic projection of run history (LE-004); downstream advisors (P11.4+)
// feed proposals through a deterministic AdviceGate before any policy may consider them.
//
// P11.1: SelfModel + SelfModelBuilder (read-only projection).
export { SelfModelBuilder, type SelfModelInput } from './self-model-builder.js';
// P11.2: LessonWriter + distill (bounded, provenance; writes to a LearningStore).
export {
  LessonWriter,
  distill,
  DEFAULT_LESSON_RETENTION,
  type LessonWriterDeps,
  type LessonRetentionPolicy,
} from './lesson-writer.js';
