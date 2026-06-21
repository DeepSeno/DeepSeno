import { describe, it, expect } from 'vitest';
import { mergeTranscriptWithDiarization, MergedSegment } from '../merge-transcript';
import { TranscribeResult } from '../transcriber';
import { DiarizeResult } from '../diarizer';

describe('mergeTranscriptWithDiarization', () => {
  it('should correctly assign speakers to transcript segments', () => {
    const transcript: TranscribeResult = {
      language: 'zh',
      full_text: '你好世界测试',
      segments: [
        { start: 0.0, end: 2.0, text: '你好' },
        { start: 2.5, end: 5.0, text: '世界' },
        { start: 6.0, end: 8.0, text: '测试' },
      ],
    };

    const diarization: DiarizeResult = {
      segments: [
        { start: 0.0, end: 3.0, speaker: 'SPEAKER_00' },
        { start: 3.0, end: 6.0, speaker: 'SPEAKER_01' },
        { start: 6.0, end: 9.0, speaker: 'SPEAKER_00' },
      ],
    };

    const merged = mergeTranscriptWithDiarization(transcript, diarization);

    expect(merged).toHaveLength(3);
    // midpoint of (0, 2) = 1.0 -> falls in SPEAKER_00 (0-3)
    expect(merged[0]).toEqual({ start: 0.0, end: 2.0, speaker: 'SPEAKER_00', text: '你好' });
    // midpoint of (2.5, 5) = 3.75 -> falls in SPEAKER_01 (3-6)
    expect(merged[1]).toEqual({ start: 2.5, end: 5.0, speaker: 'SPEAKER_01', text: '世界' });
    // midpoint of (6, 8) = 7.0 -> falls in SPEAKER_00 (6-9)
    expect(merged[2]).toEqual({ start: 6.0, end: 8.0, speaker: 'SPEAKER_00', text: '测试' });
  });

  it('should mark UNKNOWN when no diarization segment matches', () => {
    const transcript: TranscribeResult = {
      language: 'en',
      full_text: 'hello',
      segments: [
        { start: 10.0, end: 12.0, text: 'hello' },
      ],
    };

    const diarization: DiarizeResult = {
      segments: [
        { start: 0.0, end: 5.0, speaker: 'SPEAKER_00' },
      ],
    };

    const merged = mergeTranscriptWithDiarization(transcript, diarization);

    expect(merged).toHaveLength(1);
    expect(merged[0].speaker).toBe('UNKNOWN');
    expect(merged[0].text).toBe('hello');
  });

  it('should handle empty transcript segments', () => {
    const transcript: TranscribeResult = {
      language: 'zh',
      full_text: '',
      segments: [],
    };

    const diarization: DiarizeResult = {
      segments: [{ start: 0, end: 5, speaker: 'SPEAKER_00' }],
    };

    const merged = mergeTranscriptWithDiarization(transcript, diarization);
    expect(merged).toHaveLength(0);
  });

  it('should handle empty diarization segments', () => {
    const transcript: TranscribeResult = {
      language: 'zh',
      full_text: '你好',
      segments: [{ start: 0, end: 2, text: '你好' }],
    };

    const diarization: DiarizeResult = {
      segments: [],
    };

    const merged = mergeTranscriptWithDiarization(transcript, diarization);
    expect(merged).toHaveLength(1);
    expect(merged[0].speaker).toBe('UNKNOWN');
  });
});
