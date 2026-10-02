// P4-AP1 — ArtifactCapturePort + ArtifactCapturingExecutor.
// Tests the full artifact pipeline: ToolExecutor result → ArtifactStore → IDs.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  ArtifactCapturingExecutor,
  ArtifactStore,
  SqliteDatabaseAdapter,
  runMigrations,
  createMigrationRegistry,
} from '@codeforge/infrastructure';
import type { ExecutorResult } from '@codeforge/agent-core';

// ── helpers ───────────────────────────────────────────────────────────────────

let counter = 0;
function nextId(): string { return `AID-${String(++counter).padStart(6, '0')}`; }
function now(): string    { return '2026-01-01T00:00:00.000Z'; }

function makeResult(stdout: string, stderr: string, exitCode = 0): ExecutorResult {
  return { exitCode, stdout, stderr, timedOut: false };
}

// ── ArtifactCapturingExecutor ─────────────────────────────────────────────────

describe('ArtifactCapturingExecutor (P4-AP1)', () => {
  let tmpDir:   string;
  let db:       SqliteDatabaseAdapter;
  let store:    ArtifactStore;
  let capturer: ArtifactCapturingExecutor;

  beforeEach(async () => {
    counter = 0;
    tmpDir = await mkdtemp(join(tmpdir(), 'cf2-art-'));
    db = new SqliteDatabaseAdapter(':memory:');
    db.open();
    runMigrations(db, createMigrationRegistry(), { now });
    // Seed session row for FK constraint on artifacts.session_id.
    db.execute(
      `INSERT INTO sessions
         (session_id, workspace_id, workspace_root, goal_id, graph_version, state,
          created_at, updated_at, runtime_version, schema_version, budget_id, lock_id, metadata_json)
       VALUES ('SE-001','WS','/',  'G',1,'RUNNING','t','t','0.4.0',1,'B','L','{}')`,
    );
    store = new ArtifactStore({ db, artifactDir: tmpDir, now, nextId });
    capturer = new ArtifactCapturingExecutor(store);
  });

  afterEach(async () => {
    db.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  // ── happy path: stdout + stderr both present ──────────────────────────────

  it('records non-empty stdout and stderr, returns both artifact IDs', async () => {
    const result = makeResult('file content here', 'warning: deprecated');
    const ids = await capturer.record('TC-001', 'SE-001', result);

    expect(ids.stdoutArtifactId).toBeDefined();
    expect(ids.stderrArtifactId).toBeDefined();
    expect(ids.stdoutArtifactId).not.toBe(ids.stderrArtifactId);
  });

  // ── content verified on disk ──────────────────────────────────────────────

  it('stdout content is readable back via ArtifactStore.read()', async () => {
    const ids = await capturer.record('TC-001', 'SE-001', makeResult('hello world\n', ''));
    const buf = await store.read(ids.stdoutArtifactId!);
    expect(buf.toString('utf8')).toBe('hello world\n');
  });

  it('stderr content is readable back via ArtifactStore.read()', async () => {
    const ids = await capturer.record('TC-001', 'SE-001', makeResult('', 'error: file not found'));
    const buf = await store.read(ids.stderrArtifactId!);
    expect(buf.toString('utf8')).toBe('error: file not found');
  });

  // ── empty content is not persisted ───────────────────────────────────────

  it('empty stdout returns undefined stdoutArtifactId', async () => {
    const ids = await capturer.record('TC-001', 'SE-001', makeResult('', 'some stderr'));
    expect(ids.stdoutArtifactId).toBeUndefined();
    expect(ids.stderrArtifactId).toBeDefined();
  });

  it('empty stderr returns undefined stderrArtifactId', async () => {
    const ids = await capturer.record('TC-001', 'SE-001', makeResult('some stdout', ''));
    expect(ids.stdoutArtifactId).toBeDefined();
    expect(ids.stderrArtifactId).toBeUndefined();
  });

  it('both empty returns both undefined — no artifact written', async () => {
    const ids = await capturer.record('TC-001', 'SE-001', makeResult('', ''));
    expect(ids.stdoutArtifactId).toBeUndefined();
    expect(ids.stderrArtifactId).toBeUndefined();
  });

  it('whitespace-only content is treated as empty', async () => {
    const ids = await capturer.record('TC-001', 'SE-001', makeResult('   \n\t ', '  '));
    expect(ids.stdoutArtifactId).toBeUndefined();
    expect(ids.stderrArtifactId).toBeUndefined();
  });

  // ── PR-003 append-only: multiple calls produce distinct artifacts ─────────

  it('two calls with same content produce two distinct artifact IDs (PR-003 append-only)', async () => {
    const r = makeResult('same output', '');
    const ids1 = await capturer.record('TC-001', 'SE-001', r);
    const ids2 = await capturer.record('TC-002', 'SE-001', r);
    expect(ids1.stdoutArtifactId).not.toBe(ids2.stdoutArtifactId);
  });

  // ── SQLite metadata correct ───────────────────────────────────────────────

  it('persisted artifact metadata has correct kind and sessionId', async () => {
    const ids = await capturer.record('TC-001', 'SE-001', makeResult('data', 'err'));
    const stdoutMeta = store.getMetadata(ids.stdoutArtifactId!);
    expect(stdoutMeta?.kind).toBe('stdout');
    expect(stdoutMeta?.sessionId).toBe('SE-001');
    const stderrMeta = store.getMetadata(ids.stderrArtifactId!);
    expect(stderrMeta?.kind).toBe('stderr');
  });

  it('contentType is text/plain', async () => {
    const ids = await capturer.record('TC-001', 'SE-001', makeResult('x', 'y'));
    expect(store.getMetadata(ids.stdoutArtifactId!)?.contentType).toBe('text/plain');
    expect(store.getMetadata(ids.stderrArtifactId!)?.contentType).toBe('text/plain');
  });

  // ── toolCallId is accepted without error ──────────────────────────────────

  it('accepts any toolCallId string without error', async () => {
    await expect(
      capturer.record('ULID-01ABCDEF', 'SE-001', makeResult('ok', '')),
    ).resolves.toBeDefined();
  });
});
