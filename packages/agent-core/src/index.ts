// @codeforge/agent-core
//
// Domain layer (Layer 2). MUST NOT import from infrastructure, models, or tools.
// Enforced by dependency-cruiser (DC-001..DC-005) and ESLint no-restricted-imports.
//
// Phase 0 progress:
//   - id/                (ULID primitive) — DONE
//   - domain/            (C4: entity types) — WorkspaceRevision DONE, rest pending
//   - state-machine/     (C5: 10 state machine types) — pending
//   - graph/             (C6: graph types) — pending
//   - repositories/      (C7: 6 repository interfaces) — pending
export { generateUlid, isUlid } from './id/ulid.js';
export type { UlidSources } from './id/ulid.js';
export {
  isFresh,
  CANONICAL_FORM_VERSION,
} from './domain/workspace-revision.js';
export type {
  WorkspaceRevision,
  WorkspaceRevisionReason,
  WorkspaceRevisionCreatedBy,
  WorkspaceHashAlgorithm,
  WorkspaceGitMetadata,
} from './domain/workspace-revision.js';
