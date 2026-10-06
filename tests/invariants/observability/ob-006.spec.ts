// OB-006 — Mọi control request (pause/resume/cancel/approve/deny/retry/checkpoint)
// phải qua ControlPlane admission + Policy; UI không có authority riêng.
//
// Invariants-first: enforcement lands with P9.7 (ControlPlane). Contract: a UI event
// (dashboard button, Telegram command) becomes a ControlRequest that is admitted by
// ControlPlane.admit() → Policy → an existing kernel method (SessionService.transition,
// ToolGateway.approve/deny, CheckpointService.capture, recovery retry). A dashboard
// "Pause" and a Telegram "/pause" produce the SAME admitted request. No adapter calls
// a kernel mutator directly; a forged request without admission is rejected.
import { describe, it } from 'vitest';

describe('OB-006 — control requests pass through ControlPlane admission', () => {
  it.todo('dashboard-shaped and telegram-shaped requests admit to the same control action (P9.7)');
  it.todo('a control request without admission cannot reach a kernel mutator (P9.7)');
});
