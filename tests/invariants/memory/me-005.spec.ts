// ME-005 — RAG content ngoài (docs/repo) được đánh dấu untrusted + ghi nguồn.
//
// Testable now: external/workspace-derived content maps to untrusted trust. The
// RAG retrievers (DocRetriever/RepoRetriever, P7-RAG1) will emit items with these
// source kinds; the trust assignment is already deterministic.
import { describe, it, expect } from 'vitest';
import { assignTrust } from '@codeforge/agent-core';

describe('ME-005 — RAG content is untrusted + sourced', () => {
  it('workspace-file-derived RAG content is untrusted', () => {
    expect(assignTrust('workspace_file')).toBe('untrusted');
  });

  it('memory-sourced RAG content is untrusted', () => {
    expect(assignTrust('memory')).toBe('untrusted');
  });

  // Enforcement that provenance records the external source lands with P7-RAG1
  // (DocRetriever/RepoRetriever) — each RAG item will carry provenance.source.
  it.todo('RAG items record their external source in provenance (P7-RAG1)');
});
