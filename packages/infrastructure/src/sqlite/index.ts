/*
 * Copyright 2026 DienVu (Dienvu1008)
 * SPDX-License-Identifier: Apache-2.0
 */

// SQLite adapter (P1-F2) — INFRASTRUCTURE_SPEC §3.
export * from './types.js';
export * from './errors.js';
export { SqliteDatabaseAdapter } from './database.js';

// Migrations (P1-F3) — MIGRATION_SPEC §4-§5.
export * from './migrations/index.js';
