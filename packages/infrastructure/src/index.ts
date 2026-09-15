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
//   - sqlite/       (P1-F2: DatabaseAdapter — INFRASTRUCTURE_SPEC §3)
//   - sqlite/migrations/ (P1-F3: schema v1 + migration engine — MIGRATION_SPEC)
//   - redaction/    (SECURITY_MODEL §7 — secret redaction)
//   - event-log/    (P1-F4: SqliteEventLog — DOMAIN_CONTRACTS §18)
//   - repositories/ (P1-F5: SQLite repository impls — DOMAIN_CONTRACTS §23)
export * from './sqlite/index.js';
export * from './redaction/index.js';
export * from './event-log/index.js';
export * from './repositories/index.js';
