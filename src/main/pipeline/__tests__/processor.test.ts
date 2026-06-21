import { describe, it, expect, vi } from 'vitest';
import os from 'os';
import { TaskQueue } from '../task-queue';

const TMP_DIR = os.tmpdir().replace(/\\/g, '/');

describe('TaskQueue', () => {
  it('should add tasks to queue', () => {
    const queue = new TaskQueue();
    queue.setProcessor(async () => {});
    const task = queue.add(`${TMP_DIR}/test.wav`);
    expect(task.id).toBeDefined();
    expect(task.status).toBe('pending');
    expect(task.filePath).toBe(`${TMP_DIR}/test.wav`);
    expect(queue.getAll()).toHaveLength(1);
  });

  it('should generate unique task ids', () => {
    const queue = new TaskQueue();
    queue.setProcessor(async () => {});
    const task1 = queue.add(`${TMP_DIR}/test1.wav`);
    const task2 = queue.add(`${TMP_DIR}/test2.wav`);
    expect(task1.id).not.toBe(task2.id);
  });

  it('should emit events on task lifecycle', async () => {
    const queue = new TaskQueue();
    const events: string[] = [];

    queue.on('task:added', () => events.push('added'));
    queue.on('task:completed', () => events.push('completed'));
    queue.on('task:progress', () => events.push('progress'));

    queue.setProcessor(async (task) => {
      queue.updateTask(task.id, { progress: 50 });
    });

    queue.add(`${TMP_DIR}/test.wav`);
    await new Promise((r) => setTimeout(r, 100));

    expect(events).toContain('added');
    expect(events).toContain('completed');
    expect(events).toContain('progress');
  });

  it('should handle task failures', async () => {
    const queue = new TaskQueue();
    const events: string[] = [];

    queue.on('task:failed', () => events.push('failed'));

    queue.setProcessor(async () => {
      throw new Error('Processing failed');
    });

    const task = queue.add(`${TMP_DIR}/test.wav`);
    await new Promise((r) => setTimeout(r, 100));

    expect(events).toContain('failed');
    expect(task.status).toBe('failed');
    expect(task.error).toBe('Processing failed');
  });

  it('should process tasks sequentially', async () => {
    const queue = new TaskQueue();
    const order: string[] = [];

    queue.setProcessor(async (task) => {
      order.push(task.filePath);
      await new Promise((r) => setTimeout(r, 30));
    });

    queue.add(`${TMP_DIR}/first.wav`);
    queue.add(`${TMP_DIR}/second.wav`);

    await new Promise((r) => setTimeout(r, 200));

    expect(order).toEqual([`${TMP_DIR}/first.wav`, `${TMP_DIR}/second.wav`]);
  });

  it('should not process when no processor is set', () => {
    const queue = new TaskQueue();
    const task = queue.add(`${TMP_DIR}/test.wav`);
    // Task should remain pending since there is no processor
    expect(task.status).toBe('pending');
  });

  it('should update task properties', () => {
    const queue = new TaskQueue();
    queue.setProcessor(async () => {});
    const task = queue.add(`${TMP_DIR}/test.wav`);

    queue.updateTask(task.id, { progress: 42, status: 'transcribing' });
    const tasks = queue.getAll();
    expect(tasks[0].progress).toBe(42);
    expect(tasks[0].status).toBe('transcribing');
  });

  it('should return a copy of the queue from getAll', () => {
    const queue = new TaskQueue();
    queue.setProcessor(async () => {});
    queue.add(`${TMP_DIR}/test.wav`);

    const all = queue.getAll();
    all.pop(); // mutate the copy
    expect(queue.getAll()).toHaveLength(1); // original unchanged
  });
});
