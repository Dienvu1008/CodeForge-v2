/*
 * Copyright 2026 DienVu (Dienvu1008)
 * SPDX-License-Identifier: Apache-2.0
 */

// Phase 3 — P3-WM1: Node.js WorkspaceManager implementation.
export { NodeWorkspaceManager, type NodeWorkspaceManagerDeps } from './node-workspace-manager.js';
// P12.14 — ROLLBACK port implementation (content snapshot + restore).
export {
  WorkspaceSnapshotRollback,
  type WorkspaceSnapshotRollbackDeps,
} from './workspace-snapshot-rollback.js';
// Kernel gap closure (G5 / TG-013): test files present at goal start.
export {
  WorkspaceTestBaseline,
  type WorkspaceTestBaselineDeps,
} from './workspace-test-baseline.js';
