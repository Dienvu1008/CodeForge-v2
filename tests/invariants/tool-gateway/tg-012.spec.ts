// @invariant TG-012
// Network-capable shell commands (curl, wget, ssh, ...) are classified NETWORK and require approval at
// every autonomy level, including `full`; ordinary verification such as `npm test` stays SYSTEM.
// Enforcement: resolveToolRiskClass + buildToolPolicy/determineAction. Phase 12. Severity HIGH.
//
// TEST-FIRST (kernel-gap-closure task 1.9): fails until tasks 3.2 to 3.4 land.
import { describe, it, expect } from 'vitest';
import { buildToolPolicy, determineAction, resolveToolRiskClass } from '@codeforge/agent-core';

describe('TG-012: network classification and approval', () => {
  it('curl is NETWORK and requires approval under full', () => {
    const risk = resolveToolRiskClass('run_command', { command: 'curl', args: ['https://example.com'] });
    expect(risk).toBe('NETWORK');
    expect(determineAction('run_command', risk, buildToolPolicy('full'))).toBe('require_approval');
  });

  it('npm test is SYSTEM', () => {
    const risk = resolveToolRiskClass('run_command', { command: 'npm', args: ['test'] });
    expect(risk).toBe('SYSTEM');
    expect(determineAction('run_command', risk, buildToolPolicy('full'))).toBe('allow');
  });
});
