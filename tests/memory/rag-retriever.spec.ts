// P7-RAG1 — DocRetriever + RepoRetriever.
import { describe, it, expect, beforeAll } from 'vitest';
import { DocRetriever, RepoRetriever, TreeSitterAdapter } from '@codeforge/infrastructure';

const paths = (items: readonly { path: string }[]): string[] => items.map((i) => i.path);

describe('P7-RAG1 DocRetriever', () => {
  const r = new DocRetriever();
  const docs = new Map<string, string>([
    ['docs/auth.md', 'Authentication covers login, logout and session handling.'],
    ['docs/db.md', 'The database layer uses SQLite with migrations.'],
    ['docs/auth-advanced.md', 'Advanced authentication: token refresh and session rotation.'],
  ]);

  it('ranks docs by term overlap with the query', () => {
    const items = r.retrieve({ text: 'authentication session', limit: 10 }, docs);
    // Both auth docs mention authentication + session; db.md matches neither.
    expect(paths(items)).not.toContain('docs/db.md');
    expect(paths(items)).toContain('docs/auth.md');
    expect(paths(items)).toContain('docs/auth-advanced.md');
  });

  it('records source + marks RAG provenance reason', () => {
    const items = r.retrieve({ text: 'migrations', limit: 10 }, docs);
    expect(items[0]?.path).toBe('docs/db.md');
    expect(items[0]?.source).toBe('doc');
    expect(items[0]?.reason).toContain('score');
  });

  it('applies the limit and is deterministic', () => {
    const q = { text: 'authentication', limit: 1 } as const;
    const a = r.retrieve(q, docs);
    const b = r.retrieve(q, docs);
    expect(a).toHaveLength(1);
    expect(paths(a)).toEqual(paths(b));
  });

  it('returns nothing for a query with no overlapping terms', () => {
    expect(r.retrieve({ text: 'quantum chromodynamics', limit: 10 }, docs)).toEqual([]);
  });
});

describe('P7-RAG1 RepoRetriever (SX1/IG1 integration)', () => {
  let repo: RepoRetriever;

  beforeAll(async () => {
    const adapter = new TreeSitterAdapter();
    await adapter.initialize();
    repo = new RepoRetriever(adapter);
  });

  const files = new Map<string, string>([
    ['src/util.ts', 'export const helper = () => 1;'],
    ['src/a.ts', "import { helper } from './util';\nexport const a = helper;"],
    ['src/b.ts', "import { a } from './a';\nexport const b = a;"],
    ['src/unrelated.ts', 'export const z = 0;'],
  ]);

  it('returns files that import the seed, ranked by closeness', async () => {
    const items = await repo.retrieve({ seeds: ['src/util.ts'], limit: 10 }, files);
    const p = paths(items);
    // a imports util (distance 1), b imports a (distance 2); unrelated excluded.
    expect(p).toContain('src/a.ts');
    expect(p).toContain('src/b.ts');
    expect(p).not.toContain('src/unrelated.ts');
    // a.ts (closer) ranks above b.ts.
    expect(p.indexOf('src/a.ts')).toBeLessThan(p.indexOf('src/b.ts'));
    // seed excluded by default.
    expect(p).not.toContain('src/util.ts');
  });

  it('can include the seed when requested', async () => {
    const items = await repo.retrieve({ seeds: ['src/util.ts'], limit: 10, includeSeeds: true }, files);
    expect(paths(items)).toContain('src/util.ts');
  });

  it('records repo source + reason', async () => {
    const items = await repo.retrieve({ seeds: ['src/util.ts'], limit: 10 }, files);
    for (const item of items) {
      expect(item.source).toBe('repo');
      expect(item.path.length).toBeGreaterThan(0);
      expect(item.reason).toContain('seed');
    }
  });

  it('is deterministic across runs', async () => {
    const a = paths(await repo.retrieve({ seeds: ['src/util.ts'], limit: 10 }, files));
    const b = paths(await repo.retrieve({ seeds: ['src/util.ts'], limit: 10 }, files));
    expect(a).toEqual(b);
  });
});
