// @invariant TG-011
// Destructive shell commands (rm, rmdir, del, ...) are classified DESTRUCTIVE and therefore need human
// approval at every autonomy level; verification commands such as `node test.js` stay SYSTEM (allowed
// under `full`).
// Enforcement: resolveToolRiskClass + buildToolPolicy/determineAction. Phase 12. Severity CRITICAL.
//
// TEST-FIRST (kernel-gap-closure task 1.9): fails until tasks 3.2 to 3.4 land.
import { describe, it, expect } from 'vitest';
import { buildToolPolicy, determineAction, resolveToolRiskClass } from '@codeforge/agent-core';

describe('TG-011: destructive shell classification', () => {
  it('rm -rf dist is DESTRUCTIVE and requires approval under full', () => {
    const risk = resolveToolRiskClass('run_command', { command: 'rm', args: ['-rf', 'dist'] });
    expect(risk).toBe('DESTRUCTIVE');
    expect(determineAction('run_command', risk, buildToolPolicy('full'))).toBe('require_approval');
  });

  it('node test.js is SYSTEM and allowed under full', () => {
    const risk = resolveToolRiskClass('run_command', { command: 'node', args: ['test.js'] });
    expect(risk).toBe('SYSTEM');
    expect(determineAction('run_command', risk, buildToolPolicy('full'))).toBe('allow');
  });
});
