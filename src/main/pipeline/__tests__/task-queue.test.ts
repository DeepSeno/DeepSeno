import { describe, it, expect, vi } from 'vitest';
import os from 'os';
import { TaskQueue, type QueueTask } from '../task-queue';

const TMP_DIR = os.tmpdir().replace(/\\/g, '/');

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

  it('should not let progress updates revive a cancelled task', () => {
    const q = new TaskQueue();
    const task = q.add(`${TMP_DIR}/cancelled.wav`);

    expect(q.cancel(task.id)).toBe(true);
    q.updateTask(task.id, { status: 'preprocessing', progress: 50 });

    expect(task.status).toBe('cancelled');
    expect(task.progress).toBe(0);
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
