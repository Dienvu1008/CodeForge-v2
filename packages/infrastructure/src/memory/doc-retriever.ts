// DocRetriever — P7-RAG1. Local documentation retrieval (RAG, read-only).
//
// Indexes local docs (e.g. *.md in the workspace) and returns the most relevant
// chunks as RagItems. Deterministic: scoring is a pure function of (query, docs),
// ranked by term-overlap desc then path asc. No network, no ToolGateway bypass
// (ME-007) — it reads only the docs map the caller supplies. Every item records
// its source path and is untrusted evidence (ME-005).
import type { RagItem } from '@codeforge/agent-core';

export interface DocQuery {
  /** Free-text query; split into terms for overlap scoring. */
  readonly text?:  string;
  /** Additional term hints (e.g. tags) folded into the query terms. */
  readonly terms?: readonly string[];
  readonly limit:  number;
}

export class DocRetriever {
  /**
   * Rank `docs` (path -> content) by term overlap with the query and return the
   * top `limit` as RagItems. Only docs with a non-zero score are returned.
   */
  retrieve(query: DocQuery, docs: ReadonlyMap<string, string>): readonly RagItem[] {
    const queryTerms = termSet([query.text ?? '', ...(query.terms ?? [])].join(' '));
    if (queryTerms.size === 0) return [];

    const scored: RagItem[] = [];
    for (const [path, content] of docs) {
      const score = overlapScore(content, queryTerms);
      if (score <= 0) continue;
      scored.push({
        source: 'doc',
        path,
        content,
        score,
        reason: `doc relevant to query (score ${score})`,
      });
    }

    scored.sort((a, b) => (b.score !== a.score ? b.score - a.score : a.path.localeCompare(b.path)));
    return scored.slice(0, Math.max(0, query.limit));
  }
}

// ── scoring ──────────────────────────────────────────────────────────────────

/** Lowercased alphanumeric terms of length >= 2. Deterministic tokenization. */
function termSet(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.toLowerCase().matchAll(/[a-z0-9_]{2,}/g)) {
    out.add(m[0]);
  }
  return out;
}

/** Number of distinct query terms that appear in the document. */
function overlapScore(content: string, queryTerms: ReadonlySet<string>): number {
  const docTerms = termSet(content);
  let n = 0;
  for (const t of queryTerms) {
    if (docTerms.has(t)) n++;
  }
  return n;
}
