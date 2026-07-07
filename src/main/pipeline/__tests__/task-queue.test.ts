import { describe, it, expect, vi } from 'vitest';
import os from 'os';
import { DatabaseSync } from 'node:sqlite';
import { TaskQueue, type QueueTask } from '../task-queue';

const TMP_DIR = os.tmpdir().replace(/\\/g, '/');

function createQueueDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE task_queue (
      id TEXT PRIMARY KEY,
      file_path TEXT NOT NULL,
      recording_id INTEGER,
      status TEXT NOT NULL DEFAULT 'pending',
      progress REAL DEFAULT 0,
      error TEXT,
      notes TEXT,
      retry_count INTEGER NOT NULL DEFAULT 0,
      max_retries INTEGER NOT NULL DEFAULT 2,
      media_type TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE recordings (
      id INTEGER PRIMARY KEY,
      status TEXT NOT NULL,
      processed_at TEXT,
      status_updated_at TEXT
    );
  `);
  return db;
}

describe('TaskQueue', () => {
  it('should add and process tasks', async () => {
    const q = new TaskQueue();
    const processor = vi.fn().mockResolvedValue(undefined);
    q.setProcessor(processor);
    const task = q.add(`${TMP_DIR}/test.wav`);
    expect(task.status).toBe('pending');
    // Wait for async processing
    await new Promise((r) => setTimeout(r, 50));
    expect(processor).toHaveBeenCalled();
  });

  it('should start pending tasks once a processor is set', async () => {
    const q = new TaskQueue();
    const processor = vi.fn().mockResolvedValue(undefined);

    q.add(`${TMP_DIR}/late-processor.wav`);
    q.setProcessor(processor);

    await new Promise((r) => setTimeout(r, 50));
    expect(processor).toHaveBeenCalledTimes(1);
  });

  it('should deduplicate reprocess tasks by recording id', () => {
    const q = new TaskQueue();
    const task1 = q.addReprocess(`${TMP_DIR}/first.wav`, 42);
    const task2 = q.addReprocess(`${TMP_DIR}/second.wav`, 42);

    expect(task2.id).toBe(task1.id);
    expect(task2.filePath).toBe(`${TMP_DIR}/first.wav`);
    expect(q.getAll()).toHaveLength(1);
  });

  it('should deduplicate reprocess tasks by file path', () => {
    const q = new TaskQueue();
    const task1 = q.addReprocess(`${TMP_DIR}/same.wav`, 42);
    const task2 = q.addReprocess(`${TMP_DIR}/same.wav`, 43);

    expect(task2.id).toBe(task1.id);
    expect(task2.recordingId).toBe(42);
    expect(q.getAll()).toHaveLength(1);
  });

  it('should emit completed when the processor marks the task completed', async () => {
    const q = new TaskQueue();
    const completed = vi.fn();
    q.on('task:completed', completed);
    q.setProcessor(async (task: QueueTask) => {
      q.updateTask(task.id, { status: 'completed', progress: 100 });
    });

    q.add(`${TMP_DIR}/processor-completes.wav`);

    await new Promise((r) => setTimeout(r, 50));
    expect(completed).toHaveBeenCalledTimes(1);
    expect(completed.mock.calls[0][0].status).toBe('completed');
  });

  it('should emit failed when the processor marks the task failed before throwing', async () => {
    const q = new TaskQueue();
    const failed = vi.fn();
    q.on('task:failed', failed);
    q.setProcessor(async (task: QueueTask) => {
      q.updateTask(task.id, { status: 'failed', error: 'processor failed' });
      throw new Error('processor failed');
    });

    q.add(`${TMP_DIR}/processor-fails.wav`);

    await new Promise((r) => setTimeout(r, 50));
    expect(failed).toHaveBeenCalledTimes(1);
    expect(failed.mock.calls[0][0].status).toBe('failed');
    expect(failed.mock.calls[0][0].error).toBe('processor failed');
  });

  it('should cancel a pending task', () => {
    const q = new TaskQueue();
    const task = q.add(`${TMP_DIR}/test.wav`);
    const result = q.cancel(task.id);
    expect(result).toBe(true);
    expect(q.getAll()).toHaveLength(0);
  });

  it('should abort and cancel the active task', async () => {
    const q = new TaskQueue();
    let aborted = false;
    const cancelled = vi.fn();
    q.on('task:cancelled', cancelled);
    q.setProcessor((_task, signal) => new Promise<void>((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        aborted = true;
        reject(new Error('Task cancelled by user'));
      }, { once: true });
    }));

    const task = q.add(`${TMP_DIR}/active.wav`);
    await new Promise((r) => setTimeout(r, 10));

    expect(q.cancel(task.id)).toBe(true);
    await new Promise((r) => setTimeout(r, 10));

    expect(aborted).toBe(true);
    expect(task.status).toBe('cancelled');
    expect(cancelled).toHaveBeenCalledTimes(1);
    expect(q.getAll()).toHaveLength(0);
  });

  it('should start the next pending task immediately after active task cancellation', async () => {
    const q = new TaskQueue();
    const started: string[] = [];
    let releaseSlowTask: (() => void) | null = null;

    q.setProcessor((task: QueueTask) => {
      started.push(task.filePath);
      if (task.filePath.endsWith('/slow-cancel.wav')) {
        return new Promise<void>((resolve) => { releaseSlowTask = resolve; });
      }
      return Promise.resolve();
    });

    const slowTask = q.add(`${TMP_DIR}/slow-cancel.wav`);
    const nextTask = q.add(`${TMP_DIR}/next-after-cancel.wav`);

    await new Promise((r) => setTimeout(r, 10));
    expect(started).toEqual([slowTask.filePath]);

    expect(q.cancel(slowTask.id)).toBe(true);

    await new Promise((r) => setTimeout(r, 10));
    expect(started).toEqual([slowTask.filePath, nextTask.filePath]);

    releaseSlowTask?.();
    await new Promise((r) => setTimeout(r, 10));
    expect(nextTask.status).toBe('completed');
  });

  it('should keep active tasks interrupted during shutdown abort', async () => {
    const db = new DatabaseSync(':memory:');
    db.exec(`
      CREATE TABLE task_queue (
        id TEXT PRIMARY KEY,
        file_path TEXT NOT NULL,
        recording_id INTEGER,
        status TEXT NOT NULL DEFAULT 'pending',
        progress REAL DEFAULT 0,
        error TEXT,
        notes TEXT,
        retry_count INTEGER NOT NULL DEFAULT 0,
        max_retries INTEGER NOT NULL DEFAULT 2,
        media_type TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    const q = new TaskQueue();
    q.setDb(db);
    q.setProcessor((_task, signal) => new Promise<void>((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        const err = new Error('Task cancelled by user');
        err.name = 'TaskCancelledError';
        reject(err);
      }, { once: true });
    }));

    const task = q.add(`${TMP_DIR}/shutdown.wav`);
    await new Promise((r) => setTimeout(r, 10));

    q.markActiveAsInterrupted();
    q.dispose();
    await new Promise((r) => setTimeout(r, 10));

    const row = db.prepare('SELECT status, error FROM task_queue WHERE id = ?').get(task.id) as { status: string; error: string };
    expect(row.status).toBe('interrupted');
    expect(row.error).toContain('interrupted by app shutdown');
    db.close();
  });

  it('should relabel legacy restart-interrupted failures during restore', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(`
      CREATE TABLE task_queue (
        id TEXT PRIMARY KEY,
        file_path TEXT NOT NULL,
        recording_id INTEGER,
        status TEXT NOT NULL DEFAULT 'pending',
        progress REAL DEFAULT 0,
        error TEXT,
        notes TEXT,
        retry_count INTEGER NOT NULL DEFAULT 0,
        max_retries INTEGER NOT NULL DEFAULT 2,
        media_type TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO task_queue (id, file_path, status, progress, error, retry_count, max_retries, created_at, updated_at)
      VALUES ('legacy-interrupted', ?, 'failed', 60, 'Task interrupted by app restart. Click retry to reprocess.', 0, 2, ?, ?)
    `).run(`${TMP_DIR}/legacy.wav`, now, now);

    const q = new TaskQueue();
    q.setDb(db);
    q.restoreFromDb();

    const row = db.prepare('SELECT status, error FROM task_queue WHERE id = ?').get('legacy-interrupted') as { status: string; error: string };
    expect(row.status).toBe('interrupted');
    expect(row.error).toContain('Reprocess the recording from history');
    expect(q.getAll()).toHaveLength(0);
    db.close();
  });

  it('should not let progress updates revive a cancelled task', () => {
    const q = new TaskQueue();
    const task = q.add(`${TMP_DIR}/cancelled.wav`);

    expect(q.cancel(task.id)).toBe(true);
    q.updateTask(task.id, { status: 'preprocessing', progress: 50 });

    expect(task.status).toBe('cancelled');
    expect(task.progress).toBe(0);
  });

  it('should keep progress monotonic while a task is active', () => {
    const q = new TaskQueue();
    const task = q.add(`${TMP_DIR}/progress.txt`);

    q.updateTask(task.id, { status: 'optimizing', progress: 80 });
    q.updateTask(task.id, { status: 'indexing', progress: 75 });

    expect(task.status).toBe('indexing');
    expect(task.progress).toBe(80);
  });

  it('should sync failed task status back to its recording', async () => {
    const db = createQueueDb();
    db.prepare('INSERT INTO recordings (id, status, status_updated_at) VALUES (42, ?, ?)').run(
      'processing',
      new Date().toISOString(),
    );

    const q = new TaskQueue();
    q.setDb(db);
    q.setProcessor(async () => {
      throw new Error('synthetic upload analysis failure');
    });

    q.addReprocess(`${TMP_DIR}/failed-upload.txt`, 42);
    await new Promise((r) => setTimeout(r, 50));

    const row = db.prepare('SELECT status FROM recordings WHERE id = 42').get() as { status: string };
    expect(row.status).toBe('failed');
    q.dispose();
    db.close();
  });

  it('should not cancel a completed task', async () => {
    const q = new TaskQueue();
    q.setProcessor(vi.fn().mockResolvedValue(undefined));
    const task = q.add(`${TMP_DIR}/test.wav`);
    await new Promise((r) => setTimeout(r, 50));
    const result = q.cancel(task.id);
    expect(result).toBe(false);
  });

  it('should pause and resume processing', async () => {
    const q = new TaskQueue();
    const calls: string[] = [];
    q.setProcessor(async (t: QueueTask) => { calls.push(t.filePath); });

    q.pause();
    q.add(`${TMP_DIR}/a.wav`);
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toHaveLength(0); // paused — nothing processed

    q.resume();
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toHaveLength(1);
  });

  it('should retry a failed task', async () => {
    const q = new TaskQueue();
    let attempt = 0;
    q.setProcessor(async () => {
      attempt++;
      if (attempt === 1) throw new Error('fail');
    });
    const task = q.add(`${TMP_DIR}/test.wav`);
    await new Promise((r) => setTimeout(r, 50));
    expect(task.status).toBe('failed');

    const retried = q.retry(task.id);
    expect(retried).toBe(true);
    await new Promise((r) => setTimeout(r, 50));
    expect(task.status).toBe('completed');
  });
});
