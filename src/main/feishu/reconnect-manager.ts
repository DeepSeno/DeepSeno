/**
 * Manages WebSocket reconnection with exponential backoff.
 */

export interface ReconnectOptions {
  connect: () => Promise<void>;
  onStatusChange: (status: 'connecting' | 'connected' | 'reconnecting' | 'error') => void;
  onMaxRetriesReached?: () => void;
  maxRetries?: number;
  baseDelay?: number;
  maxDelay?: number;
}

export class ReconnectManager {
  private retryCount = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private _isReconnecting = false;

  private maxRetries: number;
  private baseDelay: number;
  private maxDelay: number;
  private connectFn: () => Promise<void>;
  private onStatusChange: ReconnectOptions['onStatusChange'];
  private onMaxRetriesReached: (() => void) | undefined;

  constructor(options: ReconnectOptions) {
    this.connectFn = options.connect;
    this.onStatusChange = options.onStatusChange;
    this.onMaxRetriesReached = options.onMaxRetriesReached;
    this.maxRetries = options.maxRetries ?? 10;
    this.baseDelay = options.baseDelay ?? 1000;
    this.maxDelay = options.maxDelay ?? 60_000;
  }

  get isReconnecting(): boolean {
    return this._isReconnecting;
  }

  /** Perform the initial connection. */
  async start(): Promise<void> {
    this.stopped = false;
    this.retryCount = 0;
    this._isReconnecting = false;
    this.onStatusChange('connecting');
    try {
      await this.connectFn();
      this.onStatusChange('connected');
    } catch (err) {
      console.error('[ReconnectManager] Initial connection failed:', err);
      this.scheduleReconnect();
    }
  }

  /** Schedule a reconnection attempt with exponential backoff. */
  scheduleReconnect(): void {
    if (this.stopped) return;

    if (this.retryCount >= this.maxRetries) {
      console.error(`[ReconnectManager] Max retries (${this.maxRetries}) reached, giving up. Manual reconnection required.`);
      this._isReconnecting = false;
      this.onStatusChange('error');
      if (this.onMaxRetriesReached) {
        try { this.onMaxRetriesReached(); } catch (e) { /* ignore callback errors */ }
      }
      return;
    }

    this._isReconnecting = true;
    this.onStatusChange('reconnecting');

    const delay = Math.min(
      this.baseDelay * Math.pow(2, this.retryCount),
      this.maxDelay,
    );
    this.retryCount++;
    console.log(`[ReconnectManager] Reconnect attempt ${this.retryCount}/${this.maxRetries} in ${delay}ms`);

    this.timer = setTimeout(async () => {
      if (this.stopped) return;
      try {
        await this.connectFn();
        this.retryCount = 0;
        this._isReconnecting = false;
        this.onStatusChange('connected');
        console.log('[ReconnectManager] Reconnected successfully');
      } catch (err) {
        console.error('[ReconnectManager] Reconnect failed:', err);
        this.scheduleReconnect();
      }
    }, delay);
  }

  /** Stop reconnection attempts and clear timers. */
  stop(): void {
    this.stopped = true;
    this._isReconnecting = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** Reset the retry counter (e.g. after a successful operation). */
  reset(): void {
    this.retryCount = 0;
  }
}
