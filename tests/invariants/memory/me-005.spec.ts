// ME-005 — RAG content ngoài (docs/repo) được đánh dấu untrusted + ghi nguồn.
//
// Enforced by: (1) the RAG retrievers (P7-RAG1) always record a source `path` on
// every RagItem, and (2) the deterministic TrustMarker, which maps the source
// kinds RAG items carry to `untrusted`. When a RagItem becomes a ContextItem it
// uses a workspace source kind -> untrusted (CX-003 / ME-002 share this guard).
import { describe, it, expect } from 'vitest';
import { assignTrust } from '@codeforge/agent-core';
import { DocRetriever } from '@codeforge/infrastructure';

describe('ME-005 — RAG content is untrusted + sourced', () => {
  it('every RAG item records its source path (provenance)', () => {
    const r = new DocRetriever();
    const docs = new Map<string, string>([
      ['docs/auth.md', 'authentication and login flow'],
      ['docs/other.md', 'unrelated content here'],
    ]);
    const items = r.retrieve({ text: 'authentication', limit: 10 }, docs);
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item.path.length).toBeGreaterThan(0); // source recorded
      expect(item.source).toBe('doc');
      expect(item.reason.length).toBeGreaterThan(0); // provenance reason
    }
  });

  it('the source kinds RAG content maps to are untrusted', () => {
    // Doc/repo RAG content surfaces as workspace-derived context → untrusted.
    expect(assignTrust('workspace_file')).toBe('untrusted');
    expect(assignTrust('workspace_symbol')).toBe('untrusted');
    expect(assignTrust('memory')).toBe('untrusted');
  });
});
