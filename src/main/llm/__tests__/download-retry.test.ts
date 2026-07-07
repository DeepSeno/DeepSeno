import { describe, expect, it } from 'vitest';
import {
  getGGUFDownloadRetryDelayMs,
  isAbortError,
  isRetryableHttpStatus,
  isTransientDownloadError,
} from '../download-retry';

describe('GGUF download retry helpers', () => {
  it('treats undici terminated socket failures as retryable', () => {
    const err = new TypeError('terminated');
    (err as any).cause = { code: 'UND_ERR_SOCKET', message: 'other side closed' };

    expect(isTransientDownloadError(err)).toBe(true);
  });

  it('does not retry user cancellation', () => {
    const err = new Error('cancelled');
    err.name = 'AbortError';

    expect(isAbortError(err)).toBe(true);
    expect(isTransientDownloadError(err)).toBe(false);
  });

  it('retries transient HTTP statuses only', () => {
    expect(isRetryableHttpStatus(429)).toBe(true);
    expect(isRetryableHttpStatus(503)).toBe(true);
    expect(isRetryableHttpStatus(404)).toBe(false);
  });

  it('uses capped exponential backoff', () => {
    expect(getGGUFDownloadRetryDelayMs(1)).toBe(1_000);
    expect(getGGUFDownloadRetryDelayMs(4)).toBe(8_000);
    expect(getGGUFDownloadRetryDelayMs(10)).toBe(15_000);
  });
});
