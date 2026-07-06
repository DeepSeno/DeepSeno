import { describe, expect, it } from 'vitest';
import { toPipelineEnqueueResponse } from '../pipeline-enqueue-result';

describe('toPipelineEnqueueResponse', () => {
  it('returns already processed recordings as skipped instead of failed', () => {
    expect(toPipelineEnqueueResponse({
      id: 'recording_40_already_processed',
      status: 'failed',
      error: 'Recording already processed',
      recordingId: 40,
    })).toEqual({
      id: 'recording_40_already_processed',
      status: 'skipped',
      reason: 'already_processed',
      error: 'Recording already processed',
      recordingId: 40,
    });
  });

  it('keeps real enqueue failures as failures with their error', () => {
    expect(toPipelineEnqueueResponse({
      id: '',
      status: 'failed',
      error: 'Cannot access file',
    })).toEqual({
      id: '',
      status: 'failed',
      error: 'Cannot access file',
      recordingId: undefined,
    });
  });
});
