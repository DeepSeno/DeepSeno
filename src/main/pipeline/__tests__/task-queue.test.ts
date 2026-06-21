import { describe, it, expect, vi } from 'vitest';
import os from 'os';
import { TaskQueue } from '../task-queue';

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

  it('should cancel a pending task', () => {
    const q = new TaskQueue();
    q.setProcessor(vi.fn().mockResolvedValue(undefined));
    const task = q.add(`${TMP_DIR}/test.wav`);
    const result = q.cancel(task.id);
    expect(result).toBe(true);
    expect(q.getAll()).toHaveLength(0);
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
    q.setProcessor(async (t) => { calls.push(t.filePath); });

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
