// ME-007 — Memory/RAG không bypass Policy/ToolGateway để lấy dữ liệu.
//
// v1 RAG is local-only: DocRetriever/RepoRetriever read ONLY the data map the
// caller supplies — no filesystem walk of their own, no network, no process
// spawn. There is therefore no data-fetch path that could bypass Policy or the
// ToolGateway. (Any future network RAG must route through ToolGateway +
// NetworkPolicy; the architectural guard DC-003 — agent-core ↛ infrastructure/
// tools — is enforced by dependency-cruiser in the main suite.)
import { describe, it, expect } from 'vitest';
import { DocRetriever } from '@codeforge/infrastructure';

describe('ME-007 — memory/RAG never bypass Policy/ToolGateway', () => {
  it('DocRetriever returns nothing when given no documents (no self-fetch)', () => {
    const r = new DocRetriever();
    // Empty corpus -> empty result. The retriever does not go looking for docs
    // on its own; it operates solely on the provided map.
    expect(r.retrieve({ text: 'anything', limit: 10 }, new Map())).toEqual([]);
  });

  it('DocRetriever only ever returns items drawn from the provided corpus', () => {
    const r = new DocRetriever();
    const docs = new Map<string, string>([['a.md', 'alpha beta'], ['b.md', 'beta gamma']]);
    const items = r.retrieve({ text: 'beta', limit: 10 }, docs);
    const allowed = new Set(docs.keys());
    for (const item of items) {
      expect(allowed.has(item.path)).toBe(true); // never fabricates a source
    }
  });
});
