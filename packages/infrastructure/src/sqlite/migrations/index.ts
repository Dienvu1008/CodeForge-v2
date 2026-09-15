// Migrations (P1-F3) — MIGRATION_SPEC §4-§5.
export * from './types.js';
export {
  MIGRATIONS,
  createMigrationRegistry,
  runMigrations,
  readSchemaHistory,
  type MigrateOptions,
} from './registry.js';
export { migration0001 } from './0001-initial-schema.js';
