import { describe, expect, it } from 'vitest';
import type { RecordingRow } from '../../hooks/useApi';
import { deriveRecordingTitle } from '../recordingTitle';

function recording(overrides: Partial<RecordingRow>): RecordingRow {
  return {
    id: 1,
    file_path: '/tmp/ABCDEFG.docx',
    file_name: 'ABCDEFG.docx',
    status: 'completed',
    recorded_at: '2026-07-07T00:00:00.000Z',
    processed_at: '2026-07-07T00:01:00.000Z',
    status_updated_at: '2026-07-07T00:01:00.000Z',
    media_type: 'docx',
    ...overrides,
  } as RecordingRow;
}

describe('deriveRecordingTitle', () => {
  it('keeps document source filename ahead of AI and segment text', () => {
    expect(deriveRecordingTitle(recording({
      auto_title: '文件内容标题',
      first_segment_text: '这是一段文档正文内容',
    }))).toBe('ABCDEFG');
  });

  it('still lets a user custom title override document filename', () => {
    expect(deriveRecordingTitle(recording({
      custom_title: '用户手动命名',
      auto_title: '文件内容标题',
    }))).toBe('用户手动命名');
  });

  it('keeps AI title behavior for audio recordings', () => {
    expect(deriveRecordingTitle(recording({
      file_name: 'LIVE-202607070001.wav',
      media_type: 'audio',
      auto_title: '健康东街复盘',
      first_segment_text: '今天聊一下健康东街的问题',
    }))).toBe('健康东街复盘');
  });
});
