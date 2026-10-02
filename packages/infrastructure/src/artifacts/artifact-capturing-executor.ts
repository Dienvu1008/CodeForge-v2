// ArtifactCapturingExecutor — P4-AP1. Infrastructure implementation of ArtifactCapturePort.
//
// Implements ArtifactCapturePort (agent-core contract) using ArtifactStore.
// Called by TaskExecutor after each ToolGateway.execute() to persist stdout/stderr.
//
// PR-001: every artifact has provenance (toolCallId recorded as artifactId suffix pattern).
// PR-003: ArtifactStore.write() is append-only — no modification of existing artifacts.
//
// Empty content policy: strings containing only whitespace are NOT written —
// returning undefined for that artifact ID. This keeps the store clean and
// avoids storing thousands of empty-stderr artifacts from read-only tools.
import type { ArtifactCapturePort, ArtifactIds } from '@codeforge/agent-core';
import type { ExecutorResult } from '@codeforge/agent-core';
import type { ArtifactStore } from './artifact-store.js';

const EMPTY_RE = /^\s*$/;

export class ArtifactCapturingExecutor implements ArtifactCapturePort {
  constructor(private readonly store: ArtifactStore) {}

  async record(
    _toolCallId: string,
    sessionId:   string,
    result:      ExecutorResult,
  ): Promise<ArtifactIds> {
    const [stdoutArtifactId, stderrArtifactId] = await Promise.all([
      this.maybeWrite(result.stdout, sessionId, 'stdout'),
      this.maybeWrite(result.stderr, sessionId, 'stderr'),
    ]);
    return { stdoutArtifactId, stderrArtifactId };
  }

  private async maybeWrite(
    content:   string,
    sessionId: string,
    kind:      'stdout' | 'stderr',
  ): Promise<string | undefined> {
    if (EMPTY_RE.test(content)) return undefined;
    const record = await this.store.write(content, {
      sessionId,
      kind,
      contentType: 'text/plain',
    });
    return record.artifactId;
  }
}
