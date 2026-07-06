import { EventEmitter } from 'events';
import type { DatabaseSync } from 'node:sqlite';
import { detectMediaType } from './media-type';
import { transaction } from '../db/sqlite-util';

export interface QueueTask {
  id: string;
  filePath: string;
  /** When reprocessing, reuse this existing recording ID instead of creating a new one. */
  recordingId?: number;
  status:
    | 'pending'
    | 'preprocessing'
    | 'transcribing'
    | 'diarizing'
    | 'optimizing'
    | 'extracting'
    | 'indexing'
    | 'generating notes'
    | 'extracting memories'
    | 'completed'
    | 'failed'
    | 'cancelled'
    | 'interrupted';
  progress: number; // 0-100
  error?: string;
  notes?: string; // Human-readable status detail (e.g. optimization failure reason)
  mediaType?: string; // 'audio' | 'video' | 'pdf' | 'docx' | 'text'
  /** Internal nested pipeline task that should append to existing recording data. */
  appendToRecording?: boolean;
  retryCount: number;
  maxRetries: number;
  createdAt: Date;
}

/**
 * Determine whether an error is transient (network, timeout, Local) and worth retrying,
 * as opposed to permanent errors (file not found, unsupported format, parse errors).
 */
function isRetryableError(err: Error): boolean {
  const msg = err.message.toLowerCase();
  return (
    msg.includes('timeout') ||
    msg.includes('econnrefused') ||
    msg.includes('econnreset') ||
    msg.includes('network') ||
    msg.includes('local') ||
    msg.includes('fetch failed') ||
    msg.includes('aborted') ||
    msg.includes('socket hang up') ||
    msg.includes('epipe')
  );
}

const TERMINAL_STATUSES = new Set<QueueTask['status']>([
  'completed',
  'failed',
  'cancelled',
  'interrupted',
]);

function isTerminalStatus(status: QueueTask['status']): boolean {
  return TERMINAL_STATUSES.has(status);
}

function isCancellationError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.name === 'TaskCancelledError' || /cancelled by user|canceled by user/i.test(err.message);
}

function isInterruptionError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.name === 'TaskInterruptedError' || /interrupted by app/i.test(err.message);
}

// Maximum time (ms) a single task is allowed to run before being force-failed.
const TASK_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

// Debounce interval for batching persist writes
const PERSIST_DEBOUNCE_MS = 500;

// Retention period for completed/failed tasks in the DB (7 days)
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** Exponential backoff with jitter: base * 2^attempt + random(0..1000ms) */
function backoffDelay(attempt: number, baseMs: number = 5000): number {
  return Math.min(baseMs * Math.pow(2, attempt), 120_000) + Math.random() * 1000;
}

export class TaskQueue extends EventEmitter {
  private queue: QueueTask[] = [];
  private processing = false;
  private paused = false;
  private currentTaskId: string | null = null;
  private abortController: AbortController | null = null;
  private processFunc:
    | ((task: QueueTask, signal: AbortSignal) => Promise<void>)
    | null = null;

  // ─── Persistence fields ──────────────────────────────────────
  private db: DatabaseSync | null = null;
  private dirtyTaskIds = new Set<string>();
  private persistTimer: ReturnType<typeof setTimeout> | null = null;

  /** Attach a DatabaseSync handle for persistence. */
  setDb(rawDb: DatabaseSync): void {
    this.db = rawDb;
  }

  setProcessor(
    fn:
      | ((task: QueueTask, signal: AbortSignal) => Promise<void>)
      | ((task: QueueTask) => Promise<void>),
  ): void {
    this.processFunc = fn as (
      task: QueueTask,
      signal: AbortSignal,
    ) => Promise<void>;
    this.processNext();
  }

  private findActiveTask(filePath: string, recordingId?: number): QueueTask | undefined {
    return this.queue.find((t) => {
      if (isTerminalStatus(t.status)) return false;
      if (recordingId != null && t.recordingId === recordingId) return true;
      return t.filePath === filePath;
    });
  }

  add(filePath: string): QueueTask {
    const existing = this.findActiveTask(filePath);
    if (existing) return existing;

    const task: QueueTask = {
      id: `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      filePath,
      mediaType: detectMediaType(filePath) || 'audio',
      status: 'pending',
      progress: 0,
      retryCount: 0,
      maxRetries: 2,
      createdAt: new Date(),
    };
    this.queue.push(task);
    this.markDirty(task.id);
    this.emit('task:added', task);
    this.processNext();
    return task;
  }

  /** Add a reprocess task that reuses an existing recording ID. */
  addReprocess(filePath: string, recordingId: number): QueueTask {
    const existing = this.findActiveTask(filePath, recordingId);
    if (existing) return existing;

    const task: QueueTask = {
      id: `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      filePath,
      recordingId,
      mediaType: detectMediaType(filePath) || 'audio',
      status: 'pending',
      progress: 0,
      retryCount: 0,
      maxRetries: 2,
      createdAt: new Date(),
    };
    this.queue.push(task);
    this.markDirty(task.id);
    this.emit('task:added', task);
    this.processNext();
    return task;
  }

  cancel(taskId: string): boolean {
    const task = this.queue.find((t) => t.id === taskId);
    if (!task) return false;
    if (isTerminalStatus(task.status)) return false;

    // Cancel currently processing task
    if (this.currentTaskId === taskId && this.abortController) {
      const controller = this.abortController;
      controller.abort('cancelled');
      task.status = 'cancelled';
      task.error = 'Cancelled by user';
      task.notes = 'Cancelled by user';
      this.persistTaskNow(task);
      this.emit('task:cancelled', task);
      this.releaseCurrentTaskSlot(task.id, controller);
      return true;
    }

    if (task.status === 'pending') {
      task.status = 'cancelled';
      task.error = 'Cancelled by user';
      task.notes = 'Cancelled by user';
      this.persistTaskNow(task);
      this.emit('task:cancelled', task);
      return true;
    }

    return false; // already completed/failed
  }

  pause(): void {
    this.paused = true;
    this.emit('queue:paused');
  }

  resume(): void {
    this.paused = false;
    this.emit('queue:resumed');
    this.processNext();
  }

  isPaused(): boolean {
    return this.paused;
  }

  retry(taskId: string): boolean {
    const task = this.queue.find((t) => t.id === taskId);
    if (!task || (task.status !== 'failed' && task.status !== 'cancelled'))
      return false;

    task.status = 'pending';
    task.progress = 0;
    task.error = undefined;
    task.retryCount = 0; // Reset retry count on manual retry
    this.markDirty(task.id);
    this.emit('task:retry', task);
    this.processNext();
    return true;
  }

  private async processNext(): Promise<void> {
    if (this.processing || this.paused || !this.processFunc) return;
    const task = this.queue.find((t) => t.status === 'pending');
    if (!task) return;

    this.processing = true;
    this.currentTaskId = task.id;
    const controller = new AbortController();
    this.abortController = controller;
    let timeout: ReturnType<typeof setTimeout> | null = null;

    try {
      // Race the task against a timeout to prevent indefinite hangs
      const taskPromise = this.processFunc(task, controller.signal);
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(
          `Task timed out after ${TASK_TIMEOUT_MS / 60000} minutes. ` +
          'The pipeline step may have hung (Python subprocess or LLM call). ' +
          'The task will be marked as failed and the queue will continue.'
        )), TASK_TIMEOUT_MS);
      });

      await Promise.race([taskPromise, timeoutPromise]);
      if (timeout) clearTimeout(timeout);

      if (task.status === 'completed') {
        task.progress = 100;
        this.persistTaskNow(task);
        this.emit('task:completed', task);
      } else if (task.status === 'failed') {
        this.persistTaskNow(task);
        this.emit('task:failed', task);
      } else if (!isTerminalStatus(task.status)) {
        task.status = 'completed';
        task.progress = 100;
        this.persistTaskNow(task);
        this.emit('task:completed', task);
      }
    } catch (err: any) {
      if (isInterruptionError(err)) {
        if (!isTerminalStatus(task.status)) {
          task.status = 'interrupted';
          task.error = 'Interrupted by app shutdown';
          task.notes = 'Interrupted by app shutdown';
          this.persistTaskNow(task);
        }
      } else if (isCancellationError(err)) {
        if (!isTerminalStatus(task.status)) {
          task.status = 'cancelled';
          task.error = 'Cancelled by user';
          task.notes = 'Cancelled by user';
          this.persistTaskNow(task);
          this.emit('task:cancelled', task);
        }
      } else if (task.status === 'failed') {
        task.error = task.error || err.message;
        this.persistTaskNow(task);
        console.error(`[TaskQueue] Task ${task.id} failed:`, task.error);
        this.emit('task:failed', task);
      } else if (!isTerminalStatus(task.status)) {
        // Auto-retry for transient errors (network, timeout, Local)
        if (isRetryableError(err) && task.retryCount < task.maxRetries) {
          task.retryCount++;
          task.status = 'pending';
          task.error = undefined;
          task.notes = `Retry ${task.retryCount}/${task.maxRetries}: ${err.message}`;
          task.progress = 0;
          this.emit('task:progress', task);
          this.markDirty(task.id);
          console.log(
            `[TaskQueue] Task ${task.id} will retry (${task.retryCount}/${task.maxRetries}): ${err.message}`,
          );
          const delay = backoffDelay(task.retryCount);
          console.log(`[TaskQueue] Retry delay: ${Math.round(delay / 1000)}s`);
          await new Promise((r) => setTimeout(r, delay));
          return;
        }

        task.status = 'failed';
        task.error = err.message;
        this.persistTaskNow(task);
        console.error(`[TaskQueue] Task ${task.id} failed:`, err.message);
        this.emit('task:failed', task);
      }
    } finally {
      if (timeout) clearTimeout(timeout);
      if (this.currentTaskId === task.id && this.abortController === controller) {
        this.processing = false;
        this.currentTaskId = null;
        this.abortController = null;
        this.processNext();
      }
    }
  }

  private releaseCurrentTaskSlot(taskId: string, controller: AbortController): void {
    if (this.currentTaskId !== taskId || this.abortController !== controller) return;
    this.processing = false;
    this.currentTaskId = null;
    this.abortController = null;
    this.processNext();
  }

  /** Force-reset stuck queue state (e.g. after a crash recovery). */
  resetStuck(): number {
    if (this.abortController) {
      try { this.abortController.abort(); } catch { /* already aborted */ }
    }
    let count = 0;
    for (const task of this.queue) {
      if (
        !isTerminalStatus(task.status) &&
        task.status !== 'pending' &&
        task.id === this.currentTaskId
      ) {
        task.status = 'failed';
        task.error = 'Reset: task was stuck in processing state';
        this.persistTaskNow(task);
        this.emit('task:failed', task);
        count++;
      }
    }
    this.processing = false;
    this.currentTaskId = null;
    this.abortController = null;
    // Restart queue processing
    this.processNext();
    return count;
  }

  updateTask(id: string, update: Partial<QueueTask>): void {
    const task = this.queue.find((t) => t.id === id);
    if (task) {
      if (isTerminalStatus(task.status)) {
        const nextStatus = update.status;
        if (!nextStatus || !isTerminalStatus(nextStatus) || nextStatus !== task.status) {
          return;
        }
      }
      Object.assign(task, update);
      this.markDirty(task.id);
      this.emit('task:progress', task);
    }
  }

  getById(taskId: string): QueueTask | undefined {
    return this.queue.find((t) => t.id === taskId);
  }

  getActiveByRecordingOrPath(filePath: string, recordingId?: number): QueueTask | undefined {
    return this.findActiveTask(filePath, recordingId);
  }

  getAll(): QueueTask[] {
    return this.queue.filter(
      (t) =>
        !isTerminalStatus(t.status),
    );
  }

  // ─── Persistence ────────────────────────────────────────────

  /** Mark a task as dirty and schedule a debounced flush. */
  private markDirty(taskId: string): void {
    if (!this.db) return;
    this.dirtyTaskIds.add(taskId);
    if (!this.persistTimer) {
      this.persistTimer = setTimeout(() => {
        this.flushDirty();
      }, PERSIST_DEBOUNCE_MS);
    }
  }

  /** Flush all dirty tasks to the database in a single transaction. */
  private flushDirty(): void {
    this.persistTimer = null;
    if (!this.db || this.dirtyTaskIds.size === 0) return;

    const ids = [...this.dirtyTaskIds];
    this.dirtyTaskIds.clear();

    try {
      const upsert = this.db.prepare(`
        INSERT OR REPLACE INTO task_queue (id, file_path, recording_id, status, progress, error, notes, retry_count, max_retries, media_type, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const txn = transaction(this.db, () => {
        for (const id of ids) {
          const task = this.queue.find((t) => t.id === id);
          if (!task) continue;
          upsert.run(
            task.id,
            task.filePath,
            task.recordingId ?? null,
            task.status,
            task.progress,
            task.error ?? null,
            task.notes ?? null,
            task.retryCount,
            task.maxRetries,
            task.mediaType ?? 'audio',
            task.createdAt.toISOString(),
            new Date().toISOString(),
          );
        }
      });
      txn();
    } catch (err: any) {
      console.error('[TaskQueue] Failed to persist tasks:', err.message);
    }
  }

  /** Immediately persist a single task (used for critical state changes). */
  private persistTaskNow(task: QueueTask): void {
    if (!this.db) return;
    // Remove from dirty set since we're writing it now
    this.dirtyTaskIds.delete(task.id);
    try {
      this.db.prepare(`
        INSERT OR REPLACE INTO task_queue (id, file_path, recording_id, status, progress, error, notes, retry_count, max_retries, media_type, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        task.id,
        task.filePath,
        task.recordingId ?? null,
        task.status,
        task.progress,
        task.error ?? null,
        task.notes ?? null,
        task.retryCount,
        task.maxRetries,
        task.mediaType ?? 'audio',
        task.createdAt.toISOString(),
        new Date().toISOString(),
      );
    } catch (err: any) {
      console.error('[TaskQueue] Failed to persist task:', err.message);
    }
  }

  /** Load persisted tasks from the database on startup. Processing tasks are reset to pending. */
  private loadPersistedTasks(): QueueTask[] {
    if (!this.db) return [];
    try {
      const rows = this.db.prepare(`
        SELECT id, file_path, recording_id, status, progress, error, notes, retry_count, max_retries, media_type, created_at
        FROM task_queue
        WHERE status NOT IN ('completed', 'cancelled', 'interrupted')
      `).all() as Array<{
        id: string;
        file_path: string;
        recording_id: number | null;
        status: string;
        progress: number;
        error: string | null;
        notes: string | null;
        retry_count: number | null;
        max_retries: number | null;
        media_type: string | null;
        created_at: string;
      }>;

      return rows.map((row) => ({
        id: row.id,
        filePath: row.file_path,
        recordingId: row.recording_id ?? undefined,
        mediaType: row.media_type || 'audio',
        status: (row.status === 'failed' ? 'failed' : 'pending') as QueueTask['status'],
        progress: 0,
        error: row.error ?? undefined,
        notes: row.notes ?? undefined,
        retryCount: row.retry_count ?? 0,
        maxRetries: row.max_retries ?? 2,
        createdAt: new Date(row.created_at),
      }));
    } catch (err: any) {
      console.error('[TaskQueue] Failed to load persisted tasks:', err.message);
      return [];
    }
  }

  /** Remove old completed/failed/cancelled tasks from the database. */
  private cleanupOldTasks(): void {
    if (!this.db) return;
    try {
      const cutoff = new Date(Date.now() - RETENTION_MS).toISOString();
      this.db.prepare(`
        DELETE FROM task_queue
        WHERE status IN ('completed', 'failed', 'cancelled', 'interrupted') AND updated_at < ?
      `).run(cutoff);
    } catch (err: any) {
      console.error('[TaskQueue] Failed to cleanup old tasks:', err.message);
    }
  }

  /** Restore tasks from the database after app restart. Call after setDb(). */
  restoreFromDb(): void {
    // Mark ALL non-terminal tasks as interrupted immediately on restore.
    // This prevents crash loops and avoids implicit re-processing on startup.
    // Users can manually reprocess the recording from history.
    if (this.db) {
      try {
        const result = this.db.prepare(`
          UPDATE task_queue
          SET status = 'interrupted', error = 'Task interrupted by app restart. Reprocess the recording from history.', updated_at = ?
          WHERE status NOT IN ('completed', 'failed', 'cancelled', 'interrupted')
        `).run(new Date().toISOString());
        if (result.changes > 0) {
          console.log(`[TaskQueue] Marked ${result.changes} task(s) as interrupted`);
        }
        const legacyResult = this.db.prepare(`
          UPDATE task_queue
          SET status = 'interrupted',
              error = 'Task interrupted by app restart. Reprocess the recording from history.',
              notes = COALESCE(notes, 'Task interrupted by app restart. Reprocess the recording from history.'),
              updated_at = ?
          WHERE status = 'failed'
            AND error LIKE 'Task interrupted by app restart%'
        `).run(new Date().toISOString());
        if (legacyResult.changes > 0) {
          console.log(`[TaskQueue] Relabeled ${legacyResult.changes} legacy restart-interrupted task(s)`);
        }
      } catch (err: any) {
        console.error('[TaskQueue] Failed to mark interrupted tasks:', err.message);
      }
    }

    // Load failed tasks into memory so they show in the UI (users can retry)
    const tasks = this.loadPersistedTasks();
    if (tasks.length > 0) {
      for (const task of tasks) {
        const existing = this.queue.find((t) => t.id === task.id);
        if (!existing) {
          this.queue.push(task);
          this.emit('task:added', task);
        }
      }
      console.log(`[TaskQueue] Loaded ${tasks.length} task(s) from database`);
    }

    this.cleanupOldTasks();
    // Do NOT call processNext() — all restored tasks are failed, nothing to process
  }

  /** Mark all currently active (non-terminal) tasks as interrupted in the DB. Call on app exit. */
  markActiveAsInterrupted(): void {
    // First flush any pending writes
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    this.flushDirty();

    const message = 'Task interrupted by app shutdown. Reprocess the recording from history.';
    for (const task of this.queue) {
      if (isTerminalStatus(task.status)) continue;
      task.status = 'interrupted';
      task.error = message;
      task.notes = message;
      task.progress = Math.max(0, task.progress);
      this.persistTaskNow(task);
    }

    if (!this.db) return;
    try {
      this.db.prepare(`
        UPDATE task_queue
        SET status = 'interrupted', error = COALESCE(error, ?), notes = COALESCE(notes, ?), updated_at = ?
        WHERE status NOT IN ('completed', 'failed', 'cancelled', 'interrupted')
      `).run(message, message, new Date().toISOString());
      console.log('[TaskQueue] Marked active tasks as interrupted');
    } catch (err: any) {
      console.error('[TaskQueue] Failed to mark tasks as interrupted:', err.message);
    }
  }

  /** Release all listeners, timers, and in-flight state. Call on app quit or full reset. */
  dispose(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    if (this.abortController) {
      try { this.abortController.abort('interrupted'); } catch { /* already aborted */ }
      this.abortController = null;
    }
    this.flushDirty();
    this.dirtyTaskIds.clear();
    this.queue = [];
    this.processing = false;
    this.currentTaskId = null;
    this.processFunc = null;
    this.removeAllListeners();
  }
}
