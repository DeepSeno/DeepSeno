import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { isSqliteCorruptionError, quarantineSqliteFiles } from '../sqlite-recovery';

let tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deepseno-sqlite-recovery-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

describe('sqlite recovery helpers', () => {
  it('detects SQLite corruption errors from messages and stacks', () => {
    expect(isSqliteCorruptionError(new Error('database disk image is malformed'))).toBe(true);
    expect(isSqliteCorruptionError(new Error('SQLITE_CORRUPT: database corruption found'))).toBe(true);
    expect(isSqliteCorruptionError(new Error('regular validation failure'))).toBe(false);
  });

  it('quarantines database sidecar files into a backup directory', () => {
    const dir = makeTempDir();
    const dbPath = path.join(dir, 'deepseno-vec.db');
    fs.writeFileSync(dbPath, 'db');
    fs.writeFileSync(`${dbPath}-wal`, 'wal');
    fs.writeFileSync(`${dbPath}-shm`, 'shm');

    const result = quarantineSqliteFiles(dbPath, 'vector');

    expect(result.errors).toEqual([]);
    expect(result.backupDir).toBeTruthy();
    expect(fs.existsSync(dbPath)).toBe(false);
    expect(fs.existsSync(`${dbPath}-wal`)).toBe(false);
    expect(fs.existsSync(`${dbPath}-shm`)).toBe(false);
    expect(result.moved.map((item) => path.basename(item)).sort()).toEqual([
      'deepseno-vec.db',
      'deepseno-vec.db-shm',
      'deepseno-vec.db-wal',
    ]);
  });
});
