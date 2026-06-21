import { describe, it, expect } from 'vitest';
import {
  clusterByEmbedding,
  clusteringConfidence,
  postProcess,
} from '../embedding-diarizer';

describe('EmbeddingDiarizer — pure function tests', () => {
  // ── clusterByEmbedding ─────────────────────────────────────

  describe('clusterByEmbedding', () => {
    it('groups segments with high similarity as same speaker', () => {
      // 3 segments: 0↔1 similar (0.8), 0↔2 different (0.1), 1↔2 different (0.05)
      const simMatrix = [
        [1.0, 0.8, 0.1],
        [0.8, 1.0, 0.05],
        [0.1, 0.05, 1.0],
      ];
      const labels = clusterByEmbedding(simMatrix, -1, 0.35);
      expect(labels[0]).toBe(labels[1]); // same speaker
      expect(labels[0]).not.toBe(labels[2]); // different speaker
    });

    it('assigns all to one speaker when all similar', () => {
      const simMatrix = [
        [1.0, 0.9, 0.85],
        [0.9, 1.0, 0.88],
        [0.85, 0.88, 1.0],
      ];
      const labels = clusterByEmbedding(simMatrix, -1, 0.35);
      expect(labels[0]).toBe(labels[1]);
      expect(labels[1]).toBe(labels[2]);
    });

    it('separates all segments when all dissimilar', () => {
      const simMatrix = [
        [1.0, 0.1, 0.05],
        [0.1, 1.0, 0.08],
        [0.05, 0.08, 1.0],
      ];
      const labels = clusterByEmbedding(simMatrix, -1, 0.35);
      const unique = new Set(labels);
      expect(unique.size).toBe(3);
    });

    it('respects numSpeakers limit — merges into at most N clusters', () => {
      // 4 segments, all different, but limit to 2 speakers
      const simMatrix = [
        [1.0, 0.1, 0.1, 0.1],
        [0.1, 1.0, 0.1, 0.1],
        [0.1, 0.1, 1.0, 0.1],
        [0.1, 0.1, 0.1, 1.0],
      ];
      const labels = clusterByEmbedding(simMatrix, 2, 0.35);
      const uniqueLabels = new Set(labels);
      expect(uniqueLabels.size).toBeLessThanOrEqual(2);
    });

    it('handles single segment', () => {
      const labels = clusterByEmbedding([[1.0]], -1, 0.35);
      expect(labels).toEqual([0]);
    });

    it('handles empty input', () => {
      const labels = clusterByEmbedding([], -1, 0.35);
      expect(labels).toEqual([]);
    });

    it('first segment always gets label 0', () => {
      const simMatrix = [
        [1.0, 0.5],
        [0.5, 1.0],
      ];
      const labels = clusterByEmbedding(simMatrix, -1, 0.35);
      expect(labels[0]).toBe(0);
    });

    it('assigns to best matching cluster when multiple exist', () => {
      // 4 segments: 0,1 form cluster A (high sim), 2 forms cluster B, 3 is similar to A
      const simMatrix = [
        [1.0, 0.9, 0.1, 0.85],
        [0.9, 1.0, 0.1, 0.8],
        [0.1, 0.1, 1.0, 0.05],
        [0.85, 0.8, 0.05, 1.0],
      ];
      const labels = clusterByEmbedding(simMatrix, -1, 0.35);
      // Segment 3 should join cluster A (labels[0])
      expect(labels[3]).toBe(labels[0]);
      expect(labels[3]).not.toBe(labels[2]);
    });
  });

  // ── clusteringConfidence ───────────────────────────────────

  describe('clusteringConfidence', () => {
    it('returns high confidence for clear separation', () => {
      // 2 clusters: intra = 0.8, inter = avg(0.1, 0.1) = 0.1 → ratio = 8.0, capped at 2.0
      const simMatrix = [
        [1.0, 0.8, 0.1],
        [0.8, 1.0, 0.1],
        [0.1, 0.1, 1.0],
      ];
      const labels = [0, 0, 1];
      const conf = clusteringConfidence(simMatrix, labels);
      expect(conf).toBe(2.0); // capped
    });

    it('returns moderate confidence for moderate separation', () => {
      // intra = 0.6, inter = avg(0.3, 0.3) = 0.3 → ratio = 2.0
      const simMatrix = [
        [1.0, 0.6, 0.3],
        [0.6, 1.0, 0.3],
        [0.3, 0.3, 1.0],
      ];
      const labels = [0, 0, 1];
      const conf = clusteringConfidence(simMatrix, labels);
      expect(conf).toBe(2.0);
    });

    it('returns low confidence when intra and inter are similar', () => {
      // intra = 0.4, inter = avg(0.35, 0.35) = 0.35 → ratio ≈ 1.14
      const simMatrix = [
        [1.0, 0.4, 0.35],
        [0.4, 1.0, 0.35],
        [0.35, 0.35, 1.0],
      ];
      const labels = [0, 0, 1];
      const conf = clusteringConfidence(simMatrix, labels);
      expect(conf).toBeCloseTo(0.4 / 0.35, 2); // ~1.14
      expect(conf).toBeLessThan(1.5);
    });

    it('returns 0 for single segment', () => {
      const conf = clusteringConfidence([[1.0]], [0]);
      expect(conf).toBe(0);
    });

    it('returns 0 for single cluster (all same label)', () => {
      const simMatrix = [
        [1.0, 0.5],
        [0.5, 1.0],
      ];
      const conf = clusteringConfidence(simMatrix, [0, 0]);
      expect(conf).toBe(0);
    });

    it('returns 1.0 when inter-cluster similarity is 0', () => {
      // Two clusters with zero inter-similarity
      const simMatrix = [
        [1.0, 0.9, 0.0],
        [0.9, 1.0, 0.0],
        [0.0, 0.0, 1.0],
      ];
      const labels = [0, 0, 1];
      const conf = clusteringConfidence(simMatrix, labels);
      // avgInter = 0 → returns 1.0
      expect(conf).toBe(1.0);
    });

    it('caps at 2.0', () => {
      // intra = 0.9, inter = 0.05 → ratio = 18.0, capped at 2.0
      const simMatrix = [
        [1.0, 0.9, 0.05],
        [0.9, 1.0, 0.05],
        [0.05, 0.05, 1.0],
      ];
      const labels = [0, 0, 1];
      const conf = clusteringConfidence(simMatrix, labels);
      expect(conf).toBe(2.0);
    });
  });

  // ── postProcess ────────────────────────────────────────────

  describe('postProcess', () => {
    it('expands segment boundaries', () => {
      const segments = [{ start: 1.0, end: 2.0, speaker: 'SPEAKER_00' }];
      const result = postProcess(segments, 5.0, 0.15, 2.0, 0.5);
      expect(result[0].start).toBeCloseTo(0.85, 2);
      expect(result[0].end).toBeCloseTo(2.15, 2);
    });

    it('clips start to 0', () => {
      const segments = [{ start: 0.05, end: 2.0, speaker: 'SPEAKER_00' }];
      const result = postProcess(segments, 5.0, 0.15, 2.0, 0.5);
      expect(result[0].start).toBe(0);
    });

    it('clips end to totalDuration', () => {
      const segments = [{ start: 0.0, end: 5.0, speaker: 'SPEAKER_00' }];
      const result = postProcess(segments, 4.0, 0.15, 2.0, 0.5);
      expect(result[0].end).toBeLessThanOrEqual(4.0);
    });

    it('fills gaps between same-speaker segments', () => {
      const segments = [
        { start: 0.0, end: 2.0, speaker: 'SPEAKER_00' },
        { start: 3.0, end: 5.0, speaker: 'SPEAKER_00' },
      ];
      // expansion=0, maxGap=2.0, mergeGap=0.5
      // Gap = 1.0 < 2.0 → fill: both extend to meet at 2.5
      // Then same-speaker, gap = 0 ≤ 0.5 → merge to [0, 5]
      const result = postProcess(segments, 6.0, 0.0, 2.0, 0.5);
      expect(result.length).toBe(1);
      expect(result[0].start).toBe(0.0);
      expect(result[0].end).toBe(5.0);
    });

    it('fills gaps between different-speaker segments', () => {
      const segments = [
        { start: 0.0, end: 2.0, speaker: 'SPEAKER_00' },
        { start: 3.0, end: 5.0, speaker: 'SPEAKER_01' },
      ];
      // Gap = 1.0 < 2.0 → fill at midpoint 2.5
      // Different speakers → not merged
      const result = postProcess(segments, 6.0, 0.0, 2.0, 0.5);
      expect(result.length).toBe(2);
      expect(result[0].end).toBeCloseTo(2.5, 2);
      expect(result[1].start).toBeCloseTo(2.5, 2);
    });

    it('does not fill gaps larger than maxGap', () => {
      const segments = [
        { start: 0.0, end: 2.0, speaker: 'SPEAKER_00' },
        { start: 5.0, end: 7.0, speaker: 'SPEAKER_00' },
      ];
      // Gap = 3.0 > 2.0 → not filled
      // Same speaker but gap 3.0 > mergeGap 0.5 → not merged
      const result = postProcess(segments, 8.0, 0.0, 2.0, 0.5);
      expect(result.length).toBe(2);
    });

    it('merges adjacent same-speaker segments within mergeGap', () => {
      const segments = [
        { start: 0.0, end: 2.0, speaker: 'SPEAKER_00' },
        { start: 2.3, end: 4.0, speaker: 'SPEAKER_00' },
      ];
      // expansion=0, maxGap=0 (no gap filling), mergeGap=0.5
      // Gap = 0.3 ≤ 0.5 → merge
      const result = postProcess(segments, 5.0, 0.0, 0.0, 0.5);
      expect(result.length).toBe(1);
      expect(result[0].start).toBe(0.0);
      expect(result[0].end).toBe(4.0);
    });

    it('keeps different-speaker segments separate', () => {
      const segments = [
        { start: 0.0, end: 2.0, speaker: 'SPEAKER_00' },
        { start: 2.1, end: 4.0, speaker: 'SPEAKER_01' },
      ];
      const result = postProcess(segments, 5.0, 0.0, 0.0, 0.5);
      expect(result.length).toBe(2);
      expect(result[0].speaker).toBe('SPEAKER_00');
      expect(result[1].speaker).toBe('SPEAKER_01');
    });

    it('handles empty input', () => {
      const result = postProcess([], 5.0, 0.15, 2.0, 0.5);
      expect(result).toEqual([]);
    });

    it('filters degenerate segments (end <= start after expansion clip)', () => {
      // Segment is 0.1s, expansion is 0, but after clipping to duration 0.05 → degenerate
      const segments = [{ start: 0.0, end: 0.1, speaker: 'SPEAKER_00' }];
      const result = postProcess(segments, 0.05, 0.0, 2.0, 0.5);
      // end clipped to 0.05, start stays 0 → still valid (0.05 > 0)
      expect(result.length).toBe(1);
      expect(result[0].end).toBe(0.05);
    });

    it('sorts segments by start time', () => {
      const segments = [
        { start: 5.0, end: 7.0, speaker: 'SPEAKER_01' },
        { start: 0.0, end: 2.0, speaker: 'SPEAKER_00' },
      ];
      const result = postProcess(segments, 8.0, 0.0, 0.0, 0.5);
      expect(result[0].start).toBe(0.0);
      expect(result[1].start).toBe(5.0);
    });

    it('handles undefined totalDuration (no upper clipping)', () => {
      const segments = [{ start: 0.0, end: 100.0, speaker: 'SPEAKER_00' }];
      const result = postProcess(segments, undefined, 0.5, 2.0, 0.5);
      expect(result[0].end).toBeCloseTo(100.5, 2); // expanded, not clipped
    });
  });
});
