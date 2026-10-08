// MissionSignals — Phase 12 (P12.2). Objective, deterministic signals extracted from a Goal
// (and optionally the workspace) that the analyzers consume. Keeping extraction separate from
// classification makes both pure and independently testable (MI-005: same signals → same
// classification). Extraction is deterministic (lowercased tokens, keyword membership, small
// counts) — not an NLP engine.
//
// NOTE: an optional LLM advisory signal (added later) is clamped by the MissionGate before it
// can move a classification — this module stays purely deterministic.

/** Optional workspace signals (from inspectProject / code-intelligence), all deterministic. */
export interface WorkspaceSignals {
  /** Distinct languages detected in the workspace (e.g. ['typescript','dart']). */
  readonly languages?: readonly string[];
  /** Rough file count (0 for an empty/new workspace). */
  readonly fileCount?: number;
  /** True when the workspace already contains a project (package.json/pubspec/etc). */
  readonly hasExistingProject?: boolean;
}

/** Everything the analyzers read, derived deterministically from the goal + workspace. */
export interface MissionSignals {
  /** Lowercased goal text. */
  readonly text: string;
  /** Lowercased, de-duplicated word tokens of the goal. */
  readonly tokens: readonly string[];
  /** Approx word count of the goal. */
  readonly wordCount: number;
  /** Count of distinct target platforms mentioned (windows/android/ios/linux/macos/web). */
  readonly platformCount: number;
  /** Count of distinct repositories implied (heuristic: 'repositories', 'repos', 'monorepo'). */
  readonly multiRepo: boolean;
  readonly workspace?: WorkspaceSignals;
}

const PLATFORM_WORDS = ['windows', 'android', 'ios', 'linux', 'macos', 'web', 'desktop', 'mobile'];
const MULTI_REPO_WORDS = ['repositories', 'repos', 'monorepo', 'multi-repo', 'multirepo'];

/**
 * Extract deterministic signals from a goal description (+ optional workspace signals).
 * Pure: same input → same output. No I/O, no clock, no randomness.
 */
export function extractSignals(goalText: string, workspace?: WorkspaceSignals): MissionSignals {
  const text = goalText.toLowerCase();
  // Tokenize on non-word characters; keep hyphenated words joined is not needed here.
  const rawTokens = text.split(/[^a-z0-9+#.]+/).filter((t) => t.length > 0);
  const tokens = [...new Set(rawTokens)];
  const tokenSet = new Set(rawTokens);

  const platforms = new Set<string>();
  for (const p of PLATFORM_WORDS) if (tokenSet.has(p)) platforms.add(p);
  const multiRepo = MULTI_REPO_WORDS.some((w) => text.includes(w));

  return {
    text,
    tokens,
    wordCount: rawTokens.length,
    platformCount: platforms.size,
    multiRepo,
    ...(workspace !== undefined ? { workspace } : {}),
  };
}
