import fs from 'fs';
import path from 'path';
import { loadLocalConfig, saveLocalConfig } from '../local-config';
import { getLocalDataDir, resetEffectiveDataDir } from '../paths';
import { clearSettingsCache } from '../settings';
import { LockManager } from './lock-manager';
import { WalCheckpointer } from './wal-checkpoint';

export interface SyncStatus {
  enabled: boolean;
  syncDir: string;
  machineId: string;
  readOnly: boolean;
  lockHolder: { machineId: string; hostname: string; acquiredAt: string } | null;
}

export class SyncManager {
  private lockManager: LockManager | null = null;
  private walCheckpointer: WalCheckpointer | null = null;
  private readOnly = false;
  private pollInterval: ReturnType<typeof setInterval> | null = null;

  // Callbacks to re-initialize singletons when paths change
  private reinitCallback: (() => void) | null = null;
  private getDbRaw: (() => any) | null = null;
  private getVecDbRaw: (() => any) | null = null;

  setReinitCallback(cb: () => void): void {
    this.reinitCallback = cb;
  }

  setDbAccessors(getDb: () => any, getVecDb: () => any): void {
    this.getDbRaw = getDb;
    this.getVecDbRaw = getVecDb;
  }

  isReadOnly(): boolean {
    return this.readOnly;
  }

  getLockManager(): LockManager | null {
    return this.lockManager;
  }

  getStatus(): SyncStatus {
    const config = loadLocalConfig();
    let lockHolder = null;
    if (this.lockManager) {
      const lockStatus = this.lockManager.isLockedByOther();
      if (lockStatus.locked && lockStatus.holder) {
        lockHolder = {
          machineId: lockStatus.holder.machineId,
          hostname: lockStatus.holder.hostname,
          acquiredAt: lockStatus.holder.acquiredAt,
        };
      }
    }
    return {
      enabled: config.syncEnabled,
      syncDir: config.syncDir,
      machineId: config.machineId,
      readOnly: this.readOnly,
      lockHolder,
    };
  }

  /** Enable sync: copy data to syncDir or join existing. */
  async enableSync(syncDir: string): Promise<{ success: boolean; error?: string }> {
    try {
      // Validate directory
      fs.mkdirSync(syncDir, { recursive: true });
      fs.accessSync(syncDir, fs.constants.W_OK);

      const config = loadLocalConfig();
      const localDir = getLocalDataDir();

      // Check if syncDir already has a database (joining existing)
      const hasExistingDb = fs.existsSync(path.join(syncDir, 'deepseno.db'));

      if (!hasExistingDb) {
        // Checkpoint WAL before copying to ensure all data is in main db file
        const mainDb = this.getDbRaw?.();
        const vecDb = this.getVecDbRaw?.();
        if (mainDb) {
          try { mainDb.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* ignore */ }
        }
        if (vecDb) {
          try { vecDb.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* ignore */ }
        }

        // Copy local data to sync dir
        this.copyFile(path.join(localDir, 'deepseno.db'), path.join(syncDir, 'deepseno.db'));
        this.copyFile(path.join(localDir, 'deepseno-vec.db'), path.join(syncDir, 'deepseno-vec.db'));

        // Copy output directory
        const localOutput = path.join(localDir, 'output');
        const syncOutput = path.join(syncDir, 'output');
        if (fs.existsSync(localOutput)) {
          this.copyDir(localOutput, syncOutput);
        }

        // Copy shared settings
        const localShared = path.join(localDir, 'settings-shared.json');
        if (fs.existsSync(localShared)) {
          this.copyFile(localShared, path.join(syncDir, 'settings-shared.json'));
        }

        console.log('[SyncManager] Copied local data to sync dir');
      } else {
        console.log('[SyncManager] Joining existing sync data');
      }

      // Update local config
      saveLocalConfig({
        ...config,
        syncEnabled: true,
        syncDir,
      });

      // Reset path cache so getEffectiveDataDir() returns syncDir
      resetEffectiveDataDir();
      clearSettingsCache();

      // Acquire lock
      this.lockManager = new LockManager(syncDir, config.machineId);
      const acquired = this.lockManager.acquire();

      if (acquired) {
        // Verify ownership after delay (mitigates TOCTOU race on cloud drives)
        const verified = await this.lockManager.verifyOwnership();
        if (verified) {
          this.readOnly = false;
          this.lockManager.startHeartbeat();
          this.startCheckpointer();
        } else {
          console.warn('[SyncManager] Lock stolen by another machine during verification');
          this.readOnly = true;
          this.startLockPolling();
        }
      } else {
        this.readOnly = true;
        this.startLockPolling();
      }

      // Re-initialize singletons with new paths
      this.reinitCallback?.();

      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message || String(err) };
    }
  }

  /** Disable sync: copy data back to local. */
  async disableSync(): Promise<{ success: boolean; error?: string }> {
    try {
      const config = loadLocalConfig();
      const syncDir = config.syncDir;
      const localDir = getLocalDataDir();

      // Stop checkpointer and do final checkpoint
      this.stopCheckpointer();
      this.stopLockPolling();

      // Final WAL checkpoint before copying
      if (this.walCheckpointer) {
        this.walCheckpointer.checkpointNow(
          this.getDbRaw?.() || null,
          this.getVecDbRaw?.() || null,
        );
      }

      // Re-init singletons to close DB handles before copying
      this.reinitCallback?.();

      // Copy DB back to local
      if (syncDir && fs.existsSync(path.join(syncDir, 'deepseno.db'))) {
        this.copyFile(path.join(syncDir, 'deepseno.db'), path.join(localDir, 'deepseno.db'));
        this.copyFile(path.join(syncDir, 'deepseno-vec.db'), path.join(localDir, 'deepseno-vec.db'));
      }

      // Release lock
      if (this.lockManager) {
        this.lockManager.release();
        this.lockManager = null;
      }

      // Update local config
      saveLocalConfig({
        ...config,
        syncEnabled: false,
        syncDir: '',
      });

      // Reset paths to local
      resetEffectiveDataDir();
      clearSettingsCache();

      this.readOnly = false;

      // Re-initialize with local paths
      this.reinitCallback?.();

      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message || String(err) };
    }
  }

  /** Resume sync on startup (when sync is already enabled). */
  resumeSync(): void {
    const config = loadLocalConfig();
    if (!config.syncEnabled || !config.syncDir) return;

    if (!fs.existsSync(config.syncDir)) {
      console.warn(`[SyncManager] Sync dir not accessible: ${config.syncDir}`);
      this.readOnly = true;
      return;
    }

    this.lockManager = new LockManager(config.syncDir, config.machineId);
    const acquired = this.lockManager.acquire();
    this.readOnly = !acquired;

    if (acquired) {
      console.log('[SyncManager] Lock acquired, read-write mode');
      this.lockManager.startHeartbeat();
      this.startCheckpointer();
    } else {
      console.log('[SyncManager] Lock held by another machine, read-only mode');
      this.startLockPolling();
    }
  }

  /** Try to acquire the lock (e.g., user clicks "acquire" button). */
  tryAcquireLock(): boolean {
    if (!this.lockManager) return false;
    const acquired = this.lockManager.acquire();
    if (acquired) {
      this.readOnly = false;
      this.stopLockPolling();
      this.lockManager.startHeartbeat();
      this.startCheckpointer();
      console.log('[SyncManager] Lock acquired');
    }
    return acquired;
  }

  /** Clean up on app quit. */
  cleanup(): void {
    this.stopCheckpointer();
    this.stopLockPolling();

    if (this.walCheckpointer) {
      this.walCheckpointer.checkpointNow(
        this.getDbRaw?.() || null,
        this.getVecDbRaw?.() || null,
      );
    }

    if (this.lockManager) {
      this.lockManager.release();
      this.lockManager = null;
    }
  }

  // ─── Internal helpers ──────────────────────────────────────

  private startCheckpointer(): void {
    if (this.walCheckpointer) return;
    this.walCheckpointer = new WalCheckpointer();
    this.walCheckpointer.startPeriodic(
      () => this.getDbRaw?.() || null,
      () => this.getVecDbRaw?.() || null,
    );
  }

  private stopCheckpointer(): void {
    if (this.walCheckpointer) {
      this.walCheckpointer.stop();
      this.walCheckpointer = null;
    }
  }

  private startLockPolling(): void {
    if (this.pollInterval) return;
    this.pollInterval = setInterval(() => {
      if (!this.lockManager) return;
      const status = this.lockManager.isLockedByOther();
      if (!status.locked) {
        // Lock released — try to acquire
        const acquired = this.lockManager.acquire();
        if (acquired) {
          this.readOnly = false;
          this.stopLockPolling();
          this.lockManager.startHeartbeat();
          this.startCheckpointer();
          console.log('[SyncManager] Lock auto-acquired after release');
        }
      }
    }, 30_000);
  }

  private stopLockPolling(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  private copyFile(src: string, dest: string): void {
    if (fs.existsSync(src)) {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
    }
  }

  private copyDir(src: string, dest: string): void {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);
      if (entry.isDirectory()) {
        this.copyDir(srcPath, destPath);
      } else {
        fs.copyFileSync(srcPath, destPath);
      }
    }
  }
}
