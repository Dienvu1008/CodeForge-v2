// Test harness (C10) — Phase0Harness runner + CrashInjector interface.
export { Phase0Harness } from './harness.js';
export type {
  InvariantEntry,
  InvariantRegistry,
  VectorResult,
  Phase0Report,
} from './harness.js';
export { NoopCrashInjector, CRASH_POINTS } from './crash-injector.js';
export type { CrashInjector, CrashPoint } from './crash-injector.js';
