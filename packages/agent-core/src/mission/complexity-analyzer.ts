/*
 * Copyright 2026 DienVu (Dienvu1008)
 * SPDX-License-Identifier: Apache-2.0
 */

// ComplexityAnalyzer — Phase 12 (P12.2). Deterministic, multi-dimensional complexity scoring.
//
// Explicitly NOT "short prompt = simple, long prompt = complex" (§5). We score several objective
// dimensions, sum weighted points, and map the score to LOW/MEDIUM/HIGH/SYSTEM. Pure: same
// signals + same mission type → same assessment (MI-005). The confidence reflects how strong the
// signals are; an optional LLM advisory (clamped by the MissionGate) may nudge within one level.
import type { Complexity, ComplexityAssessment, MissionType } from '../domain/mission.js';
import type { MissionSignals } from './signals.js';

// Scope keywords that imply breadth (each distinct hit adds points).
const BREADTH_WORDS = [
  'subsystem', 'subsystems', 'module', 'modules', 'cross-module', 'end-to-end', 'system',
  'multiple', 'several', 'entire', 'whole', 'full', 'architecture', 'integration',
];
const EXTERNAL_WORDS = [
  'api', 'external', 'third-party', 'service', 'network', 'remote', 'cloud', 'webhook',
  // Common integration products imply an external integration even without the word "api".
  'telegram', 'github', 'slack', 'stripe', 'discord', 'twilio', 'oauth', 'notification', 'notifications',
];
const UNCERTAINTY_WORDS = ['unknown', 'unfamiliar', 'new framework', 'new technology', 'figure out', 'not sure', 'explore'];

/** Mission types that are inherently heavy regardless of wording. */
const HEAVY_TYPES: ReadonlySet<MissionType> = new Set(['PROJECT', 'MIGRATION', 'ARCHITECTURE', 'MULTI_REPOSITORY']);
/** Mission types that are inherently light unless signals say otherwise. */
const LIGHT_TYPES: ReadonlySet<MissionType> = new Set(['REFACTOR', 'DOCUMENTATION', 'TESTING']);

function countHits(text: string, words: readonly string[]): number {
  let n = 0;
  for (const w of words) if (text.includes(w)) n++;
  return n;
}

/**
 * Assess complexity deterministically from signals + mission type.
 *
 * Dimensions (each contributes points):
 *   - mission type (heavy types start high; light types start low)
 *   - target platform count (multi-platform adds)
 *   - multi-repository
 *   - breadth keywords (subsystem/module/system/…)
 *   - external integration keywords
 *   - technology uncertainty keywords
 *   - workspace size (large existing codebase adds a little)
 */
export function assessComplexity(signals: MissionSignals, missionType: MissionType): ComplexityAssessment {
  const reasons: string[] = [];
  let score = 0;

  // ── Structural change (P12.10): the dimension the old scorer was blind to. Each distinct
  // structural kind is worth 1 point (already deduplicated by kind in extractSignals, so synonyms
  // never stack), capped at +3. This is what tells us "extract a module / change a boundary /
  // touch all call sites" is real work — independent of the mission-type label.
  const structural = signals.structuralSignals;
  const structuralScore = Math.min(3, structural.length);
  if (structuralScore > 0) {
    score += structuralScore;
    reasons.push(`structural change (${[...structural].sort().join(', ')})`);
  }

  // ── File-span breadth from explicitly-named paths (P12.10). Naming several concrete files is
  // objective evidence of multi-file scope that prose length cannot fake. Capped at +2.
  if (signals.pathCount >= 3) { score += 2; reasons.push(`${signals.pathCount} file paths named`); }
  else if (signals.pathCount === 2) { score += 1; reasons.push('2 file paths named'); }

  // ── Mission-type baseline. Heavy types start high. Light types (REFACTOR/DOCUMENTATION/TESTING)
  // get a small discount ONLY when there is NO structural/multi-file evidence — a bare "rename X"
  // stays LOW, but "refactor: extract a module, update all imports, preserve behavior" is NOT
  // discounted into LOW just because its label is REFACTOR (task §6).
  const hasStructuralEvidence = structuralScore > 0 || signals.pathCount >= 2;
  if (HEAVY_TYPES.has(missionType)) {
    score += 4; reasons.push(`heavy mission type (${missionType})`);
  } else if (LIGHT_TYPES.has(missionType) && !hasStructuralEvidence) {
    score -= 1;
  }

  if (signals.platformCount >= 2) { score += 2; reasons.push(`${signals.platformCount} target platforms`); }
  else if (signals.platformCount === 1) { score += 1; }

  if (signals.multiRepo) { score += 2; reasons.push('multiple repositories'); }

  const breadth = countHits(signals.text, BREADTH_WORDS);
  if (breadth > 0) { score += Math.min(3, breadth); reasons.push(`breadth signals (${breadth})`); }

  const external = countHits(signals.text, EXTERNAL_WORDS);
  if (external > 0) { score += Math.min(2, external); reasons.push('external integration'); }

  const uncertainty = countHits(signals.text, UNCERTAINTY_WORDS);
  if (uncertainty > 0) { score += Math.min(2, uncertainty); reasons.push('technology uncertainty'); }

  const fileCount = signals.workspace?.fileCount ?? 0;
  if (fileCount >= 500) { score += 2; reasons.push('large existing codebase'); }
  else if (fileCount >= 100) { score += 1; }

  const langs = signals.workspace?.languages?.length ?? 0;
  if (langs >= 3) { score += 1; reasons.push('polyglot workspace'); }

  // Map score → level. Thresholds unchanged: a bare "rename X" (light type, no signals) is LOW;
  // "build a cross-platform app" (heavy type + platforms) is HIGH/SYSTEM. The new structural +
  // path-span points lift a structural refactor out of LOW into MEDIUM without touching the bands.
  let level: Complexity;
  if (score <= 1) level = 'LOW';
  else if (score <= 4) level = 'MEDIUM';
  else if (score <= 7) level = 'HIGH';
  else level = 'SYSTEM';

  if (reasons.length === 0) reasons.push('no breadth/platform/integration/uncertainty signals');

  // Confidence reflects classification CERTAINTY: high when the score sits clearly inside a band,
  // lower when it sits within 1 point of a threshold (a near-miss could reasonably fall either
  // way). Deterministic (a pure function of the score), not a constant pinned to the level.
  const confidence = thresholdDistance(score) <= 1 ? 0.6 : 0.85;

  return {
    level,
    confidence,
    reasons: [...reasons].sort(),
    usedAdvisory: false,
  };
}

/** Distance (in points) from `score` to the nearest band boundary (1/4/7). Pure. */
function thresholdDistance(score: number): number {
  const boundaries = [1, 4, 7];
  return Math.min(...boundaries.map((b) => Math.abs(score - b)));
}
