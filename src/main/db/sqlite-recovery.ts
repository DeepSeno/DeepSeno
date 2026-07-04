import fs from 'fs';
import path from 'path';

export interface SqliteFileQuarantineResult {
  backupDir: string | null;
  moved: string[];
  errors: string[];
}

export interface StorageRepairResult {
  attempted: boolean;
  repaired: boolean;
  actions: string[];
  errors: string[];
  backupDir?: string;
}

const SQLITE_CORRUPTION_RE =
  /database disk image is malformed|SQLITE_CORRUPT|corruption found|malformed database schema/i;

export function isSqliteCorruptionError(err: unknown): boolean {
  const parts: string[] = [];
  if (err instanceof Error) {
    parts.push(err.message || '');
    parts.push(err.stack || '');
    const cause = (err as any).cause;
    if (cause) parts.push(String(cause?.message || cause));
  } else {
    parts.push(String(err));
  }
  return SQLITE_CORRUPTION_RE.test(parts.join('\n'));
}

function sqliteSidecarPaths(dbPath: string): string[] {
  return [dbPath, `${dbPath}-wal`, `${dbPath}-shm`];
}

function backupStamp(label: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  return `${ts}-${process.pid}-${label}`;
}

export function quarantineSqliteFiles(dbPath: string, label: string): SqliteFileQuarantineResult {
  const existing = sqliteSidecarPaths(dbPath).filter((p) => fs.existsSync(p));
  if (existing.length === 0) {
    return { backupDir: null, moved: [], errors: [] };
  }

  const backupDir = path.join(path.dirname(dbPath), 'corrupt-backups', backupStamp(label));
  const moved: string[] = [];
  const errors: string[] = [];
  fs.mkdirSync(backupDir, { recursive: true });

  for (const filePath of existing) {
    const dest = path.join(backupDir, path.basename(filePath));
    try {
      fs.renameSync(filePath, dest);
      moved.push(dest);
    } catch (err: any) {
      errors.push(`${path.basename(filePath)}: ${err?.message || String(err)}`);
    }
  }

  return { backupDir, moved, errors };
}

export function makeRepairFailureMessage(result: StorageRepairResult, rolledBack: boolean): string {
  const rollbackText = rolledBack ? '该条记录已恢复到点击前状态。' : '';
  const detail = result.errors.length > 0 ? `失败原因：${result.errors[0]}` : '失败原因未知。';
  return `检测到本地数据库或索引损坏，已自动尝试修复但未成功。${rollbackText}${detail}`;
}
