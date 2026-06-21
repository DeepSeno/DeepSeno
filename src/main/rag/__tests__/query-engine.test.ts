import { describe, it, expect, afterEach } from 'vitest';
import { VectorStore } from '../vector-store';
import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import os from 'os';
import fs from 'fs';

describe('VectorStore', () => {
  const dbPaths: string[] = [];

  function createTempDb(): { db: DatabaseSync; dbPath: string } {
    const dbPath = path.join(
      os.tmpdir(),
      `deepseno-vec-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.db`
    );
    dbPaths.push(dbPath);
    const db = new DatabaseSync(dbPath, { allowExtension: true });
    return { db, dbPath };
  }

  afterEach(() => {
    for (const p of dbPaths) {
      try {
        fs.unlinkSync(p);
      } catch {
        // ignore cleanup errors
      }
    }
    dbPaths.length = 0;
  });

  it('should insert and search vectors', () => {
    const { db } = createTempDb();
    const store = new VectorStore(db, 4); // small dimensions for testing

    store.insert(1, [1.0, 0.0, 0.0, 0.0]);
    store.insert(2, [0.0, 1.0, 0.0, 0.0]);
    store.insert(3, [0.9, 0.1, 0.0, 0.0]);

    const results = store.search([1.0, 0.0, 0.0, 0.0], 2);
    expect(results.length).toBe(2);
    // The closest match should be segment_id=1
    expect(results[0].segment_id).toBe(1);

    db.close();
  });

  it('should return empty results when no vectors are stored', () => {
    const { db } = createTempDb();
    const store = new VectorStore(db, 4);

    const results = store.search([1.0, 0.0, 0.0, 0.0], 5);
    expect(results.length).toBe(0);

    db.close();
  });

  it('should respect topK limit', () => {
    const { db } = createTempDb();
    const store = new VectorStore(db, 4);

    store.insert(1, [1.0, 0.0, 0.0, 0.0]);
    store.insert(2, [0.0, 1.0, 0.0, 0.0]);
    store.insert(3, [0.0, 0.0, 1.0, 0.0]);
    store.insert(4, [0.0, 0.0, 0.0, 1.0]);

    const results = store.search([1.0, 0.0, 0.0, 0.0], 2);
    expect(results.length).toBe(2);

    db.close();
  });

  it('should order results by distance (closest first)', () => {
    const { db } = createTempDb();
    const store = new VectorStore(db, 4);

    store.insert(1, [1.0, 0.0, 0.0, 0.0]);
    store.insert(2, [0.5, 0.5, 0.0, 0.0]);
    store.insert(3, [0.0, 1.0, 0.0, 0.0]);

    const results = store.search([1.0, 0.0, 0.0, 0.0], 3);
    expect(results.length).toBe(3);
    // Distances should be in ascending order
    for (let i = 1; i < results.length; i++) {
      expect(results[i].distance).toBeGreaterThanOrEqual(
        results[i - 1].distance
      );
    }

    db.close();
  });
});
