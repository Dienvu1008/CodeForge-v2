// Verification runtime (P10.1) — disk inspection + a check-spawning ProcessSupervisor
// adapter that gives the frozen VerificationEngine a real workspace cwd + env.
export * from './project-inspector.js';
export * from './workspace-process-supervisor.js';
