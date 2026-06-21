import { describe, it, expect } from 'vitest';
import { runWithPriority, currentPriority } from '../llm-scheduler';

// The exported singleton is shared; for isolated assertions we re-import the
// class via a fresh instance through the module's internals is not exposed, so
// we test the priority context helpers directly and the scheduler behaviour via
// a locally-constructed equivalent. To exercise the real ordering logic we
// reach the class through a dynamic re-instantiation pattern.

describe('llm-scheduler priority context', () => {
  it('defaults to interactive outside any context', () => {
    expect(currentPriority()).toBe('interactive');
  });

  it('propagates background priority through async awaits', async () => {
    const seen: string[] = [];
    await runWithPriority('background', async () => {
      seen.push(currentPriority());
      await Promise.resolve();
      seen.push(currentPriority());
    });
    expect(seen).toEqual(['background', 'background']);
    // Context does not leak out
    expect(currentPriority()).toBe('interactive');
  });

  it('nested interactive context overrides background', async () => {
    let inner = '';
    await runWithPriority('background', async () => {
      await runWithPriority('interactive', async () => {
        inner = currentPriority();
      });
    });
    expect(inner).toBe('interactive');
  });
});

// Re-create the scheduler logic test by importing the class indirectly. Since
// only the singleton is exported, we validate behaviour through it with a small
// concurrency so tests stay deterministic.
import { llmScheduler } from '../llm-scheduler';

describe('LLMScheduler ordering', () => {
  it('caps concurrency and lets interactive jump queued background', async () => {
    llmScheduler.setMaxConcurrent(1);
    const order: string[] = [];
    const started: string[] = [];

    // Manually controllable tasks
    const makeTask = (label: string, gate: Promise<void>) => async () => {
      started.push(label);
      await gate;
      order.push(label);
    };

    // Resolvers to control completion timing
    let releaseA!: () => void;
    const gateA = new Promise<void>((r) => (releaseA = r));

    // Start a background task that holds the only slot.
    const pA = llmScheduler.run('background', makeTask('bg-A', gateA));
    // Yield so bg-A acquires the slot.
    await Promise.resolve();
    await Promise.resolve();
    expect(started).toContain('bg-A');

    // Queue two background tasks and one interactive while the slot is held.
    const resolved = Promise.resolve();
    const pBg1 = llmScheduler.run('background', makeTask('bg-1', resolved));
    const pBg2 = llmScheduler.run('background', makeTask('bg-2', resolved));
    const pInter = llmScheduler.run('interactive', makeTask('inter', resolved));

    // Release the first slot — interactive must run before queued background.
    releaseA();
    await Promise.all([pA, pBg1, pBg2, pInter]);

    expect(order[0]).toBe('bg-A');
    // Interactive jumped ahead of the two queued background tasks.
    expect(order.indexOf('inter')).toBeLessThan(order.indexOf('bg-1'));
    expect(order.indexOf('inter')).toBeLessThan(order.indexOf('bg-2'));
    // FIFO preserved within background priority.
    expect(order.indexOf('bg-1')).toBeLessThan(order.indexOf('bg-2'));

    llmScheduler.setMaxConcurrent(2); // restore default
  });

  it('releases the slot even when the task throws', async () => {
    llmScheduler.setMaxConcurrent(1);
    await expect(
      llmScheduler.run('interactive', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    // Slot was released: a subsequent task runs to completion.
    const ok = await llmScheduler.run('interactive', async () => 'ok');
    expect(ok).toBe('ok');
    expect(llmScheduler.getStats().active).toBe(0);
    llmScheduler.setMaxConcurrent(2);
  });
});
