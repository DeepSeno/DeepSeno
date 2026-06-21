/**
 * Sequential message queue for Feishu bot.
 * Ensures only one message is processed at a time, preventing concurrent
 * LLM calls from competing for resources.
 */

const MAX_QUEUE_SIZE = 50;

interface QueueEntry {
  data: any;
  resolve: () => void;
  reject: (err: Error) => void;
  enqueuedAt: number;
}

export class MessageQueue {
  private queue: QueueEntry[] = [];
  private processing = false;
  private handler: ((data: any) => Promise<void>) | null = null;
  private totalProcessed = 0;

  setHandler(fn: (data: any) => Promise<void>): void {
    this.handler = fn;
  }

  /**
   * Enqueue a message for processing. Returns a promise that resolves
   * when the message has been fully handled.
   */
  enqueue(data: any): Promise<void> {
    if (this.queue.length >= MAX_QUEUE_SIZE) {
      return Promise.reject(new Error('Message queue is full'));
    }

    return new Promise<void>((resolve, reject) => {
      this.queue.push({ data, resolve, reject, enqueuedAt: Date.now() });
      this.processNext();
    });
  }

  private async processNext(): Promise<void> {
    if (this.processing || !this.handler) return;
    const entry = this.queue.shift();
    if (!entry) return;

    this.processing = true;
    try {
      await this.handler(entry.data);
      this.totalProcessed++;
      entry.resolve();
    } catch (err: any) {
      entry.reject(err);
    } finally {
      this.processing = false;
      this.processNext();
    }
  }

  /** Drain the queue, rejecting all pending entries. */
  drain(): void {
    const pending = this.queue.splice(0);
    for (const entry of pending) {
      entry.reject(new Error('Queue drained'));
    }
  }

  getQueueLength(): number {
    return this.queue.length;
  }

  isProcessing(): boolean {
    return this.processing;
  }

  getTotalProcessed(): number {
    return this.totalProcessed;
  }
}
