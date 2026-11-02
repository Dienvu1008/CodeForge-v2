/*
 * Copyright 2026 DienVu (Dienvu1008)
 * SPDX-License-Identifier: Apache-2.0
 */

// Observability server (Phase 9, P9.3) — protocol-agnostic service + node:http transport
// + static dashboard client. Reads projections/trace, submits control via ControlPlane.
export * from './observability-service.js';
export * from './http-transport.js';
export * from './session-state-control-gate.js';
// P0 security hardening — pure pre-routing gate policy (Host/Origin/auth/content-type, redaction).
export * from './http-security.js';
export * from './server-security-config.js';
export { DASHBOARD_HTML, DASHBOARD_JS } from './dashboard-assets.js';
