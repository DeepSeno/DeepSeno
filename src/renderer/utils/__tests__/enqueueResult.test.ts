import { describe, expect, it } from 'vitest';
import {
  isAlreadyProcessedEnqueue,
  isFailedEnqueue,
  isSkippedEnqueue,
} from '../enqueueResult';

describe('enqueue result helpers', () => {
  it('classifies already-processed uploads as skipped, not failed', () => {
    const result = {
      id: 'recording_40_already_processed',
      status: 'skipped',
      reason: 'already_processed',
      error: 'Recording already processed',
    };

    expect(isAlreadyProcessedEnqueue(result)).toBe(true);
    expect(isSkippedEnqueue(result)).toBe(true);
    expect(isFailedEnqueue(result)).toBe(false);
  });

  it('keeps real enqueue failures separate from skipped duplicates', () => {
    const result = {
      id: '',
      status: 'failed',
      error: 'Cannot access file',
    };

    expect(isAlreadyProcessedEnqueue(result)).toBe(false);
    expect(isSkippedEnqueue(result)).toBe(false);
    expect(isFailedEnqueue(result)).toBe(true);
  });
});
