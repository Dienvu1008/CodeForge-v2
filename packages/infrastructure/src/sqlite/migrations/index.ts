// Migrations (P1-F3 + P1.5-DB2) — MIGRATION_SPEC §4-§5.
export * from './types.js';
export {
  MIGRATIONS,
  createMigrationRegistry,
  runMigrations,
  readSchemaHistory,
  type MigrateOptions,
} from './registry.js';
export { migration0001 } from './0001-initial-schema.js';
export { migration0002 } from './0002-phase15-tables.js';
export { migration0003 } from './0003-context-tables.js';
export { migration0004 } from './0004-artifacts.js';
export { migration0005 } from './0005-memory-tables.js';
export { migration0006 } from './0006-learning-tables.js';
