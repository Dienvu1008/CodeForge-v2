// ArchitectureGate — Phase 12 (P12.6). §16/§18. A PURE, deterministic gate that evaluates an
// architecture blueprint (an UNTRUSTED LLM proposal, SE-010) against the mission facts and the
// verified preflight report, and returns PASS or BLOCK.
//
// MI-007: the ArchitectureGate must BLOCK before planning when the architecture is not safe to
// act on — a required capability is not VERIFIED, there are unresolved critical open questions,
// or the mission's acceptance criteria are not covered. On BLOCK the caller stops and moves the
// session to AWAITING_HUMAN (the gate itself NEVER transitions state — it only returns a verdict).
//
// This mirrors the deterministic-clamp-over-LLM pattern: the model proposes, the gate decides.
// Pure + deterministic: same inputs → same result. No I/O, no clock.
import type {
  Architecture,
  ArchitectureGateResult,
  Mission,
  PreflightReport,
} from '../domain/mission.js';

/**
 * Evaluate an architecture blueprint. BLOCK (MI-007) when ANY of:
 *   1. A capability the architecture requires is not VERIFIED in the preflight report
 *      (LLM claims never satisfy this — only ProcessSupervisor evidence does, MI-003).
 *   2. The architecture leaves open questions AND the mission uncertainty is unresolved
 *      (UNKNOWN / CONFLICTING / BLOCKED) — the human must resolve the ambiguity first.
 *   3. The architecture provides no verification strategy, or (when the mission has explicit
 *      acceptance criteria) the architecture lists no requirements to trace against them.
 *
 * Otherwise PASS. Reasons are returned in both cases for provenance/observability.
 */
export function evaluateArchitecture(
  architecture: Architecture,
  mission: Mission,
  preflight: PreflightReport,
): ArchitectureGateResult {
  const blockers: string[] = [];
  const reasons: string[] = [];

  // ── 1. Required capabilities must be VERIFIED (MI-003/MI-007) ──────────────────
  const verified = new Set(
    [...preflight.machine, ...preflight.workspace]
      .filter((c) => c.status === 'VERIFIED')
      .map((c) => c.name),
  );
  // Union of capabilities named by the architecture itself and by its roadmap phases.
  const required = new Set<string>(architecture.requiredCapabilities);
  for (const phase of architecture.roadmap) {
    for (const cap of phase.requiresCapabilities) required.add(cap);
  }
  const missingCaps = [...required].filter((c) => !verified.has(c)).sort();
  if (missingCaps.length > 0) {
    for (const cap of missingCaps) {
      blockers.push(`required capability not VERIFIED: ${cap}`);
    }
  } else {
    reasons.push(
      required.size > 0
        ? `all ${required.size} required capability(ies) VERIFIED`
        : 'no capabilities required',
    );
  }

  // ── 2. Unresolved uncertainty + open questions → human must decide ─────────────
  const uncertain =
    mission.uncertainty.level === 'UNKNOWN' ||
    mission.uncertainty.level === 'CONFLICTING' ||
    mission.uncertainty.level === 'BLOCKED';
  if (uncertain && architecture.openQuestions.length > 0) {
    for (const q of architecture.openQuestions) {
      blockers.push(`unresolved open question (uncertainty=${mission.uncertainty.level}): ${q}`);
    }
  } else if (architecture.openQuestions.length > 0) {
    reasons.push(
      `${architecture.openQuestions.length} open question(s) noted but mission uncertainty is ${mission.uncertainty.level}`,
    );
  } else {
    reasons.push('no open questions');
  }

  // ── 3. Coverage: verification strategy + requirements vs acceptance ────────────
  if (architecture.verificationStrategy.length === 0) {
    blockers.push('architecture provides no verification strategy');
  } else {
    reasons.push(`verification strategy has ${architecture.verificationStrategy.length} step(s)`);
  }
  if (mission.acceptanceCriteria.length > 0 && architecture.requirements.length === 0) {
    blockers.push('mission has acceptance criteria but architecture lists no requirements to trace');
  }

  const verdict = blockers.length === 0 ? 'PASS' : 'BLOCK';
  return {
    verdict,
    blockers: blockers.slice().sort(),
    reasons: reasons.slice().sort(),
  };
}
