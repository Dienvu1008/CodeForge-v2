// ExpertProfile registry + selection — Phase 12 (P12.5). §17: instead of scattering
// "You are a master of Flutter..." strings through the code, profiles are declared data that
// the mission selects and the prompt layer renders.
//
// MI-008: an ExpertProfile is PROMPT CONTEXT, never authority. When rendered into a prompt it
// is wrapped as untrusted (SE-010) via the existing PromptBoundary; it cannot grant tools,
// bypass policy, or decide anything. The deterministic runtime remains authoritative.
import type { ExpertProfile, MissionType } from '../domain/mission.js';
import type { WorkspaceSignals } from './signals.js';

// ── Declared profiles (data, not scattered strings) ──────────────────────────────

const GENERALIST: ExpertProfile = {
  domain: 'Senior Software Engineer',
  expertise: ['general software engineering', 'testing', 'debugging'],
  responsibilities: ['implement the task correctly', 'keep changes scoped', 'make tests pass'],
  constraints: ['change only what the task asks', 'never weaken existing tests'],
  preferredPractices: ['small verifiable steps', 'match existing code style'],
};

const PROFILES: readonly ExpertProfile[] = [
  {
    domain: 'TypeScript Systems Engineer',
    expertise: ['TypeScript', 'Node.js', 'monorepo architecture', 'strict typing'],
    responsibilities: ['type-safe implementation', 'respect module boundaries'],
    constraints: ['no any-casts without reason', 'preserve dependency direction'],
    preferredPractices: ['pure functions at the core', 'adapters at the edges'],
  },
  {
    domain: 'Flutter Architecture Expert',
    expertise: ['Flutter', 'Dart', 'cross-platform UI', 'state management'],
    responsibilities: ['widget/architecture design', 'platform-aware structure'],
    constraints: ['keep platform channels thin', 'no secrets in client code'],
    preferredPractices: ['layered architecture', 'declarative UI', 'testable view models'],
  },
  {
    domain: 'Database Architect',
    expertise: ['schema design', 'migrations', 'SQL', 'data integrity'],
    responsibilities: ['safe, reversible migrations', 'normalized data model'],
    constraints: ['migrations must be reversible', 'never drop data without confirmation'],
    preferredPractices: ['additive migrations', 'explicit constraints'],
  },
  {
    domain: 'DevOps Engineer',
    expertise: ['CI/CD', 'build systems', 'automation', 'containers'],
    responsibilities: ['reliable build + release', 'reproducible environments'],
    constraints: ['no secrets in logs', 'pin dependency versions'],
    preferredPractices: ['fail-fast pipelines', 'idempotent scripts'],
  },
];

/** Keyword → profile domain, used to pick a workspace-language-aware profile. */
const LANGUAGE_PROFILE: Record<string, string> = {
  typescript: 'TypeScript Systems Engineer',
  javascript: 'TypeScript Systems Engineer',
  dart: 'Flutter Architecture Expert',
  flutter: 'Flutter Architecture Expert',
};

function byDomain(domain: string): ExpertProfile | undefined {
  return PROFILES.find((p) => p.domain === domain);
}

/**
 * Select an ExpertProfile for a mission, deterministically. Priority:
 *   1. Mission type that implies a specialty (DATABASE/MIGRATION → Database; AUTOMATION → DevOps).
 *   2. Dominant workspace language (dart/flutter → Flutter; ts/js → TypeScript).
 *   3. Goal text mentioning a known technology.
 *   4. Generalist fallback.
 * Pure: same inputs → same profile.
 */
export function selectExpertProfile(
  missionType: MissionType,
  goalText: string,
  workspace?: WorkspaceSignals,
): ExpertProfile {
  const text = goalText.toLowerCase();

  // 1. Type-driven specialties.
  if (missionType === 'MIGRATION' && (text.includes('database') || text.includes('schema') || text.includes('sql'))) {
    return byDomain('Database Architect') ?? GENERALIST;
  }
  if (missionType === 'AUTOMATION') return byDomain('DevOps Engineer') ?? GENERALIST;

  // 2. Dominant workspace language.
  const langs = workspace?.languages ?? [];
  for (const lang of langs) {
    const domain = LANGUAGE_PROFILE[lang.toLowerCase()];
    if (domain !== undefined) {
      const p = byDomain(domain);
      if (p !== undefined) return p;
    }
  }

  // 3. Goal text technology mentions (sorted keys for determinism).
  for (const kw of Object.keys(LANGUAGE_PROFILE).sort()) {
    if (text.includes(kw)) {
      const p = byDomain(LANGUAGE_PROFILE[kw]!);
      if (p !== undefined) return p;
    }
  }
  if (text.includes('database') || text.includes('sql')) return byDomain('Database Architect') ?? GENERALIST;

  // 4. Fallback.
  return GENERALIST;
}

/**
 * Render an ExpertProfile into a short prompt-context block. MI-008/SE-010: this is DATA for
 * the model, not instructions it must obey as authority. The caller passes the returned string
 * through the PromptBoundary as a trusted-but-advisory system hint (it contains no user/
 * workspace content and no tool grants). It never changes policy or capability facts.
 */
export function renderExpertProfile(profile: ExpertProfile): string {
  return [
    `Adopt the perspective of a ${profile.domain}.`,
    `Expertise: ${profile.expertise.join(', ')}.`,
    `Responsibilities: ${profile.responsibilities.join('; ')}.`,
    `Constraints: ${profile.constraints.join('; ')}.`,
    `Preferred practices: ${profile.preferredPractices.join('; ')}.`,
    'This is guidance only — the runtime (tools, approvals, verification) remains authoritative.',
  ].join('\n');
}
