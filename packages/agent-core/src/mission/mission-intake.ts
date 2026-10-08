// MissionIntake — Phase 12 (P12.2). Deterministic classification of a goal into a MissionType.
//
// Pure keyword taxonomy over the extracted signals (MI-005: same signals → same type). The
// taxonomy is an ordered list of (type, keywords) rules; the FIRST rule with a keyword hit
// wins, so order encodes priority (e.g. PROJECT/MIGRATION before FEATURE). This is intentional
// and deterministic. An optional LLM advisory type (added later) is only consulted when the
// deterministic result is UNKNOWN, and even then it is clamped to the known taxonomy.
import type { MissionType } from '../domain/mission.js';
import type { MissionSignals } from './signals.js';

interface TypeRule {
  readonly type: MissionType;
  readonly keywords: readonly string[];
}

/**
 * Ordered taxonomy. Higher-priority (more specific/strategic) types come first so that a goal
 * like "migrate the project to X" classifies as MIGRATION, not FEATURE. Extensible: add a rule.
 */
const TAXONOMY: readonly TypeRule[] = [
  { type: 'MULTI_REPOSITORY', keywords: ['monorepo', 'multi-repo', 'multirepo', 'repositories', 'across repos'] },
  { type: 'MIGRATION',        keywords: ['migrate', 'migration', 'upgrade', 'port to', 'convert to', 'move from'] },
  { type: 'PROJECT',          keywords: ['build an app', 'build a', 'create an app', 'new application', 'new app', 'from scratch', 'scaffold', 'bootstrap a', 'build me a'] },
  { type: 'ARCHITECTURE',     keywords: ['architecture', 'redesign', 'restructure the', 'design the system'] },
  { type: 'RESEARCH',         keywords: ['research', 'investigate', 'explore', 'evaluate options', 'compare libraries', 'spike'] },
  { type: 'PERFORMANCE',      keywords: ['optimize', 'performance', 'speed up', 'make faster', 'reduce latency', 'profile'] },
  { type: 'MIGRATION',        keywords: ['bump version', 'update dependency', 'update dependencies'] },
  { type: 'TESTING',          keywords: ['add tests', 'write tests', 'test coverage', 'unit test', 'integration test'] },
  { type: 'DOCUMENTATION',    keywords: ['document', 'documentation', 'readme', 'write docs', 'add comments', 'docstring'] },
  { type: 'AUTOMATION',       keywords: ['automate', 'automation', 'ci pipeline', 'github action', 'cron', 'scheduled job'] },
  { type: 'EXPERIMENT',       keywords: ['experiment', 'try out', 'prototype', 'proof of concept', 'poc'] },
  { type: 'BUG_FIX',          keywords: ['fix', 'bug', 'broken', 'error', 'crash', 'failing test', 'does not work', 'incorrect'] },
  { type: 'REFACTOR',         keywords: ['refactor', 'rename', 'extract', 'clean up', 'cleanup', 'simplify', 'deduplicate', 'inline'] },
  { type: 'FEATURE',          keywords: ['add', 'implement', 'create', 'support', 'introduce', 'feature', 'integrate'] },
];

export interface MissionTypeResult {
  readonly type: MissionType;
  /** The keyword that matched (for provenance/observability), or undefined when UNKNOWN. */
  readonly matchedKeyword?: string;
}

/**
 * Classify the mission type from signals. Deterministic: scans the ordered taxonomy and returns
 * the first rule whose keyword appears in the goal text. Returns UNKNOWN when nothing matches —
 * the caller may then consult an advisory LLM (clamped to this taxonomy) or ask the user.
 */
export function classifyMissionType(signals: MissionSignals): MissionTypeResult {
  for (const rule of TAXONOMY) {
    for (const kw of rule.keywords) {
      if (signals.text.includes(kw)) {
        return { type: rule.type, matchedKeyword: kw };
      }
    }
  }
  return { type: 'UNKNOWN' };
}

/** The set of known mission types the advisory LLM output must be clamped to. */
export const KNOWN_MISSION_TYPES: ReadonlySet<MissionType> = new Set<MissionType>([
  'BUG_FIX', 'FEATURE', 'REFACTOR', 'MIGRATION', 'PROJECT', 'RESEARCH', 'ARCHITECTURE',
  'PERFORMANCE', 'TESTING', 'DOCUMENTATION', 'MULTI_REPOSITORY', 'EXPERIMENT', 'AUTOMATION',
]);
