// detectExplorationLoop — the deterministic anti-loop signal that nudges a stuck model (one that
// keeps calling read-only tools like list_dir instead of writing) back toward action. It only
// drives a prompt hint; the step budget is the hard stop. These tests pin the two trigger rules.
import { describe, it, expect } from 'vitest';
import { detectExplorationLoop } from '@codeforge/agent-core';

type Step = { toolName: string; arguments: Record<string, unknown> };
const s = (toolName: string, args: Record<string, unknown> = {}): Step => ({ toolName, arguments: args });

describe('detectExplorationLoop', () => {
  it('does not trigger on fewer than 3 steps', () => {
    expect(detectExplorationLoop([])).toBe(false);
    expect(detectExplorationLoop([s('list_dir', { path: '.' })])).toBe(false);
    expect(detectExplorationLoop([s('list_dir', { path: '.' }), s('read_file', { path: 'a' })])).toBe(false);
  });

  it('(a) triggers when the SAME read-only call is repeated with the same arguments', () => {
    const t = [
      s('list_dir', { path: '.' }),
      s('read_file', { path: 'a.py' }),
      s('list_dir', { path: '.' }), // exact repeat of step 1
    ];
    expect(detectExplorationLoop(t)).toBe(true);
  });

  it('(b) triggers when the last 3 steps are ALL read-only', () => {
    const t = [
      s('write_file', { path: 'x.py', content: '...' }),
      s('list_dir', { path: '.' }),
      s('read_file', { path: 'x.py' }),
      s('git_status'),
    ];
    expect(detectExplorationLoop(t)).toBe(true);
  });

  it('does NOT trigger when a write/command breaks up the read-only calls', () => {
    const t = [
      s('list_dir', { path: '.' }),
      s('read_file', { path: 'a' }),
      s('write_file', { path: 'a', content: 'done' }), // action, not read-only
    ];
    expect(detectExplorationLoop(t)).toBe(false);
  });

  it('does NOT trigger on distinct read-only calls followed by a non-read-only tail', () => {
    const t = [
      s('list_dir', { path: '.' }),
      s('read_file', { path: 'a' }),
      s('run_command', { command: 'node a.js' }), // action in the tail
    ];
    expect(detectExplorationLoop(t)).toBe(false);
  });

  it('distinct read-only args are fine until the all-read-only tail rule applies', () => {
    // Three distinct reads with no action → rule (b) fires (tail of 3 is all read-only).
    const t = [
      s('read_file', { path: 'a' }),
      s('read_file', { path: 'b' }),
      s('read_file', { path: 'c' }),
    ];
    expect(detectExplorationLoop(t)).toBe(true);
  });

  it('treats run_command / write_file as NON-read-only (actions)', () => {
    const t = [
      s('run_command', { command: 'npm test' }),
      s('run_command', { command: 'npm test' }), // repeat, but NOT read-only → no (a) trigger
      s('write_file', { path: 'x', content: 'y' }),
    ];
    expect(detectExplorationLoop(t)).toBe(false);
  });
});
