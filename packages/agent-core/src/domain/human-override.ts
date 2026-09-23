// HumanOverride — DOMAIN_CONTRACTS §11 (implicit), VERIFICATION_PROTOCOL §11.
//
// A HUMAN_OVERRIDE_COMPLETED record marks that a user explicitly overrode the
// verification gate for a task. It:
//   - links to the original VerificationReport by ID (HI-004: never mutates it).
//   - carries a mandatory reason (HI-003: explicit marker).
//   - is append-only (immutable after creation).
//
// Tham chiếu: INVARIANTS.md → HI-003, HI-004.

/** The only override kind in Phase 1.5 (extensible in later phases). */
export type OverrideKind = 'HUMAN_OVERRIDE_COMPLETED';

export interface HumanOverride {
  readonly overrideId: string; // ULID

  readonly taskId: string;

  /**
   * Reference to the VerificationReport being overridden (HI-004: stored as
   * a reference only — the report itself is NEVER modified).
   */
  readonly verificationId: string;

  /** Mandatory human-readable justification (HI-003: explicit marker). */
  readonly reason: string;

  /** Who made the override decision (always 'user' in Phase 1.5). */
  readonly decidedBy: 'user';

  readonly decidedAt: string; // ISO 8601

  /**
   * Explicit kind tag (HI-003: must be marked unambiguously).
   * Always 'HUMAN_OVERRIDE_COMPLETED'.
   */
  readonly kind: OverrideKind;
}
