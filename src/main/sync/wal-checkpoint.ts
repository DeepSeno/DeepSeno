import { DatabaseSync } from 'node:sqlite';

const CHECKPOINT_INTERVAL = 300_000; // 5 minutes

export class WalCheckpointer {
  private intervalHandle: ReturnType<typeof setInterval> | null = null;

  /** Run PRAGMA wal_checkpoint(TRUNCATE) on a database. */
  checkpoint(db: DatabaseSync): boolean {
    try {
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      return true;
    } catch (err) {
      console.error('[WalCheckpointer] Checkpoint failed:', err);
      return false;
    }
  }

  /** Start periodic checkpointing. */
  startPeriodic(
    getDb: () => DatabaseSync | null,
    getVecDb: () => DatabaseSync | null,
    intervalMs = CHECKPOINT_INTERVAL,
  ): void {
    if (this.intervalHandle) return;
    this.intervalHandle = setInterval(() => {
      const db = getDb();
      const vecDb = getVecDb();
      if (db) this.checkpoint(db);
      if (vecDb) this.checkpoint(vecDb);
    }, intervalMs);
    console.log(`[WalCheckpointer] Started (${intervalMs / 1000}s interval)`);
  }

  /** Stop periodic checkpointing. */
  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
      console.log('[WalCheckpointer] Stopped');
    }
  }

  /** Checkpoint now (e.g., before app quit). */
  checkpointNow(
    db: DatabaseSync | null,
    vecDb: DatabaseSync | null,
  ): void {
    if (db) this.checkpoint(db);
    if (vecDb) this.checkpoint(vecDb);
  }
}
