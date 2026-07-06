import { describe, expect, it } from 'vitest';
import { canRetryQueueItem, getQueueStatusLabel, getQueueSummaryLabel } from '../QueueSection';
import type { QueueItem } from '../types';

function makeItem(status: QueueItem['status']): QueueItem {
  return {
    id: `task-${status}-${Math.random()}`,
    name: 'file.pdf',
    filePath: '/tmp/file.pdf',
    duration: '',
    size: '',
    progress: 0,
    status,
    rawStatus: status,
    currentStep: -1,
    error: null,
    notes: null,
  };
}

describe('getQueueSummaryLabel', () => {
  const rec = {
    queue_in_progress: '进行中',
    status_queued: '排队中',
    status_error: '异常',
    status_interrupted: '已中断',
    status_success: '成功',
    status_cancelled: '已取消',
  } as any;

  it('labels pending tasks as queued', () => {
    expect(getQueueSummaryLabel([makeItem('pending')], rec)).toBe('1 排队中');
  });

  it('separates processing and queued counts', () => {
    expect(getQueueSummaryLabel([
      makeItem('processing'),
      makeItem('pending'),
      makeItem('pending'),
    ], rec)).toBe('1 进行中 / 2 排队中');
  });

  it('labels interrupted and failed tasks separately', () => {
    expect(getQueueSummaryLabel([
      makeItem('interrupted'),
      makeItem('error'),
    ], rec)).toBe('1 已中断 / 1 异常');
  });

  it('shows interrupted as a retryable non-error state', () => {
    const item = makeItem('interrupted');
    expect(getQueueStatusLabel(item, rec)).toBe('已中断');
    expect(canRetryQueueItem(item)).toBe(true);
  });
});
