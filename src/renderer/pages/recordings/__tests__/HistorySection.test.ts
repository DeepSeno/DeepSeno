import { describe, expect, it } from 'vitest';
import { canOpenHistoryItem, getHistoryStatusLabel } from '../HistorySection';
import { sortHistoryItemsForDisplay } from '../types';

describe('HistorySection status helpers', () => {
  const rec = {
    status_success: '成功',
    status_cancelled: '已取消',
    status_interrupted: '已中断',
    status_error: '异常',
    status_active: '进行中',
  } as any;

  it('labels interrupted recordings without treating them as errors', () => {
    expect(getHistoryStatusLabel({ status: 'interrupted' }, rec)).toBe('已中断');
  });

  it('only opens completed recordings into the content library', () => {
    expect(canOpenHistoryItem({ status: 'done' })).toBe(true);
    expect(canOpenHistoryItem({ status: 'interrupted' })).toBe(false);
    expect(canOpenHistoryItem({ status: 'error' })).toBe(false);
  });

  it('orders rows by the most recent status update', () => {
    const sorted = sortHistoryItemsForDisplay([
      { recordingId: 41, statusUpdatedAt: '2026-07-06T16:00:00.000Z' },
      { recordingId: 40, statusUpdatedAt: '2026-07-06T15:00:00.000Z' },
      { recordingId: 32, statusUpdatedAt: '2026-07-06T16:47:15.000Z' },
      { recordingId: 37, statusUpdatedAt: '2026-07-06T15:05:00.000Z' },
    ]);

    expect(sorted.map((item) => item.recordingId)).toEqual([32, 41, 37, 40]);
  });
});
