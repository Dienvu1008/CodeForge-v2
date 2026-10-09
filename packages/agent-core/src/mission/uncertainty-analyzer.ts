// UncertaintyAnalyzer — Phase 12 / Tier A (goal clarification groundwork). Deterministic
// assessment of HOW UNDER-SPECIFIED a goal is, from objective signals only (MI-005 spirit:
// same signals → same assessment). This fills the `uncertainty` field of a Mission with a real
// value instead of the previous hard-coded KNOWN, so the runtime (and later a clarification
// step) can tell a precise goal ("add isEven(n) returning true for even ints") from a vague one
// ("create a script that multiplies matrices" — no I/O, no acceptance, no verification).
//
// Pure: no I/O, no clock, no LLM. The returned openQuestions are the CONCRETE gaps detected,
// phrased as the questions a human (or a later LLM clarifier) would need answered. They are
// evidence/advisory — they never block or mutate anything by themselves.
import type { Uncertainty, UncertaintyLevel, MissionType } from '../domain/mission.js';
import type { MissionSignals } from './signals.js';
import type { AcceptanceCriterion } from '../domain/common.js';

// Vague filler phrases that signal the user has NOT pinned down the intent. English + Vietnamese
// (the product is used in both). Substring match on the lowercased goal text.
const VAGUE_PHRASES = [
  'something', 'some kind of', 'a script that', 'a program that', 'a tool that', 'a thing that',
  'help me', 'somehow', 'or something', 'etc', 'and so on', 'whatever', 'as needed', 'make it work',
  // Vietnamese
  'giúp tôi', 'giúp mình', 'gì đó', 'kiểu như', 'đại khái', 'làm sao đó', 'cho tôi một', 'tạo cho tôi',
];

// Concrete-specification nouns: their PRESENCE lowers uncertainty for build/feature goals
// (the user said something about I/O, format, or behavior). Absence (for such goals) raises it.
const SPEC_WORDS = [
  'input', 'output', 'argument', 'parameter', 'return', 'returns', 'format', 'print', 'prints',
  'read', 'write', 'file', 'stdin', 'stdout', 'api', 'endpoint', 'schema', 'field', 'column',
  'example', 'e.g', 'for example', 'should', 'must',
  // Vietnamese
  'đầu vào', 'đầu ra', 'tham số', 'trả về', 'in ra', 'định dạng', 'ví dụ',
];

// Mission types where a missing concrete spec is a strong ambiguity signal (the user is asking
// to BUILD something, so interface/behavior matters). READ-only / investigative types are exempt.
const BUILD_TYPES: ReadonlySet<MissionType> = new Set<MissionType>([
  'FEATURE', 'PROJECT', 'BUG_FIX', 'REFACTOR', 'MIGRATION', 'AUTOMATION', 'PERFORMANCE', 'TESTING',
]);

function countHits(text: string, words: readonly string[]): number {
  let n = 0;
  for (const w of words) if (text.includes(w)) n++;
  return n;
}

/**
 * Assess goal uncertainty deterministically.
 *
 * Signals (each adds a point of ambiguity):
 *   - no acceptance criteria on the goal (nothing to verify against) — the strongest signal;
 *   - a very short goal (few words) — too little to pin down;
 *   - vague filler phrases ("a script that…", "help me…", "gì đó");
 *   - for a BUILD-type goal: no concrete spec words (input/output/format/example/…).
 *
 * Score → level:  0 → KNOWN · 1 → INFERRED · 2 → UNKNOWN · ≥3 → UNKNOWN (capped).
 * RESEARCH goals are inherently exploratory → at least INFERRED.
 *
 * openQuestions enumerates the concrete gaps (for display + a later clarification step).
 */
export function assessUncertainty(
  signals: MissionSignals,
  missionType: MissionType,
  acceptanceCriteria: readonly AcceptanceCriterion[],
): Uncertainty {
  const text = signals.text;
  const openQuestions: string[] = [];
  let score = 0;

  if (acceptanceCriteria.length === 0) {
    score += 1;
    openQuestions.push('What does "done" look like — how should the result be verified (a test, an example, an expected output)?');
  }

  if (signals.wordCount <= 6) {
    score += 1;
    openQuestions.push('The goal is very short — can you describe the expected behavior in more detail?');
  }

  const vague = countHits(text, VAGUE_PHRASES);
  if (vague > 0) {
    score += 1;
    openQuestions.push('The goal uses open-ended wording — what specifically should it do?');
  }

  if (BUILD_TYPES.has(missionType) && countHits(text, SPEC_WORDS) === 0) {
    score += 1;
    openQuestions.push('What are the inputs and outputs (types, format, an example of input → expected output)?');
  }

  // RESEARCH is exploratory by nature: never fully KNOWN.
  if (missionType === 'RESEARCH' && score === 0) score = 1;

  let level: UncertaintyLevel;
  if (score <= 0) level = 'KNOWN';
  else if (score === 1) level = 'INFERRED';
  else level = 'UNKNOWN';

  return { level, openQuestions: openQuestions.slice().sort() };
}
