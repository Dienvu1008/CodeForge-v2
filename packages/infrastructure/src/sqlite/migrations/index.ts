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
