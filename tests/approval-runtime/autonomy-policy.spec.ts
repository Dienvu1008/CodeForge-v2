// P10.5 — autonomy-level tool policy (buildToolPolicy) + hard overrides.
import { describe, it, expect } from 'vitest';
import { buildToolPolicy, determineAction, type AutonomyLevel } from '@codeforge/agent-core';
import type { RiskClass } from '@codeforge/agent-core';

function action(level: AutonomyLevel, risk: RiskClass): string {
  return determineAction('any_tool', risk, buildToolPolicy(level));
}

describe('P10.5 buildToolPolicy — autonomy levels', () => {
  it('reads are always auto-approved', () => {
    for (const level of ['full', 'edits', 'readonly'] as const) {
      expect(action(level, 'READ_ONLY')).toBe('allow');
      expect(action(level, 'LOW_RISK')).toBe('allow');
    }
  });

  it('full: workspace edits, shell, network, package install all auto-approve', () => {
    expect(action('full', 'MODIFY_WORKSPACE')).toBe('allow');
    expect(action('full', 'SYSTEM')).toBe('allow');
    expect(action('full', 'NETWORK')).toBe('allow');
    expect(action('full', 'PACKAGE_INSTALL')).toBe('allow');
  });

  it('edits: workspace edits auto-approve, but shell/network/pkg ask', () => {
    expect(action('edits', 'MODIFY_WORKSPACE')).toBe('allow');
    expect(action('edits', 'SYSTEM')).toBe('require_approval');
    expect(action('edits', 'NETWORK')).toBe('require_approval');
    expect(action('edits', 'PACKAGE_INSTALL')).toBe('require_approval');
  });

  it('readonly: everything beyond reads asks', () => {
    expect(action('readonly', 'MODIFY_WORKSPACE')).toBe('require_approval');
    expect(action('readonly', 'SYSTEM')).toBe('require_approval');
  });

  it('DESTRUCTIVE always requires approval; PRIVILEGED always denied (TG-007/SE-009)', () => {
    for (const level of ['full', 'edits', 'readonly'] as const) {
      expect(action(level, 'DESTRUCTIVE')).toBe('require_approval');
      expect(action(level, 'PRIVILEGED')).toBe('deny');
    }
  });
});
