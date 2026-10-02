// ArtifactStore — P3-AS1. Persistent artifact storage (§39 Architecture Target).
//
// SQLite stores artifact METADATA only. Binary content lives on disk under
// <workspaceRoot>/.cf2/artifacts/<artifactId>.
// PR-003: artifacts are append-only (no update/delete in Phase 3).
import { promises as fsp } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseAdapter } from '../sqlite/types.js';

// ── ArtifactRecord ────────────────────────────────────────────────────────────

export interface ArtifactRecord {
  readonly artifactId:   string;
  readonly sessionId:    string;
  readonly kind:         'log' | 'stdout' | 'stderr' | 'patch' | 'test_result' | 'other';
  readonly contentType:  string;   // MIME, e.g. 'text/plain'
  readonly sizeBytes:    number;
  readonly sha256?:      string;
  readonly storagePath:  string;   // relative to artifactDir
  readonly createdAt:    string;
}

// ── ArtifactStoreDeps ─────────────────────────────────────────────────────────

export interface ArtifactStoreDeps {
  readonly db:          DatabaseAdapter;
  readonly artifactDir: string; // absolute dir for artifact files
  readonly now:         () => string;
  readonly nextId:      () => string;
}

// ── ArtifactStore ─────────────────────────────────────────────────────────────

export class ArtifactStore {
  constructor(private readonly deps: ArtifactStoreDeps) {}

  /**
   * Write content to an artifact file + persist metadata in SQLite.
   * Returns the ArtifactRecord with the assigned artifactId.
   */
  async write(
    content:   string | Buffer,
    meta: {
      sessionId:   string;
      kind:        ArtifactRecord['kind'];
      contentType: string;
    },
  ): Promise<ArtifactRecord> {
    const artifactId   = this.deps.nextId();
    const storagePath  = artifactId; // flat layout: artifactDir/<artifactId>
    const absPath      = join(this.deps.artifactDir, storagePath);

    // Ensure directory exists.
    await fsp.mkdir(this.deps.artifactDir, { recursive: true });

    const buf = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
    await fsp.writeFile(absPath, buf);

    const record: ArtifactRecord = {
      artifactId,
      sessionId:   meta.sessionId,
      kind:        meta.kind,
      contentType: meta.contentType,
      sizeBytes:   buf.length,
      storagePath,
      createdAt:   this.deps.now(),
    };

    this.deps.db.execute(
      `INSERT INTO artifacts
         (artifact_id, session_id, kind, content_type, size_bytes, storage_path, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        record.artifactId,
        record.sessionId,
        record.kind,
        record.contentType,
        record.sizeBytes,
        record.storagePath,
        record.createdAt,
      ],
    );

    return record;
  }

  /** Read artifact content from disk. */
  async read(artifactId: string): Promise<Buffer> {
    const rows = this.deps.db.query<{ storage_path: string }>(
      'SELECT storage_path FROM artifacts WHERE artifact_id = ?',
      [artifactId],
    );
    if (rows.length === 0) throw new Error(`artifact not found: ${artifactId}`);
    return fsp.readFile(join(this.deps.artifactDir, rows[0]!.storage_path));
  }

  /** Get artifact metadata. */
  getMetadata(artifactId: string): ArtifactRecord | null {
    const rows = this.deps.db.query<{
      artifact_id: string; session_id: string; kind: string;
      content_type: string; size_bytes: number; storage_path: string; created_at: string;
    }>('SELECT * FROM artifacts WHERE artifact_id = ?', [artifactId]);
    if (rows.length === 0) return null;
    const r = rows[0]!;
    return {
      artifactId:  r.artifact_id,
      sessionId:   r.session_id,
      kind:        r.kind as ArtifactRecord['kind'],
      contentType: r.content_type,
      sizeBytes:   r.size_bytes,
      storagePath: r.storage_path,
      createdAt:   r.created_at,
    };
  }
}
