// Telegram adapter (Phase 9, P9.8) — remote control + notification over the SAME
// ObservabilityService / ControlPlane as the dashboard (OB-006). Offline-testable router
// + thin network transport + a fetch-based default client (not exercised in CI).
export * from './telegram-command-router.js';
export * from './telegram-transport.js';
export * from './fetch-telegram-client.js';
