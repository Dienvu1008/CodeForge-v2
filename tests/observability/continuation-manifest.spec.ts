// P9.6 — ContinuationManifest build + validate (non-authoritative session rollover).
import { describe, it, expect } from 'vitest';
import {
  buildContinuationManifest,
  validateContinuationManifest,
  type BuildContinuationInput,
  type AuthoritativeSnapshot,
  type Provenance,
} from '@codeforge/agent-core';

const PROV: Provenance = {
  provenanceId: 'PV', source: { kind: 'runtime', id: 'rollover' }, inputs: [], reason: 'rollover', at: 't',
};

function buildInput(over: Partial<BuildContinuationInput> = {}): BuildContinuationInput {
  return {
    manifestId: 'CM1', parentSessionId: 'S0', createdAt: 't',
    goalId: 'G', taskGraphVersion: 3, workspaceRevision: { revisionId: 'R3' },
    completedTaskIds: ['a'], activeTaskIds: ['b'], blockedTaskIds: ['c'],
    verificationIds: ['V1'], provenance: PROV,
    ...over,
  };
}

function auth(over: Partial<AuthoritativeSnapshot> = {}): AuthoritativeSnapshot {
  return {
    goalId: 'G', currentGraphVersion: 3, knownTaskIds: ['a', 'b', 'c'],
    currentRevisionId: 'R3', knownVerificationIds: ['V1'], knownCheckpointIds: [],
    ...over,
  };
}

describe('P9.6 buildContinuationManifest — references + hints only', () => {
  it('copies references, sorts id lists, carries advisory hints', () => {
    const m = buildContinuationManifest(buildInput({
      completedTaskIds: ['b', 'a'], discoveries: ['found X'], nextIntendedAction: 'inspect router',
    }));
    expect(m.completedTaskIds).toEqual(['a', 'b']); // sorted
    expect(m.goalId).toBe('G');
    expect(m.taskGraphVersion).toBe(3);
    expect(m.workspaceRevisionId).toBe('R3');
    expect(m.discoveries).toEqual(['found X']);
    expect(m.nextIntendedAction).toBe('inspect router');
  });

  it('holds no authoritative state objects — only ids/versions/strings', () => {
    const m = buildContinuationManifest(buildInput());
    const walk = (v: unknown): void => {
      if (typeof v === 'function') throw new Error('manifest exposed a callable');
      if (v && typeof v === 'object') for (const x of Object.values(v)) walk(x);
    };
    walk(m);
    // No embedded Task/TaskGraph/Session objects — references are strings/numbers.
    expect(typeof m.taskGraphVersion).toBe('number');
    expect(typeof m.workspaceRevisionId).toBe('string');
  });

  it('is deterministic', () => {
    expect(buildContinuationManifest(buildInput())).toEqual(buildContinuationManifest(buildInput()));
  });
});

describe('P9.6 validateContinuationManifest — authoritative state wins', () => {
  it('valid when every reference resolves against the reloaded state', () => {
    const m = buildContinuationManifest(buildInput());
    const r = validateContinuationManifest(m, auth());
    expect(r.valid).toBe(true);
    expect(r.staleRefs).toEqual([]);
  });

  it('flags a goal mismatch', () => {
    const m = buildContinuationManifest(buildInput());
    const r = validateContinuationManifest(m, auth({ goalId: 'G-DIFFERENT' }));
    expect(r.valid).toBe(false);
    expect(r.staleRefs).toContainEqual({ kind: 'goal', ref: 'G' });
  });

  it('flags a manifest graph version ahead of the reloaded one', () => {
    const m = buildContinuationManifest(buildInput({ taskGraphVersion: 5 }));
    const r = validateContinuationManifest(m, auth({ currentGraphVersion: 3 }));
    expect(r.staleRefs).toContainEqual({ kind: 'graph_version', ref: '5' });
  });

  it('accepts a manifest graph version behind the reloaded one (older but valid)', () => {
    const m = buildContinuationManifest(buildInput({ taskGraphVersion: 2 }));
    const r = validateContinuationManifest(m, auth({ currentGraphVersion: 3 }));
    expect(r.staleRefs.some((s) => s.kind === 'graph_version')).toBe(false);
  });

  it('flags a drifted workspace revision', () => {
    const m = buildContinuationManifest(buildInput({ workspaceRevision: { revisionId: 'R-OLD' } }));
    const r = validateContinuationManifest(m, auth({ currentRevisionId: 'R3' }));
    expect(r.staleRefs).toContainEqual({ kind: 'workspace_revision', ref: 'R-OLD' });
  });

  it('flags task and verification refs that no longer exist', () => {
    const m = buildContinuationManifest(buildInput({ activeTaskIds: ['gone'], verificationIds: ['V-gone'] }));
    const r = validateContinuationManifest(m, auth());
    expect(r.staleRefs).toContainEqual({ kind: 'task', ref: 'gone' });
    expect(r.staleRefs).toContainEqual({ kind: 'verification', ref: 'V-gone' });
  });

  it('flags a missing checkpoint reference', () => {
    const m = buildContinuationManifest(buildInput({ checkpointId: 'CP-gone' }));
    const r = validateContinuationManifest(m, auth({ knownCheckpointIds: ['CP1'] }));
    expect(r.staleRefs).toContainEqual({ kind: 'checkpoint', ref: 'CP-gone' });
  });

  it('stale refs are sorted deterministically', () => {
    const m = buildContinuationManifest(buildInput({ activeTaskIds: ['z'], verificationIds: ['V-z'] }));
    const r = validateContinuationManifest(m, auth({ goalId: 'G-X' }));
    // goal < task < verification by kind order.
    expect(r.staleRefs.map((s) => s.kind)).toEqual(['goal', 'task', 'verification']);
  });
});
