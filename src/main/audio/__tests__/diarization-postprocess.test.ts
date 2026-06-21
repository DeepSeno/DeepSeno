import { describe, it, expect } from 'vitest';
import {
  postProcessDiarization,
  type DiarSegment,
} from '../diarization-postprocess';

describe('postProcessDiarization', () => {
  it('should handle empty input', () => {
    expect(postProcessDiarization([])).toEqual([]);
  });

  it('should handle single segment', () => {
    const segments: DiarSegment[] = [{ start: 0, end: 5, speaker: 'SPEAKER_00' }];
    const result = postProcessDiarization(segments);
    expect(result).toEqual([{ start: 0, end: 5, speaker: 'SPEAKER_00' }]);
  });

  it('should preserve valid segments unchanged', () => {
    const segments: DiarSegment[] = [
      { start: 0, end: 3, speaker: 'SPEAKER_00' },
      { start: 4, end: 8, speaker: 'SPEAKER_01' },
      { start: 9, end: 14, speaker: 'SPEAKER_00' },
    ];
    const result = postProcessDiarization(segments);
    expect(result).toEqual(segments);
  });

  it('should remove segments shorter than minDuration', () => {
    const segments: DiarSegment[] = [
      { start: 0, end: 3, speaker: 'SPEAKER_00' },
      { start: 3.1, end: 3.2, speaker: 'SPEAKER_01' }, // 0.1s — too short
      { start: 4, end: 8, speaker: 'SPEAKER_00' },
    ];
    const result = postProcessDiarization(segments);
    // The short segment should be absorbed into SPEAKER_00's first segment
    // Then the two SPEAKER_00 segments should merge (gap = 4 - 3.2 = 0.8s > 0.5s default)
    expect(result.length).toBeLessThan(segments.length);
    // Short segment absorbed into prev: prev.end becomes max(3, 3.2) = 3.2
    // Then we have [{0,3.2,SP00}, {4,8,SP00}] — gap is 0.8s > 0.5, so no merge
    expect(result).toEqual([
      { start: 0, end: 3.2, speaker: 'SPEAKER_00' },
      { start: 4, end: 8, speaker: 'SPEAKER_00' },
    ]);
  });

  it('should absorb short segment at the beginning by dropping it', () => {
    const segments: DiarSegment[] = [
      { start: 0, end: 0.1, speaker: 'SPEAKER_01' }, // too short, no previous
      { start: 1, end: 5, speaker: 'SPEAKER_00' },
    ];
    const result = postProcessDiarization(segments);
    expect(result).toEqual([{ start: 1, end: 5, speaker: 'SPEAKER_00' }]);
  });

  it('should merge adjacent same-speaker segments within gap threshold', () => {
    const segments: DiarSegment[] = [
      { start: 0, end: 2, speaker: 'SPEAKER_00' },
      { start: 2.3, end: 5, speaker: 'SPEAKER_00' }, // gap = 0.3s < 0.5s
      { start: 5.2, end: 8, speaker: 'SPEAKER_00' }, // gap = 0.2s < 0.5s
    ];
    const result = postProcessDiarization(segments);
    expect(result).toEqual([{ start: 0, end: 8, speaker: 'SPEAKER_00' }]);
  });

  it('should not merge same-speaker segments when gap exceeds threshold', () => {
    const segments: DiarSegment[] = [
      { start: 0, end: 2, speaker: 'SPEAKER_00' },
      { start: 3, end: 5, speaker: 'SPEAKER_00' }, // gap = 1.0s > 0.5s
    ];
    const result = postProcessDiarization(segments);
    expect(result).toEqual([
      { start: 0, end: 2, speaker: 'SPEAKER_00' },
      { start: 3, end: 5, speaker: 'SPEAKER_00' },
    ]);
  });

  it('should remove spurious speakers and reassign to nearest valid speaker', () => {
    const segments: DiarSegment[] = [
      { start: 0, end: 5, speaker: 'SPEAKER_00' },
      { start: 5.5, end: 6, speaker: 'SPEAKER_02' }, // 0.5s total — spurious
      { start: 7, end: 12, speaker: 'SPEAKER_01' },
    ];
    const result = postProcessDiarization(segments);
    // SPEAKER_02 has 0.5s total (<1.0s), should be reassigned
    // Nearest to {5.5,6}: distance to SP00(end=5) = 0.5, distance to SP01(start=7) = 1.0 → SP00
    expect(result.every((s) => s.speaker !== 'SPEAKER_02')).toBe(true);
    // After reassignment to SP00: [{0,5,SP00}, {5.5,6,SP00}, {7,12,SP01}]
    // Final merge: gap 5.5-5=0.5 is NOT < 0.5 (equal), so no merge
    expect(result).toEqual([
      { start: 0, end: 5, speaker: 'SPEAKER_00' },
      { start: 5.5, end: 6, speaker: 'SPEAKER_00' },
      { start: 7, end: 12, speaker: 'SPEAKER_01' },
    ]);
  });

  it('should reassign spurious speaker to nearest and then merge in final pass', () => {
    const segments: DiarSegment[] = [
      { start: 0, end: 5, speaker: 'SPEAKER_00' },
      { start: 5.2, end: 5.8, speaker: 'SPEAKER_02' }, // 0.6s total — spurious
      { start: 7, end: 12, speaker: 'SPEAKER_01' },
    ];
    const result = postProcessDiarization(segments);
    // SPEAKER_02 (0.6s) reassigned to nearest: distance to SP00 = 5.2-5=0.2, SP01 = 7-5.8=1.2 → SP00
    // After reassignment: [{0,5,SP00}, {5.2,5.8,SP00}, {7,12,SP01}]
    // Final merge: gap 5.2-5=0.2 < 0.5 → merge → [{0,5.8,SP00}, {7,12,SP01}]
    expect(result).toEqual([
      { start: 0, end: 5.8, speaker: 'SPEAKER_00' },
      { start: 7, end: 12, speaker: 'SPEAKER_01' },
    ]);
  });

  it('should keep all speakers if all are spurious (do not delete everything)', () => {
    const segments: DiarSegment[] = [
      { start: 0, end: 0.5, speaker: 'SPEAKER_00' },
      { start: 1, end: 1.4, speaker: 'SPEAKER_01' },
    ];
    const result = postProcessDiarization(segments);
    // Both speakers have <1.0s, so all are "spurious" — should keep them
    expect(result.length).toBeGreaterThan(0);
  });

  it('should respect custom options', () => {
    const segments: DiarSegment[] = [
      { start: 0, end: 3, speaker: 'SPEAKER_00' },
      { start: 3.1, end: 3.3, speaker: 'SPEAKER_01' }, // 0.2s — above custom min 0.1
      { start: 4, end: 8, speaker: 'SPEAKER_00' },
    ];
    const result = postProcessDiarization(segments, {
      minSegmentDuration: 0.1,
      mergeGap: 0.5,
      minSpeakerDuration: 1.0,
    });
    // 0.2s segment is kept (above 0.1 threshold)
    // But SPEAKER_01 total = 0.2s < 1.0s → spurious, reassigned
    const speakers = new Set(result.map((s) => s.speaker));
    expect(speakers.has('SPEAKER_01')).toBe(false);
  });

  it('should handle complex scenario with all three steps', () => {
    const segments: DiarSegment[] = [
      { start: 0, end: 4, speaker: 'SPEAKER_00' },
      { start: 4.1, end: 4.2, speaker: 'SPEAKER_02' }, // 0.1s — removed (short)
      { start: 4.3, end: 4.5, speaker: 'SPEAKER_00' }, // merges with first after short removal
      { start: 5, end: 5.6, speaker: 'SPEAKER_03' }, // 0.6s total — spurious
      { start: 6, end: 10, speaker: 'SPEAKER_01' },
      { start: 10.3, end: 14, speaker: 'SPEAKER_01' }, // merges with previous
    ];
    const result = postProcessDiarization(segments);
    // Step 1: Remove {4.1,4.2,SP02} → absorbed into prev({0,4,SP00}) → {0,4.2,SP00}
    //   Remaining: [{0,4.2,SP00}, {4.3,4.5,SP00}, {5,5.6,SP03}, {6,10,SP01}, {10.3,14,SP01}]
    // Step 2: Merge same-speaker:
    //   {0,4.2,SP00} + {4.3,4.5,SP00} gap=0.1 < 0.5 → {0,4.5,SP00}
    //   {6,10,SP01} + {10.3,14,SP01} gap=0.3 < 0.5 → {6,14,SP01}
    //   → [{0,4.5,SP00}, {5,5.6,SP03}, {6,14,SP01}]
    // Step 3: SP00=4.5s ✓, SP01=8s ✓, SP03=0.6s ✗ → reassign SP03
    //   Nearest to {5,5.6}: SP00 end=4.5 → dist=0.5, SP01 start=6 → dist=0.4 → SP01
    //   → [{0,4.5,SP00}, {5,5.6,SP01}, {6,14,SP01}]
    // Step 4: Final merge: {5,5.6,SP01} + {6,14,SP01} gap=0.4 < 0.5 → {5,14,SP01}
    //   → [{0,4.5,SP00}, {5,14,SP01}]
    expect(result).toEqual([
      { start: 0, end: 4.5, speaker: 'SPEAKER_00' },
      { start: 5, end: 14, speaker: 'SPEAKER_01' },
    ]);
  });
});
