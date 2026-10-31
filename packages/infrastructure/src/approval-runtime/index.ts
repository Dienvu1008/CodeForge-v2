/*
 * Copyright 2026 DienVu (Dienvu1008)
 * SPDX-License-Identifier: Apache-2.0
 */

// Approval runtime (P10.5) — human-in-the-loop bridge: pauses the session to
// AWAITING_HUMAN and waits for a ControlPlane-driven approve/deny on a pending tool call.
export * from './approval-coordinator.js';
// Goal clarification gate — pauses the session to AWAITING_HUMAN and waits for
// POST /clarification answers (at-most-once per request).
export * from './clarification-coordinator.js';
