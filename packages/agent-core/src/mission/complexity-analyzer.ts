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

  if (HEAVY_TYPES.has(missionType)) { score += 4; reasons.push(`heavy mission type (${missionType})`); }
  else if (LIGHT_TYPES.has(missionType)) { score -= 1; }

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

  // Map score → level. Thresholds chosen so a bare "rename X" (light type, no signals) is LOW
  // and a "build a cross-platform app" (heavy type + platforms) is HIGH/SYSTEM.
  let level: Complexity;
  if (score <= 1) level = 'LOW';
  else if (score <= 4) level = 'MEDIUM';
  else if (score <= 7) level = 'HIGH';
  else level = 'SYSTEM';

  if (reasons.length === 0) reasons.push('no breadth/platform/integration/uncertainty signals');

  // Confidence: strong when signals are clearly one-sided; lower in the middle band.
  const confidence = level === 'LOW' || level === 'SYSTEM' ? 0.8 : 0.6;

  return {
    level,
    confidence,
    reasons: [...reasons].sort(),
    usedAdvisory: false,
  };
}
