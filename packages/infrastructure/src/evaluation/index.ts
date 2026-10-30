/*
 * Copyright 2026 DienVu (Dienvu1008)
 * SPDX-License-Identifier: Apache-2.0
 */

// CodeForge Evaluation adapters (infrastructure) — the I/O side of the eval system: isolated
// workspaces, deterministic check running, driving the runtime per case, baseline persistence,
// and dataset file loading. All pure decision logic lives in agent-core/src/evaluation.
export {
  createIsolatedWorkspace,
  destroyIsolatedWorkspace,
  changedFiles,
  type IsolatedWorkspaceHandle,
} from './isolated-workspace.js';
export { BenchmarkCheckRunner, type CheckRunnerDeps } from './check-runner.js';
export {
  BenchmarkRunner,
  type AgentRunner,
  type AgentRunResult,
  type BenchmarkRunnerDeps,
} from './benchmark-runner.js';
export { BaselineStore, type BaselineStoreDeps } from './baseline-store.js';
export { loadBenchmarkFile, DatasetLoadError } from './dataset-loader.js';
// SWE-bench external-benchmark adapter (I/O side): dataset loading + git-based workspace setup.
export {
  loadSweBenchDataset,
  parseSweBenchRecords,
  SweBenchDatasetError,
} from './swe-bench-dataset-loader.js';
export {
  SweBenchWorkspaceSetup,
  type SweBenchWorkspaceSetupDeps,
  type SweBenchSetupResult,
} from './swe-bench-workspace-setup.js';
export {
  SweBenchAgentRunner,
  type SweBenchAgentRunnerDeps,
  type SweBenchOrchestratorRun,
} from './swe-bench-agent-runner.js';
