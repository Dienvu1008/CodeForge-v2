// MI-008 — ExpertProfile (and any LLM-sourced content) is PROMPT CONTEXT, never authority.
// A rendered profile must be plain guidance text: it must NOT grant tools, bypass policy, or
// assert capability/environment facts; it must say the runtime stays authoritative.
import { describe, it, expect } from 'vitest';
import { selectExpertProfile, renderExpertProfile } from '@codeforge/agent-core';
import type { ExpertProfile } from '@codeforge/agent-core';

describe('MI-008 — expert profiles are untrusted prompt-context, not authority', () => {
  it('selection is deterministic and data-driven (workspace language → profile)', () => {
    const p1 = selectExpertProfile('FEATURE', 'add a widget', { languages: ['dart'] });
    const p2 = selectExpertProfile('FEATURE', 'add a widget', { languages: ['dart'] });
    expect(p1.domain).toBe('Flutter Architecture Expert');
    expect(JSON.stringify(p2)).toEqual(JSON.stringify(p1));
  });

  it('falls back to a generalist when nothing specific matches', () => {
    const p = selectExpertProfile('FEATURE', 'do the thing', {});
    expect(p.domain).toBe('Senior Software Engineer');
  });

  it('TypeScript workspace selects the TS systems engineer', () => {
    const p = selectExpertProfile('REFACTOR', 'refactor the module', { languages: ['typescript'] });
    expect(p.domain).toBe('TypeScript Systems Engineer');
  });

  it('a rendered profile is advisory guidance only — no authority grants', () => {
    const profile: ExpertProfile = selectExpertProfile('PROJECT', 'build a flutter app', { languages: ['dart'] });
    const rendered = renderExpertProfile(profile).toLowerCase();
    // It explicitly defers authority to the runtime.
    expect(rendered).toContain('runtime');
    expect(rendered).toContain('authoritative');
    // It must NOT contain language that grants capabilities or bypasses governance.
    for (const forbidden of ['you may delete', 'bypass', 'ignore policy', 'you are allowed to run', 'grant', 'sudo']) {
      expect(rendered).not.toContain(forbidden);
    }
  });

  it('a profile asserts no environment/capability facts (those come from verified discovery)', () => {
    const rendered = renderExpertProfile(selectExpertProfile('PROJECT', 'build a flutter app for android', { languages: ['dart'] }));
    // The profile talks about perspective/practices, never "X is installed/available".
    expect(rendered.toLowerCase()).not.toMatch(/is installed|is available|you have access to/);
  });
});
