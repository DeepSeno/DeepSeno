import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import fs from 'fs';
import { transaction } from '../db/sqlite-util';

/**
 * Load sqlite-vec extension with fixes for Electron asar packaging.
 *
 * sqlite-vec's getLoadablePath() uses __dirname to find the platform-specific
 * package (e.g. sqlite-vec-windows-x64). In packaged Electron builds, __dirname
 * points inside app.asar but the native .dll/.dylib is in app.asar.unpacked.
 * We resolve the path manually to handle both dev and packaged builds.
 */
function loadSqliteVec(db: DatabaseSync): void {
  const platform = process.platform === 'win32' ? 'windows' : process.platform;
  const arch = process.arch;
  const pkgName = `sqlite-vec-${platform}-${arch}`;
  const ext = process.platform === 'win32' ? 'dll' : process.platform === 'darwin' ? 'dylib' : 'so';
  const fileName = `vec0.${ext}`;

  // Try multiple locations.
  // IMPORTANT: app.asar.unpacked must come FIRST. Electron patches fs to see
  // files inside app.asar, so existsSync() returns true for asar paths, but
  // SQLite's native dlopen() cannot load from inside an asar archive.
  const candidates = [
    // 1. app.asar.unpacked (packaged Electron) — must be checked first
    __dirname.includes('app.asar')
      ? path.join(__dirname.replace(/app\.asar[/\\].*/, `app.asar.unpacked/node_modules/${pkgName}/${fileName}`))
      : '',
    // 2. Relative to this file's __dirname (works in dev)
    path.join(__dirname, '../../node_modules', pkgName, fileName),
    // 3. Fallback: try require.resolve (handled below)
  ].filter(Boolean);

  let extPath = '';
  for (const p of candidates) {
    if (fs.existsSync(p)) { extPath = p; break; }
  }

  // Last resort: try sqlite-vec's own resolver
  if (!extPath) {
    try {
      const sqliteVec = require('sqlite-vec');
      extPath = sqliteVec.getLoadablePath();
      extPath = extPath.replace(/app\.asar([/\\])/, 'app.asar.unpacked$1');
    } catch (err) {
      throw new Error(`sqlite-vec extension not found (${pkgName}): ${err}`);
    }
  }

  // Strip extension: loadExtension() appends .dylib/.so/.dll automatically
  extPath = extPath.replace(/\.(dylib|so|dll)$/, '');
  db.loadExtension(extPath);
}

export class VectorStore {
  private db: DatabaseSync;
  private dimensions: number;

  constructor(db: DatabaseSync, dimensions: number = 1024) {
    this.db = db;
    this.dimensions = dimensions;
    loadSqliteVec(db);
    this.initTable();
  }

  private initTable(): void {
    // Schema version tracking for forward-compatible migrations
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS vec_schema_version (version INTEGER NOT NULL)`,
    );
    const row = this.db
      .prepare('SELECT version FROM vec_schema_version')
      .get() as { version: number } | undefined;
    const currentVersion = row?.version ?? 0;

    if (currentVersion < 1) {
      this.db.exec(
        `CREATE VIRTUAL TABLE IF NOT EXISTS segment_vectors USING vec0(
          segment_id INTEGER PRIMARY KEY,
          embedding float[${this.dimensions}]
        )`,
      );
      if (currentVersion === 0 && !row) {
        this.db.exec(`INSERT INTO vec_schema_version VALUES (1)`);
      } else {
        this.db.exec(`UPDATE vec_schema_version SET version = 1`);
      }
    }
    if (currentVersion < 2) {
      this.db.exec(
        `CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_page_vectors USING vec0(
          page_id INTEGER PRIMARY KEY,
          embedding float[${this.dimensions}]
        )`,
      );
      this.db.exec(`UPDATE vec_schema_version SET version = 2`);
    }
    if (currentVersion < 3) {
      this.db.exec(
        `CREATE VIRTUAL TABLE IF NOT EXISTS external_chunk_vectors USING vec0(
          chunk_id INTEGER PRIMARY KEY,
          embedding float[${this.dimensions}]
        )`,
      );
      this.db.exec(`UPDATE vec_schema_version SET version = 3`);
    }
  }

  getDimensions(): number {
    return this.dimensions;
  }

  healthCheck(): void {
    this.db.prepare('SELECT COUNT(*) AS count FROM segment_vectors').get();
    this.db.prepare('SELECT COUNT(*) AS count FROM knowledge_page_vectors').get();
    this.db.prepare('SELECT COUNT(*) AS count FROM external_chunk_vectors').get();
  }

  private assertDim(embedding: number[]): void {
    if (embedding.length !== this.dimensions) {
      throw new Error(
        `VectorStore dimension mismatch: table=${this.dimensions}, got=${embedding.length}. ` +
        `Embedding model changed — clear deepseno-vec.db or reset vector tables.`
      );
    }
  }

  insert(segmentId: number, embedding: number[]): void {
    this.assertDim(embedding);
    // vec0 virtual tables don't support INSERT OR REPLACE — wrap in transaction
    const txn = transaction(this.db, () => {
      this.db
        .prepare('DELETE FROM segment_vectors WHERE segment_id = ?')
        .run(BigInt(segmentId));
      this.db
        .prepare(
          'INSERT INTO segment_vectors (segment_id, embedding) VALUES (?, ?)'
        )
        .run(BigInt(segmentId), new Float32Array(embedding));
    });
    txn();
  }

  /** Batch insert/update multiple segment vectors in a single transaction. */
  batchInsert(items: Array<{ segmentId: number; embedding: number[] }>): void {
    if (items.length === 0) return;
    for (const { embedding } of items) this.assertDim(embedding);
    const delStmt = this.db.prepare('DELETE FROM segment_vectors WHERE segment_id = ?');
    const insStmt = this.db.prepare('INSERT INTO segment_vectors (segment_id, embedding) VALUES (?, ?)');
    transaction(this.db, () => {
      for (const { segmentId, embedding } of items) {
        delStmt.run(BigInt(segmentId));
        insStmt.run(BigInt(segmentId), new Float32Array(embedding));
      }
    })();
  }

  /** Delete vector entries for given segment IDs. */
  deleteSegments(segmentIds: number[]): void {
    if (segmentIds.length === 0) return;
    const stmt = this.db.prepare('DELETE FROM segment_vectors WHERE segment_id = ?');
    transaction(this.db, () => {
      for (const id of segmentIds) {
        stmt.run(BigInt(id));
      }
    })();
  }

  insertPageVector(pageId: number, embedding: number[]): void {
    this.assertDim(embedding);
    // vec0 virtual tables don't support INSERT OR REPLACE — wrap in transaction
    const txn = transaction(this.db, () => {
      this.db
        .prepare('DELETE FROM knowledge_page_vectors WHERE page_id = ?')
        .run(BigInt(pageId));
      this.db
        .prepare(
          'INSERT INTO knowledge_page_vectors (page_id, embedding) VALUES (?, ?)',
        )
        .run(BigInt(pageId), new Float32Array(embedding));
    });
    txn();
  }

  /** Search for the top-k most similar knowledge pages to the query embedding. */
  searchPages(
    queryEmbedding: number[],
    topK: number = 10,
  ): Array<{ page_id: number; distance: number }> {
    const rows = this.db
      .prepare(
        `
      SELECT page_id, distance
      FROM knowledge_page_vectors
      WHERE embedding MATCH ?
      ORDER BY distance
      LIMIT ?
    `,
      )
      .all(new Float32Array(queryEmbedding), topK) as Array<{
      page_id: number;
      distance: number;
    }>;
    return rows;
  }

  /** Delete vector entry for a knowledge page. */
  deletePageVector(pageId: number): void {
    this.db
      .prepare('DELETE FROM knowledge_page_vectors WHERE page_id = ?')
      .run(BigInt(pageId));
  }

  /** Insert/update external chunk vector. */
  insertExternalChunk(chunkId: number, embedding: number[]): void {
    this.assertDim(embedding);
    const txn = transaction(this.db, () => {
      this.db
        .prepare('DELETE FROM external_chunk_vectors WHERE chunk_id = ?')
        .run(BigInt(chunkId));
      this.db
        .prepare(
          'INSERT INTO external_chunk_vectors (chunk_id, embedding) VALUES (?, ?)',
        )
        .run(BigInt(chunkId), new Float32Array(embedding));
    });
    txn();
  }

  /** Batch insert/update external chunk vectors. */
  batchInsertExternalChunks(items: Array<{ chunkId: number; embedding: number[] }>): void {
    if (items.length === 0) return;
    for (const { embedding } of items) this.assertDim(embedding);
    const delStmt = this.db.prepare('DELETE FROM external_chunk_vectors WHERE chunk_id = ?');
    const insStmt = this.db.prepare('INSERT INTO external_chunk_vectors (chunk_id, embedding) VALUES (?, ?)');
    transaction(this.db, () => {
      for (const { chunkId, embedding } of items) {
        delStmt.run(BigInt(chunkId));
        insStmt.run(BigInt(chunkId), new Float32Array(embedding));
      }
    })();
  }

  /** Delete external chunk vectors for given chunk IDs. */
  deleteExternalChunks(chunkIds: number[]): void {
    if (chunkIds.length === 0) return;
    const stmt = this.db.prepare('DELETE FROM external_chunk_vectors WHERE chunk_id = ?');
    transaction(this.db, () => {
      for (const id of chunkIds) {
        stmt.run(BigInt(id));
      }
    })();
  }

  /** Search external chunk vectors. */
  searchExternalChunks(
    queryEmbedding: number[],
    topK: number = 10,
  ): Array<{ chunk_id: number; distance: number }> {
    this.assertDim(queryEmbedding);
    const rows = this.db
      .prepare(
        `SELECT chunk_id, distance
         FROM external_chunk_vectors
         WHERE embedding MATCH ?
         ORDER BY distance
         LIMIT ?`,
      )
      .all(new Float32Array(queryEmbedding), topK) as Array<{
      chunk_id: number;
      distance: number;
    }>;
    return rows;
  }

  /** Search for the top-k most similar segments to the query embedding. */
  search(
    queryEmbedding: number[],
    topK: number = 10
  ): Array<{ segment_id: number; distance: number }> {
    const rows = this.db
      .prepare(
        `
      SELECT segment_id, distance
      FROM segment_vectors
      WHERE embedding MATCH ?
      ORDER BY distance
      LIMIT ?
    `
      )
      .all(new Float32Array(queryEmbedding), topK) as Array<{
      segment_id: number;
      distance: number;
    }>;

    return rows;
  }

  /**
   * Search top-k similar segments restricted to a set of segment IDs (e.g. a single recording).
   * Uses sqlite-vec's `vec_distance_cosine` for exact ranking within the allowlist.
   * Falls back to global-MATCH + post-filter if the SQL function path isn't available.
   */
  searchScoped(
    queryEmbedding: number[],
    allowedSegmentIds: number[],
    topK: number = 10,
  ): Array<{ segment_id: number; distance: number }> {
    if (allowedSegmentIds.length === 0) return [];
    this.assertDim(queryEmbedding);

    const ph = allowedSegmentIds.map(() => '?').join(',');
    const ids = allowedSegmentIds.map((id) => BigInt(id));
    try {
      // Exact path: cosine distance on the allowlist directly.
      const rows = this.db.prepare(
        `SELECT segment_id, vec_distance_cosine(embedding, ?) AS distance
         FROM segment_vectors
         WHERE segment_id IN (${ph})
         ORDER BY distance
         LIMIT ?`,
      ).all(new Float32Array(queryEmbedding), ...ids, topK) as Array<{
        segment_id: number;
        distance: number;
      }>;
      return rows;
    } catch (err) {
      console.log(`[VectorStore] searchScoped exact path failed, falling back: ${err}`);
    }

    // Fallback: ask global KNN for a generous K then post-filter. Capped so a huge corpus
    // can't blow up the KNN budget when sqlite-vec's exact path is unavailable.
    const allow = new Set(allowedSegmentIds);
    const targetK = Math.min(
      Math.max(topK * 10, allowedSegmentIds.length * 3, 100),
      2000,
    );
    const rows = this.search(queryEmbedding, targetK);
    return rows.filter((r) => allow.has(r.segment_id)).slice(0, topK);
  }
}
