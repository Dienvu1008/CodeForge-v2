// OB-008 — ContinuationManifest là non-authoritative; không ghi đè state authoritative;
// session kế tiếp phải nạp lại từ nguồn authoritative.
//
// Invariants-first: enforcement lands with P9.6 (ContinuationManifest). Contract: the
// manifest is a hint for session rollover (goal, current/completed/blocked work,
// discoveries, next action, evidence refs). It is NOT authority: the next session
// bootstraps by reloading TaskGraph/Task state/WorkspaceRevision/Verification/Budget/
// Checkpoint from SQLite and validating that the manifest's references are still valid.
// A manifest can never overwrite authoritative state.
import { describe, it } from 'vitest';

describe('OB-008 — continuation manifest is non-authoritative', () => {
  it.todo('the manifest carries only references + hints, no authoritative state writes (P9.6)');
  it.todo('bootstrap reloads authoritative state from SQLite and validates manifest refs (P9.6)');
});
