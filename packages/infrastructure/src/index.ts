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
//   - graph-hash/   (P1-G1: Blake3GraphHasher — GRAPH_PROTOCOL §2.3)
export * from './sqlite/index.js';
export * from './redaction/index.js';
export * from './event-log/index.js';
export * from './repositories/index.js';
export * from './graph-hash/index.js';

// Phase 1.5:
//   - process/ (P1.5-PS1: NodeProcessSupervisor — SE-007/008, TG-010)
export * from './process/index.js';
// Phase 2:
//   - model/ (P2-MG1: OllamaModelGateway — MG-001/004/005)
export * from './model/index.js';
// Phase 3:
//   - workspace/ (P3-WM1: NodeWorkspaceManager — WS-003/004/005/010)
export * from './workspace/index.js';
//   - artifacts/ (P3-AS1: ArtifactStore — PR-003)
export * from './artifacts/index.js';
//   - tools/ (P3-FS1: FilesystemExecutor — WS-003/004/005/010)
export * from './tools/index.js';
// Phase 6 — P6-TS1/SX1: Code intelligence (Tree-sitter + symbols)
export * from './code-intelligence/index.js';
// Phase 7 — P7-MS1: Memory store (SQLite)
export * from './memory/index.js';
// Phase 11 — P11.2: Learning store (SQLite)
export * from './learning/index.js';
// Phase 9 — P9.3: Observability server (protocol-agnostic service + node:http transport)
export * from './observability-server/index.js';
// Phase 9 — P9.8: Telegram adapter (another transport over ObservabilityService)
export * from './telegram/index.js';
// Phase 10 — P10.1: Verification runtime (project inspector + check supervisor)
export * from './verification-runtime/index.js';
// Phase 10 — P10.3: Context runtime (workspace → symbols/import-graph/files collector)
export * from './context-runtime/index.js';
// Phase 10 — P10.5: Approval runtime (human-in-the-loop tool approval coordinator)
export * from './approval-runtime/index.js';
