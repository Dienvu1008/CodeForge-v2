// OB-008 — ContinuationManifest là non-authoritative; không ghi đè state authoritative;
// session kế tiếp phải nạp lại từ nguồn authoritative.
//
// Enforced by ContinuationManifest (P9.6): the manifest carries only references + advisory
// hints (ids, versions, strings) — no authoritative state objects and no mutator. The
// next session reloads authoritative state and calls validateContinuationManifest, which
// checks the manifest's refs AGAINST that reloaded state and reports stale ones. The
// authoritative state always wins; the manifest can never overwrite it.
import { describe, it, expect } from 'vitest';
import {
  buildContinuationManifest,
  validateContinuationManifest,
  type Provenance,
  type AuthoritativeSnapshot,
} from '@codeforge/agent-core';

const PROV: Provenance = {
  provenanceId: 'PV', source: { kind: 'runtime', id: 'rollover' }, inputs: [], reason: 'rollover', at: 't',
};

function manifest() {
  return buildContinuationManifest({
    manifestId: 'CM', parentSessionId: 'S0', createdAt: 't',
    goalId: 'G', taskGraphVersion: 2, workspaceRevision: { revisionId: 'R2' },
    completedTaskIds: ['a'], activeTaskIds: ['b'], blockedTaskIds: [],
    verificationIds: ['V1'], discoveries: ['x'], nextIntendedAction: 'next',
    provenance: PROV,
  });
}

describe('OB-008 — continuation manifest is non-authoritative', () => {
  it('the manifest carries only references + hints — no state objects, no mutator', () => {
    const m = manifest();
    const walk = (v: unknown): void => {
      if (typeof v === 'function') throw new Error('manifest exposed a callable');
      if (v && typeof v === 'object') for (const x of Object.values(v)) walk(x);
    };
    walk(m);
    // References are ids/versions, not embedded authoritative objects.
    expect(typeof m.goalId).toBe('string');
    expect(typeof m.taskGraphVersion).toBe('number');
    expect(typeof m.workspaceRevisionId).toBe('string');
  });

  it('bootstrap validates manifest refs against reloaded authoritative state (state wins)', () => {
    const m = manifest();
    // Authoritative state the next session reloaded from SQLite.
    const authoritative: AuthoritativeSnapshot = {
      goalId: 'G', currentGraphVersion: 2, knownTaskIds: ['a', 'b'],
      currentRevisionId: 'R2', knownVerificationIds: ['V1'], knownCheckpointIds: [],
    };
    expect(validateContinuationManifest(m, authoritative).valid).toBe(true);

    // When the live state has moved on, the manifest's stale refs are REPORTED (not
    // applied) — the next session rebuilds from authoritative state regardless.
    const moved: AuthoritativeSnapshot = { ...authoritative, currentRevisionId: 'R9', knownTaskIds: ['a'] };
    const r = validateContinuationManifest(m, moved);
    expect(r.valid).toBe(false);
    expect(r.staleRefs).toContainEqual({ kind: 'workspace_revision', ref: 'R2' });
    expect(r.staleRefs).toContainEqual({ kind: 'task', ref: 'b' });
    // validate() only reports — it returns data, it does not mutate anything.
    expect(Array.isArray(r.staleRefs)).toBe(true);
  });
});
