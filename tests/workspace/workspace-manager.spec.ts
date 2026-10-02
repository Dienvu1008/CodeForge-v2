// P3-WM1/FS1/AS1 — WorkspaceManager + FilesystemExecutor + ArtifactStore.
// Uses real temp directories (mkdtemp) — no mocks.
// WS-003/004/005/006/010 enforcement + artifact persistence.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  SqliteDatabaseAdapter,
  runMigrations,
  createMigrationRegistry,
  NodeWorkspaceManager,
  FilesystemExecutor,
  ArtifactStore,
  migration0004,
} from '@codeforge/infrastructure';
import { WorkspaceError, type DirEntry } from '@codeforge/agent-core';
import type { ToolCall } from '@codeforge/agent-core';

function makeCounters(): { now: () => string; nextId: () => string } {
  let t = 0; let n = 0;
  return {
    now:    () => `2026-01-01T00:00:${String(t++).padStart(2, '0')}.000Z`,
    nextId: () => `ID-${String(n++).padStart(4, '0')}`,
  };
}

function fakeToolCall(toolName: string, args: Record<string, unknown>): ToolCall {
  return {
    toolCallId: 'TC1', sessionId: 'S', toolName, toolVersion: '1.0',
    riskClass: 'READ_ONLY', arguments: args, argumentsHash: 'H',
    state: 'APPROVED', proposedBy: 'model',
    provenance: { provenanceId: 'P', source: { kind: 'model', id: 'test' }, inputs: [], reason: 'test', at: 't' },
    requestedAt: 't',
  };
}

let dir: string;
let c: ReturnType<typeof makeCounters>;
let wm: NodeWorkspaceManager;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cf2-wm-'));
  c   = makeCounters();
  wm  = new NodeWorkspaceManager({ root: dir.replace(/\\/g, '/'), now: c.now, nextId: c.nextId });
  // Seed a couple of files.
  await writeFile(join(dir, 'hello.ts'), 'export const x = 1;\n');
  await mkdir(join(dir, 'src'));
  await writeFile(join(dir, 'src', 'main.ts'), 'export {};\n');
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

// ─────────────────────────────────────────────────────────────────────────────
// NodeWorkspaceManager — WS-003/004/005/010
// ─────────────────────────────────────────────────────────────────────────────

describe('NodeWorkspaceManager.readFile', () => {
  it('reads an existing file', async () => {
    const content = await wm.readFile('hello.ts');
    expect(content).toContain('export const x = 1');
  });

  it('throws NOT_FOUND for missing file', async () => {
    await expect(wm.readFile('nonexistent.ts')).rejects.toBeInstanceOf(WorkspaceError);
    await expect(wm.readFile('nonexistent.ts')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('NodeWorkspaceManager.writeFile — WS-010 ChangeRecord', () => {
  it('creates a file and returns a ChangeRecord', async () => {
    const change = await wm.writeFile('new.ts', 'export const y = 2;', 'S');
    expect(change.kind).toBe('create');
    expect(change.relpath).toBe('new.ts');
    expect(change.ownedBy).toBe('agent');
    expect(change.sessionId).toBe('S');
    const content = await readFile(join(dir, 'new.ts'), 'utf8');
    expect(content).toBe('export const y = 2;');
  });

  it('overwrites existing file with kind=modify', async () => {
    const change = await wm.writeFile('hello.ts', 'export const x = 42;', 'S');
    expect(change.kind).toBe('modify');
    expect(change.relpath).toBe('hello.ts');
  });

  it('creates nested directories automatically (mkdirp)', async () => {
    await expect(wm.writeFile('deep/nested/file.ts', 'ok', 'S')).resolves.toBeDefined();
    const content = await readFile(join(dir, 'deep', 'nested', 'file.ts'), 'utf8');
    expect(content).toBe('ok');
  });
});

describe('NodeWorkspaceManager.deleteFile', () => {
  it('deletes a file and returns ChangeRecord with kind=delete', async () => {
    const change = await wm.deleteFile('hello.ts', 'S');
    expect(change.kind).toBe('delete');
    await expect(wm.fileExists('hello.ts')).resolves.toBe(false);
  });
});

describe('NodeWorkspaceManager.listDir', () => {
  it('lists root directory contents', async () => {
    const entries = await wm.listDir('.');
    const names = entries.map((e: DirEntry) => e.name);
    expect(names).toContain('hello.ts');
    expect(names).toContain('src');
  });

  it('lists subdirectory', async () => {
    const entries = await wm.listDir('src');
    expect(entries.map((e: DirEntry) => e.name)).toContain('main.ts');
  });

  it('entry relpaths are workspace-relative', async () => {
    const entries = await wm.listDir('src');
    const main = entries.find((e: DirEntry) => e.name === 'main.ts');
    expect(main?.relpath).toBe('src/main.ts');
  });
});

describe('NodeWorkspaceManager — WS-003 path traversal guard', () => {
  it('rejects "../" path traversal', async () => {
    await expect(wm.readFile('../etc/passwd')).rejects.toBeInstanceOf(WorkspaceError);
  });

  it('rejects absolute path', async () => {
    await expect(wm.readFile('/etc/passwd')).rejects.toBeInstanceOf(WorkspaceError);
  });
});

describe('NodeWorkspaceManager.fileExists / dirExists', () => {
  it('returns true for existing file', async () => {
    expect(await wm.fileExists('hello.ts')).toBe(true);
  });
  it('returns false for missing file', async () => {
    expect(await wm.fileExists('nope.ts')).toBe(false);
  });
  it('returns true for existing directory', async () => {
    expect(await wm.dirExists('src')).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// FilesystemExecutor — real file operations
// ─────────────────────────────────────────────────────────────────────────────

describe('FilesystemExecutor', () => {
  let exec: FilesystemExecutor;

  beforeEach(() => {
    exec = new FilesystemExecutor({ workspace: wm });
  });

  it('read_file returns file content', async () => {
    const result = await exec.execute(fakeToolCall('read_file', { path: 'hello.ts' }));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('export const x = 1');
    expect(result.timedOut).toBe(false);
  });

  it('write_file creates a file', async () => {
    const call = fakeToolCall('write_file', { path: 'created.ts', content: 'const z = 3;' });
    const result = await exec.execute(call);
    expect(result.exitCode).toBe(0);
    expect(await wm.fileExists('created.ts')).toBe(true);
  });

  it('list_dir returns directory entries', async () => {
    const result = await exec.execute(fakeToolCall('list_dir', { path: 'src' }));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('main.ts');
  });

  it('delete_file removes a file', async () => {
    const call = { ...fakeToolCall('delete_file', { path: 'hello.ts' }), sessionId: 'S' };
    const result = await exec.execute(call);
    expect(result.exitCode).toBe(0);
    expect(await wm.fileExists('hello.ts')).toBe(false);
  });

  it('read_file on missing file returns exitCode=1 with error in stderr', async () => {
    const result = await exec.execute(fakeToolCall('read_file', { path: 'missing.ts' }));
    expect(result.exitCode).toBe(1);
    expect(result.stderr.length).toBeGreaterThan(0);
  });

  it('unknown tool returns exitCode=1', async () => {
    const result = await exec.execute(fakeToolCall('unknown_tool', {}));
    expect(result.exitCode).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ArtifactStore — migration v4 + disk persistence
// ─────────────────────────────────────────────────────────────────────────────

describe('ArtifactStore — P3-AS1', () => {
  let db: SqliteDatabaseAdapter;
  let store: ArtifactStore;
  let artifactDir: string;

  beforeEach(async () => {
    artifactDir = await mkdtemp(join(tmpdir(), 'cf2-artifacts-'));
    db = new SqliteDatabaseAdapter(':memory:');
    db.open();
    runMigrations(db, createMigrationRegistry(), { now: () => 't' });
    db.execute(`INSERT INTO sessions (session_id, workspace_id, workspace_root, goal_id, graph_version, state, created_at, updated_at, runtime_version, schema_version, budget_id, lock_id, metadata_json) VALUES ('S','W','/r','G',1,'RUNNING','t','t','0.4.0',1,'B','L','{}')`);
    store = new ArtifactStore({ db, artifactDir, now: c.now, nextId: c.nextId });
  });
  afterEach(async () => {
    db.close();
    await rm(artifactDir, { recursive: true, force: true });
  });

  it('writes an artifact to disk + SQLite metadata', async () => {
    const rec = await store.write('hello artifact', { sessionId: 'S', kind: 'stdout', contentType: 'text/plain' });
    expect(rec.artifactId).toBeTruthy();
    expect(rec.sizeBytes).toBe(Buffer.byteLength('hello artifact'));
    expect(rec.kind).toBe('stdout');

    // Metadata in SQLite.
    const meta = store.getMetadata(rec.artifactId);
    expect(meta?.sessionId).toBe('S');
    expect(meta?.contentType).toBe('text/plain');
  });

  it('reads artifact content back from disk', async () => {
    const content = 'some stdout output';
    const rec = await store.write(content, { sessionId: 'S', kind: 'stdout', contentType: 'text/plain' });
    const buf = await store.read(rec.artifactId);
    expect(buf.toString('utf8')).toBe(content);
  });

  it('getMetadata returns null for unknown id', () => {
    expect(store.getMetadata('no-such-id')).toBeNull();
  });

  it('migration0004: artifacts table exists with kind CHECK', () => {
    // Table created by migration v4.
    expect(() => db.query('SELECT * FROM artifacts LIMIT 0')).not.toThrow();
    // Invalid kind rejected by CHECK constraint.
    expect(() =>
      db.execute(`INSERT INTO artifacts (artifact_id, session_id, kind, content_type, size_bytes, storage_path, created_at) VALUES ('A1','S','invalid_kind','text/plain',0,'x','t')`),
    ).toThrow();
  });

  it('migration0004 has correct version bounds (CP-007)', () => {
    expect(migration0004.fromVersion).toBe(3);
    expect(migration0004.toVersion).toBe(4);
    expect(migration0004.reversible).toBe(true);
  });
});
