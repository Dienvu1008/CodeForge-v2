/*
 * Copyright 2026 DienVu (Dienvu1008)
 * SPDX-License-Identifier: Apache-2.0
 */

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

/**
 * Kinds of STRUCTURAL change implied by a goal (P12.10). Each is a distinct dimension of
 * structural work, detected from the goal text by groups of synonyms — but a kind can be present
 * AT MOST ONCE (synonyms do not stack), so "extract into a new module" and "split the module"
 * both count as a single MODULE_RESTRUCTURE, never two. This is the signal that tells the
 * complexity analyzer a task reshapes code structure (not just edits a line), independent of the
 * mission type label.
 */
export type StructuralSignal =
  | 'MODULE_RESTRUCTURE'   // extract/split/merge/move a module; change the module boundary
  | 'DEPENDENCY_BOUNDARY'  // change dependency direction / decouple / "no dependency on"
  | 'INTERFACE_CHANGE'     // change public API / exports / signatures / call sites
  | 'CROSS_FILE_CONSISTENCY' // "across files", "update all callers/imports", keep in sync
  | 'BEHAVIOR_PRESERVATION'; // "preserve existing behavior" / "behaviour unchanged" (verification risk)

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
  /**
   * P12.10: count of DISTINCT file paths explicitly named in the goal (e.g. 'src/math.js').
   * De-duplicated. A proxy for how many files the task spans — a structural-breadth signal that
   * does not depend on prose length. 0 when the goal names no concrete paths.
   */
  readonly pathCount: number;
  /**
   * P12.10: structural-change kinds implied by the goal (deduplicated by kind, so synonyms do
   * not stack). Empty for a goal with no structural wording.
   */
  readonly structuralSignals: readonly StructuralSignal[];
  readonly workspace?: WorkspaceSignals;
}

const PLATFORM_WORDS = ['windows', 'android', 'ios', 'linux', 'macos', 'web', 'desktop', 'mobile'];
const MULTI_REPO_WORDS = ['repositories', 'repos', 'monorepo', 'multi-repo', 'multirepo'];

// Each structural signal is detected by a group of synonymous phrases. Membership of the group is
// counted ONCE (the signal is present or not) — synonyms within a group never stack, which stops
// keyword-padding from inflating complexity (a deliberate anti-pattern guard, task §4/§6).
const STRUCTURAL_PATTERNS: ReadonlyArray<{ signal: StructuralSignal; phrases: readonly string[] }> = [
  { signal: 'MODULE_RESTRUCTURE', phrases: [
    'extract', 'new module', 'into a module', 'separate module', 'split the', 'split into', 'merge the',
    'move the', 'relocate', 'module boundary', 'into layers', 'separate the', 'pull out',
  ] },
  { signal: 'DEPENDENCY_BOUNDARY', phrases: [
    'no dependency', 'without depending', 'dependency direction', 'decouple', 'break the dependency',
    'invert the dependency', 'remove the dependency', 'depends on', 'dependency boundary',
  ] },
  { signal: 'INTERFACE_CHANGE', phrases: [
    'public api', 'public interface', 'change the signature', 'change the api', 'exported',
    'exports', 're-export', 'reexport', 'call sites', 'callers', 'breaking change', 'interface',
  ] },
  { signal: 'CROSS_FILE_CONSISTENCY', phrases: [
    'across all files', 'across files', 'all call sites', 'all callers', 'update imports',
    'update the imports', 'imports and exports', 'everywhere it', 'everywhere they', 'keep in sync',
    'consistent across', 'throughout the',
  ] },
  { signal: 'BEHAVIOR_PRESERVATION', phrases: [
    'preserve existing behavior', 'preserve existing behaviour', 'preserve behavior', 'preserve behaviour',
    'behavior must stay', 'behaviour must stay', 'behavior unchanged', 'behaviour unchanged',
    'without changing behavior', 'without changing behaviour', 'same behavior', 'same behaviour',
    'behavior is identical', 'behaviour is identical', 'keep behavior', 'keep behaviour',
  ] },
];

// A path token: contains a '/' OR ends in a known source-file extension. Deterministic + simple.
const PATH_RE = /\b[\w./-]*\.(?:ts|tsx|js|jsx|mjs|cjs|py|dart|go|rs|java|rb|json|md|yaml|yml|c|h|cpp|hpp|cs)\b|\b[\w-]+\/[\w./-]+\b/g;

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

  // P12.10: distinct explicit file paths (deduplicated). Proxy for file-span breadth.
  const paths = new Set<string>();
  for (const m of text.matchAll(PATH_RE)) paths.add(m[0]);

  // P12.10: structural-change kinds (deduplicated by kind — synonyms within a group count once).
  const structuralSignals: StructuralSignal[] = [];
  for (const { signal, phrases } of STRUCTURAL_PATTERNS) {
    if (phrases.some((p) => text.includes(p))) structuralSignals.push(signal);
  }

  return {
    text,
    tokens,
    wordCount: rawTokens.length,
    platformCount: platforms.size,
    multiRepo,
    pathCount: paths.size,
    structuralSignals,
    ...(workspace !== undefined ? { workspace } : {}),
  };
}
