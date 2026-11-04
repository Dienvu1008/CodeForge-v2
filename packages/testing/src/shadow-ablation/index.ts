/*
 * Copyright 2026 DienVu (Dienvu1008)
 * SPDX-License-Identifier: Apache-2.0
 */
// @codeforge/testing/shadow-ablation
//
// Kernel shadow-ablation instrument: measurement-only, never imported by production code (SA-001).
// Exposed only through the `./shadow-ablation` subpath export; NOT re-exported from the root
// barrel (`src/index.ts`).

// Trace format, recording and replay (C1–C3).
export * from './trace-format.js';
export * from './recording-model-gateway.js';
export * from './replay-model-gateway.js';

// Decision ledger and sandbox (C4–C5).
export * from './decision-ledger.js';
export * from './sandbox.js';

// Enforcement-point observers (C6–C10).
export * from './ablation-workspace.js';
export * from './ablation-tool-gateway.js';
export * from './ablation-approval.js';
export * from './ablation-tool-executor.js';
export * from './ablation-verification.js';

// Containment supervisor for subprocesses (C9).
export * from './contained-process-supervisor.js';

// Injection corpus (C11).
export * from './injection-corpus.js';

// Arms, synthetic traces, comparison and report (C12–C14 + synthetic traces).
export * from './arm.js';
export * from './synthetic-traces.js';
export * from './comparison.js';
export * from './report.js';
