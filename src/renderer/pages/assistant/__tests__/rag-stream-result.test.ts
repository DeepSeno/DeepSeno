import { describe, expect, it } from 'vitest';
import { getRagStreamFailureMessage } from '../rag-stream-result';

describe('getRagStreamFailureMessage', () => {
  it('returns null for successful stream results', () => {
    expect(getRagStreamFailureMessage({ success: true }, 'fallback')).toBeNull();
  });

  it('returns the backend error for failed stream results', () => {
    expect(getRagStreamFailureMessage({ success: false, error: 'model unavailable' }, 'fallback'))
      .toBe('model unavailable');
  });

  it('falls back when the backend error is empty', () => {
    expect(getRagStreamFailureMessage({ success: false, error: '   ' }, 'fallback'))
      .toBe('fallback');
  });
});
