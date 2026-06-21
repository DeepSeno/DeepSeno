/**
 * Circuit Breaker for LLM calls.
 *
 * Prevents cascading hangs when Local is down by fast-failing after
 * consecutive failures, then probing periodically to see if it's back.
 *
 * States:
 *   closed   – normal operation, all calls pass through
 *   open     – fast-fail, no calls attempted
 *   half-open – one probe call allowed; success → closed, failure → open
 */

export type CircuitState = 'closed' | 'open' | 'half-open';

const FAILURE_THRESHOLD = 3;
const COOLDOWN_MS = 15_000; // 15 seconds before probing

export class CircuitBreaker {
  private state: CircuitState = 'closed';
  private failures = 0;
  private openedAt = 0;

  getState(): CircuitState {
    // Auto-transition from open → half-open once cooldown has elapsed
    if (this.state === 'open' && Date.now() - this.openedAt >= COOLDOWN_MS) {
      this.state = 'half-open';
    }
    return this.state;
  }

  /** Manually reset to closed state. */
  reset(): void {
    this.state = 'closed';
    this.failures = 0;
    this.openedAt = 0;
  }

  /** Wrap an async operation with circuit breaker logic. */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    const current = this.getState();

    if (current === 'open') {
      const remaining = Math.ceil((COOLDOWN_MS - (Date.now() - this.openedAt)) / 1000);
      throw new Error(
        `Local appears to be down — circuit breaker is open. ` +
        `Check that Local is running and retry in ${remaining}s.`,
      );
    }

    try {
      const result = await fn();
      // Success: reset to closed
      this.state = 'closed';
      this.failures = 0;
      this.openedAt = 0;
      return result;
    } catch (err: unknown) {
      // Don't count user-initiated aborts as Local failures
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw err;
      }
      this.failures++;
      if (this.state === 'half-open' || this.failures >= FAILURE_THRESHOLD) {
        this.state = 'open';
        this.openedAt = Date.now();
        console.warn(
          `[CircuitBreaker] Opened after ${this.failures} consecutive failure(s). ` +
          `Will probe again in ${COOLDOWN_MS / 1000}s.`,
        );
      }
      throw err;
    }
  }
}
