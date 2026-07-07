export const GGUF_DOWNLOAD_MAX_ATTEMPTS = 6;

const TRANSIENT_DOWNLOAD_ERROR_RE = /\b(terminated|fetch failed|networkerror|socket hang up|econnreset|etimedout|epipe|und_err_socket|und_err_body_timeout|other side closed)\b/i;

function collectErrorText(err: unknown): string {
  if (!err) return '';
  if (typeof err === 'string') return err;
  if (err instanceof Error) {
    const parts = [
      err.name,
      err.message,
      (err as any).code,
      (err as any).cause?.name,
      (err as any).cause?.message,
      (err as any).cause?.code,
    ];
    return parts.filter(Boolean).join(' ');
  }
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

export function isAbortError(err: unknown): boolean {
  if (!err) return false;
  return err instanceof Error && err.name === 'AbortError';
}

export function isTransientDownloadError(err: unknown): boolean {
  if (isAbortError(err)) return false;
  return TRANSIENT_DOWNLOAD_ERROR_RE.test(collectErrorText(err));
}

export function isRetryableHttpStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

export function getGGUFDownloadRetryDelayMs(attempt: number): number {
  const normalized = Math.max(1, attempt);
  return Math.min(15_000, 1_000 * 2 ** (normalized - 1));
}
