import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Priority-aware concurrency gate for local LLM (Local) calls.
 *
 * Problem it solves: post-recording enrichment (batch clean, info extraction,
 * daily summary, knowledge compilation, memory extraction) can fire dozens of
 * LLM generations at once. Local serialises them internally on a FIFO queue we
 * cannot reorder, so an interactive RAG/chat query issued during that flood gets
 * stuck behind all of them (observed: a query waited ~408s in queue).
 *
 * The gate holds background requests in an *application-level* priority queue and
 * only lets a bounded number reach Local at a time. When an interactive request
 * arrives it jumps ahead of any queued background work, so the worst it waits for
 * is one in-flight generation to finish (≈ a single model response) instead of
 * the whole backlog.
 *
 * Priority is carried implicitly via AsyncLocalStorage: everything is
 * 'interactive' by default; only the known bulk/background flows wrap themselves
 * in `runWithPriority('background', ...)`. This keeps the change to a handful of
 * call sites and guarantees no interactive path is ever accidentally starved.
 *
 * Only local Local text generation is gated — embeddings (cheap) and cloud
 * providers (handle their own concurrency) are not.
 */

export type LLMPriority = 'interactive' | 'background';

const priorityStore = new AsyncLocalStorage<LLMPriority>();

/** Run `fn` (and everything it awaits) under the given LLM priority. */
export function runWithPriority<T>(priority: LLMPriority, fn: () => T): T {
  return priorityStore.run(priority, fn);
}

/** Priority of the current async context. Defaults to 'interactive'. */
export function currentPriority(): LLMPriority {
  return priorityStore.getStore() ?? 'interactive';
}

interface Waiter {
  priority: LLMPriority;
  seq: number;
  resolve: () => void;
}

class LLMScheduler {
  private maxConcurrent: number;
  private active = 0;
  private waiters: Waiter[] = [];
  private seq = 0;

  constructor(maxConcurrent = 2) {
    this.maxConcurrent = Math.max(1, maxConcurrent);
  }

  setMaxConcurrent(n: number): void {
    this.maxConcurrent = Math.max(1, Math.floor(n));
    this.pump();
  }

  getStats(): { active: number; queued: number; maxConcurrent: number } {
    return { active: this.active, queued: this.waiters.length, maxConcurrent: this.maxConcurrent };
  }

  /** Acquire a slot (respecting priority), run `fn`, release the slot. */
  async run<T>(priority: LLMPriority, fn: () => Promise<T>): Promise<T> {
    await this.acquire(priority);
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private acquire(priority: LLMPriority): Promise<void> {
    return new Promise<void>((resolve) => {
      this.waiters.push({ priority, seq: this.seq++, resolve });
      this.pump();
    });
  }

  private release(): void {
    this.active = Math.max(0, this.active - 1);
    this.pump();
  }

  private pump(): void {
    while (this.active < this.maxConcurrent && this.waiters.length > 0) {
      // Pick the highest-priority waiter; FIFO (lowest seq) within a priority.
      let bestIdx = 0;
      for (let i = 1; i < this.waiters.length; i++) {
        const w = this.waiters[i];
        const best = this.waiters[bestIdx];
        if (w.priority !== best.priority) {
          if (w.priority === 'interactive') bestIdx = i;
        } else if (w.seq < best.seq) {
          bestIdx = i;
        }
      }
      const [next] = this.waiters.splice(bestIdx, 1);
      this.active++;
      next.resolve();
    }
  }
}

/**
 * Default cap of 2 concurrent generations: bounds how many heavy jobs can be
 * in-flight (so an interactive request waits for at most one to finish) while
 * preserving some parallelism for light models. Tune via setMaxConcurrent().
 */
export const llmScheduler = new LLMScheduler(2);
