/*
 * Copyright 2026 DienVu (Dienvu1008)
 * SPDX-License-Identifier: Apache-2.0
 */

// Canonical workspace hash (C1) — WORKSPACE_SPEC §6.
export {
  computeWorkspaceHash,
  hashFileContent,
} from './hash.js';
export type {
  HashAlgorithm,
  WorkspaceHashOptions,
  WorkspaceHashResult,
} from './hash.js';
export { walkWorkspace } from './walk.js';
export type { WalkEntry, WalkOptions } from './walk.js';
export {
  escapeField,
  nfc,
  fileLine,
  symlinkLine,
  dirLine,
} from './canonical-line.js';
export type { EntryType } from './canonical-line.js';
