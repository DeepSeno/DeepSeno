import { describe, expect, it } from 'vitest';
import { getLibraryListDateMeta, getLibraryListTimestamp } from '../listDate';

describe('library list date', () => {
  it('uses processed_at before recorded_at for uploaded content', () => {
    const timestamp = getLibraryListTimestamp({
      recorded_at: '2026-07-03T16:25:00',
      processed_at: '2026-07-06T17:10:00',
    });

    expect(timestamp).toBe('2026-07-06T17:10:00');
  });

  it('groups by the processed date shown in the content library', () => {
    const meta = getLibraryListDateMeta(
      {
        recorded_at: '2026-07-03T16:25:00',
        processed_at: '2026-07-06T17:10:00',
      },
      'zh-CN',
      new Date('2026-07-06T23:00:00'),
    );

    expect(meta.dateGroup).toBe('today');
    expect(meta.actualDate).toBe('2026-07-06');
    expect(meta.time).not.toBe('');
  });

  it('falls back to recorded_at for older rows without processing metadata', () => {
    const meta = getLibraryListDateMeta(
      { recorded_at: '2026-07-05T09:00:00', processed_at: null },
      'zh-CN',
      new Date('2026-07-06T23:00:00'),
    );

    expect(meta.dateGroup).toBe('yesterday');
    expect(meta.actualDate).toBe('2026-07-05');
  });
});
