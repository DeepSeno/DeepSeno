import fs from 'fs';
import path from 'path';
import os from 'os';

export interface LockFileContent {
  machineId: string;
  hostname: string;
  pid: number;
  acquiredAt: string;
  heartbeat: string;
}

const HEARTBEAT_INTERVAL = 30_000; // 30 seconds
const STALE_THRESHOLD = 300_000;   // 5 minutes (generous for cloud drive sync latency)

export class LockManager {
  private lockPath: string;
  private machineId: string;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;

  constructor(syncDir: string, machineId: string) {
    this.lockPath = path.join(syncDir, 'deepseno.lock');
    this.machineId = machineId;
  }

  /** Try to acquire the lock. Returns true if acquired, false if held by another. */
  acquire(): boolean {
    const existing = this.readLock();
    if (existing) {
      // Check if it's our own lock (e.g., from a crash)
      if (existing.machineId === this.machineId) {
        // Reclaim our own lock
        this.writeLock();
        return true;
      }
      // Check if lock is stale
      const heartbeatAge = Date.now() - new Date(existing.heartbeat).getTime();
      if (heartbeatAge < STALE_THRESHOLD) {
        // Lock is fresh — another machine is active
        return false;
      }
      // Lock is stale — steal it
      console.log(`[LockManager] Stealing stale lock from ${existing.hostname} (${Math.round(heartbeatAge / 1000)}s old)`);
    }
    this.writeLock();
    return true;
  }

  /** Release the lock. */
  release(): void {
    this.stopHeartbeat();
    try {
      // Only delete if it's our lock
      const existing = this.readLock();
      if (existing && existing.machineId === this.machineId) {
        fs.unlinkSync(this.lockPath);
      }
    } catch {
      // Lock file may already be gone
    }
  }

  /** Start periodic heartbeat updates. */
  startHeartbeat(): void {
    if (this.heartbeatInterval) return;
    this.heartbeatInterval = setInterval(() => {
      try {
        const existing = this.readLock();
        if (existing && existing.machineId === this.machineId) {
          existing.heartbeat = new Date().toISOString();
          const tmpPath = this.lockPath + '.tmp';
          fs.writeFileSync(tmpPath, JSON.stringify(existing, null, 2), 'utf-8');
          fs.renameSync(tmpPath, this.lockPath);
        }
      } catch (err) {
        console.error('[LockManager] Heartbeat update failed:', err);
      }
    }, HEARTBEAT_INTERVAL);
  }

  /** Stop the heartbeat timer. */
  stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  /** Check if another machine holds the lock. */
  isLockedByOther(): { locked: boolean; holder?: LockFileContent } {
    const existing = this.readLock();
    if (!existing) return { locked: false };
    if (existing.machineId === this.machineId) return { locked: false };

    const heartbeatAge = Date.now() - new Date(existing.heartbeat).getTime();
    if (heartbeatAge >= STALE_THRESHOLD) return { locked: false }; // stale

    return { locked: true, holder: existing };
  }

  /** Check if we currently hold the lock. */
  isOurLock(): boolean {
    const existing = this.readLock();
    return existing?.machineId === this.machineId;
  }

  /** Verify lock ownership after a delay (mitigates TOCTOU race on cloud drives). */
  async verifyOwnership(delayMs = 3000): Promise<boolean> {
    await new Promise((r) => setTimeout(r, delayMs));
    return this.isOurLock();
  }

  private writeLock(): void {
    const content: LockFileContent = {
      machineId: this.machineId,
      hostname: os.hostname(),
      pid: process.pid,
      acquiredAt: new Date().toISOString(),
      heartbeat: new Date().toISOString(),
    };
    // Atomic write: write to temp file then rename (avoids partial reads on Windows)
    const tmpPath = this.lockPath + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(content, null, 2), 'utf-8');
    fs.renameSync(tmpPath, this.lockPath);
  }

  private readLock(): LockFileContent | null {
    try {
      const raw = fs.readFileSync(this.lockPath, 'utf-8');
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
}
