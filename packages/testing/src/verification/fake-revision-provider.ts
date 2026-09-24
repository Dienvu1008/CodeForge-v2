// FakeRevisionProvider — deterministic test double for RevisionProvider (P1.5-VR1).
// Returns a pre-configured WorkspaceRevision without touching the filesystem.
import type { RevisionProvider } from '@codeforge/agent-core';
import type { WorkspaceRevision } from '@codeforge/agent-core';

export class FakeRevisionProvider implements RevisionProvider {
  private _current: WorkspaceRevision;
  private readonly _sequence: WorkspaceRevision[] = [];

  constructor(initial: WorkspaceRevision) {
    this._current = initial;
  }

  /** Enqueue revisions to return in order; each call to capture() pops the next one. */
  setSequence(revisions: WorkspaceRevision[]): this {
    this._sequence.push(...revisions);
    return this;
  }

  /** Override the current revision returned by all future capture() calls (unless sequence). */
  setCurrent(revision: WorkspaceRevision): this {
    this._current = revision;
    return this;
  }

  async capture(
    _reason: WorkspaceRevision['createdBy']['reason'],
  ): Promise<WorkspaceRevision> {
    if (this._sequence.length > 0) {
      const next = this._sequence.shift()!;
      this._current = next;
      return next;
    }
    return this._current;
  }
}
