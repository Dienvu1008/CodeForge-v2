// @codeforge/infrastructure
//
// Adapter layer (Layer 4). Implements domain interfaces from @codeforge/agent-core.
//
// Phase 0:
//   - path/                (C3: path canonicalizer — WORKSPACE_SPEC §3) — DONE
//   - workspace-hash/      (C1: canonical hash — WORKSPACE_SPEC §6) — DONE
//   - workspace-revision/  (C2: WorkspaceRevision — WORKSPACE_SPEC §5) — DONE
export * from './path/index.js';
export * from './workspace-hash/index.js';
export * from './workspace-revision/index.js';

// Phase 1:
//   - sqlite/  (P1-F2: DatabaseAdapter — INFRASTRUCTURE_SPEC §3)
export * from './sqlite/index.js';
