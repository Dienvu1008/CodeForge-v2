// Observability server (Phase 9, P9.3) — protocol-agnostic service + node:http transport
// + static dashboard client. Reads projections/trace, submits control via ControlPlane.
export * from './observability-service.js';
export * from './http-transport.js';
export * from './session-state-control-gate.js';
export { DASHBOARD_HTML, DASHBOARD_JS } from './dashboard-assets.js';
