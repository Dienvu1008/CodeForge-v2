// Workspace vectors (A3) — WORKSPACE_SPEC §7.
export { VECTORS, VECTORS_BY_ID, repeatContent } from './vectors.js';
export { buildVector } from './builder.js';
export type { BuiltVector } from './builder.js';
export type {
  WorkspaceVector,
  VectorEntry,
  VectorFileEntry,
  VectorDirEntry,
  VectorSymlinkEntry,
  VectorExpected,
  VectorPlatform,
} from './types.js';
