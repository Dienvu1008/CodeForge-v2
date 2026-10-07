// Approval runtime (P10.5) — human-in-the-loop bridge: pauses the session to
// AWAITING_HUMAN and waits for a ControlPlane-driven approve/deny on a pending tool call.
export * from './approval-coordinator.js';
