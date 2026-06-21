/**
 * Thin compatibility helpers for Node.js 24 native SQLite (`node:sqlite`).
 *
 * Node 24's `DatabaseSync` provides a fully synchronous SQLite API similar to
 * better-sqlite3 but lacks a few convenience methods:
 *  - `db.pragma(...)`  → use `db.exec('PRAGMA ...')` or `db.prepare('PRAGMA ...').get()`
 *  - `db.transaction(fn)` → use the `transaction()` helper below
 *  - `db.loadExtension(path)` → call `db.enableLoadExtension()` first
 *
 * BLOB columns return `Uint8Array` (instead of `Buffer`). Use `Buffer.from(blob)`
 * if you need a genuine Node Buffer.
 */

import { DatabaseSync } from 'node:sqlite';

export type { DatabaseSync };

/**
 * Mimics better-sqlite3's `db.transaction(fn)`:
 * returns a wrapper function that executes `fn` inside `BEGIN IMMEDIATE … COMMIT`.
 * If `fn` throws, the transaction is rolled back automatically.
 *
 * Usage:
 *   const txn = transaction(db, (arg: number) => { ... });
 *   txn(42);  // runs inside a transaction
 */
export function transaction<T extends (...args: any[]) => any>(
  db: DatabaseSync,
  fn: T,
): T {
  return ((...args: Parameters<T>): ReturnType<T> => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn(...args);
      db.exec('COMMIT');
      return result;
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }) as T;
}
