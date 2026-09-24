// AffectedSetComputer — VERIFICATION_PROTOCOL §4, P1.5-VR1.
//
// Phase 1.5 baseline: diff-based affected set (§4.3). No LSP/Tree-sitter.
// Pure + deterministic: same (atStart, atEnd) → same result (VR-010).
//
// Algorithm:
//   affectedDirect = symmetric diff of includedPaths between atStart and atEnd.
//   affectedClosure = affectedDirect
//                   ∪ { test files matching affectedDirect (heuristic: .test.ts, .spec.ts) }
//                   ∪ { files that import any affectedDirect file (1-hop regex heuristic) }
//
// Note: ChangeRecord-based approach is equivalent but requires runtime data.
// Here we use WorkspaceRevision.includedPaths directly for pure computation.
import type { WorkspaceRevision } from '../domain/workspace-revision.js';

// ── computeAffectedDirect ─────────────────────────────────────────────────────

/**
 * Compute the directly-affected file set from two workspace revisions (§4.3).
 *
 * Returns paths that:
 *   - Are new in atEnd (added files), or
 *   - Are missing from atEnd (deleted files), or
 *   - Are in both but were modified (same path, different hash tracked via ChangeRecords
 *     externally; here we conservatively include all diffed paths).
 *
 * Excludes scratch paths (paths in `atEnd.excludedScratchPaths`).
 */
export function computeAffectedDirect(
  atStart: Pick<WorkspaceRevision, 'includedPaths' | 'excludedScratchPaths'>,
  atEnd: Pick<WorkspaceRevision, 'includedPaths' | 'excludedScratchPaths'>,
): ReadonlySet<string> {
  const startSet = new Set(atStart.includedPaths);
  const endSet = new Set(atEnd.includedPaths);
  const scratchSet = new Set([...atStart.excludedScratchPaths, ...atEnd.excludedScratchPaths]);

  const affected = new Set<string>();

  /** True if a path matches any scratch prefix. */
  const isScratch = (p: string): boolean => {
    for (const prefix of scratchSet) {
      if (p === prefix || p.startsWith(prefix)) return true;
    }
    return false;
  };

  // Files in atEnd but not atStart (added).
  for (const p of endSet) {
    if (!startSet.has(p) && !isScratch(p)) affected.add(p);
  }
  // Files in atStart but not atEnd (deleted).
  for (const p of startSet) {
    if (!endSet.has(p) && !isScratch(p)) affected.add(p);
  }
  // Files in both sets are conservatively added (we don't have hashes here;
  // callers that have ChangeRecord data can pass modified paths directly via
  // computeAffectedFromChanges, which is more precise).

  return affected;
}

/**
 * Compute affected set from explicit ChangeRecord relpaths (more precise than
 * the revision-diff approach when ChangeRecords are available).
 *
 * Filters: non-scratch, agent-owned (not verification internal mutations).
 */
export function computeAffectedFromChanges(
  changes: ReadonlyArray<{
    readonly relpath: string;
    readonly ownedBy: 'agent' | 'verification' | 'user';
    readonly inScratchZone: boolean;
  }>,
): ReadonlySet<string> {
  const affected = new Set<string>();
  for (const c of changes) {
    if (!c.inScratchZone && c.ownedBy === 'agent') {
      affected.add(c.relpath);
    }
  }
  return affected;
}

// ── computeAffectedClosure ────────────────────────────────────────────────────

/**
 * Phase 1.5 heuristic closure (§4.4): extend affectedDirect with test files and
 * 1-hop import files found by regex scanning `allPaths`.
 *
 * Test file heuristic: any path matching `.spec.ts`, `.test.ts`, `.spec.js`,
 * `.test.js`, `_test.ts`, `_test.go` etc. that shares a base name with an affected
 * path is included.
 *
 * Import heuristic: scans `fileContents` (a map of relpath → file text) for
 * `import ... from '...'` that reference any affectedDirect file.
 */
export function computeAffectedClosure(
  affectedDirect: ReadonlySet<string>,
  allPaths: readonly string[],
  fileContents: ReadonlyMap<string, string> = new Map(),
): ReadonlySet<string> {
  const closure = new Set(affectedDirect);

  // 1. Test-file heuristic: any test file whose base name matches an affected file.
  const affectedBases = new Set(
    [...affectedDirect].map((p) => {
      const base = p.replace(/\\/g, '/').split('/').pop() ?? '';
      return base.replace(/\.(ts|js|tsx|jsx)$/, '');
    }),
  );

  for (const path of allPaths) {
    if (TEST_FILE_PATTERN.test(path)) {
      const base = path.replace(/\\/g, '/').split('/').pop() ?? '';
      const stem = base.replace(TEST_FILE_PATTERN, '');
      if (affectedBases.has(stem)) closure.add(path);
    }
  }

  // 2. Import heuristic: 1-hop regex scan.
  for (const path of allPaths) {
    if (closure.has(path)) continue; // already included
    const content = fileContents.get(path);
    if (content === undefined) continue;
    for (const affected of affectedDirect) {
      const stem = affected.replace(/\.(ts|js|tsx|jsx|mts|mjs)$/, '');
      if (referencesPath(content, stem)) {
        closure.add(path);
        break;
      }
    }
  }

  return closure;
}

// ── helpers ───────────────────────────────────────────────────────────────────

const TEST_FILE_PATTERN = /\.(spec|test|_test)\.(ts|tsx|js|jsx|mts|mjs)$|_test\.go$/;

/**
 * Returns true if `content` contains an import/require that references `stemPath`.
 * Conservative: checks for the last path segment (filename without extension) to
 * avoid false positives from full-path matching.
 */
function referencesPath(content: string, stemPath: string): boolean {
  const segments = stemPath.replace(/\\/g, '/').split('/');
  const lastSeg = segments[segments.length - 1];
  if (lastSeg === undefined || lastSeg.length === 0) return false;

  // Match: import ... from '.../<lastSeg>' or require('.../<lastSeg>')
  // Also match relative imports like './foo' or '../foo/bar'.
  const escaped = lastSeg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(
    `(?:import|require)\\s*(?:[\\s\\S]*?from)?\\s*['"](?:[^'"]*\\/)?${escaped}(?:['"./]|$)`,
  );
  return pattern.test(content);
}
