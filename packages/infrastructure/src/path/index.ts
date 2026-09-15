// Path canonicalizer (C3) — WORKSPACE_SPEC §3, PLATFORM_SUPPORT §5.
export { PathError } from './errors.js';
export type { PathErrorCode } from './errors.js';
export {
  canonicalizePath,
  isWithinRoot,
  relativeToRoot,
  toCanonicalSeparators,
} from './canonicalize.js';
export type { CanonicalizeOptions } from './canonicalize.js';
export { resolveRealpath } from './realpath.js';
export type { RealpathOptions } from './realpath.js';
export {
  detectCaseSensitivity,
  defaultCaseSensitivity,
  findCaseCollision,
} from './case-sensitivity.js';
