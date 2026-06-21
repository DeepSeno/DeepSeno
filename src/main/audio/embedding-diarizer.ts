/**
 * EmbeddingDiarizer — VAD-first + embedding cosine clustering + post-processing.
 *
 * Replaces the old subprocess-based OfflineSpeakerDiarization approach with a
 * more robust pipeline:
 *   1. Read WAV, extract audio samples for each VAD segment
 *   2. Extract speaker embedding per segment (capped at 30s)
 *   3. Compute NxN cosine similarity matrix
 *   4. Greedy clustering by embedding similarity
 *   5. Post-process: expand boundaries, fill gaps, merge same-speaker
 */

import { fork, type ChildProcess } from 'child_process';
import * as path from 'path';
import type { SherpaEngineProxy } from './sherpa-engine-proxy';
import type { DiarizeSegment, DiarizeResult } from './diarizer';

// ─── Types ──────────────────────────────────────────────────

export interface VadSegment {
  start: number;
  end: number;
  duration: number;
}

export interface EmbeddingDiarizeOptions {
  numSpeakers?: number;        // -1 = auto (default)
  clusteringThreshold?: number; // 0.35 default
  boundaryExpansion?: number;   // 0.15 default
  maxGapToFill?: number;        // 2.0 default
  totalDuration?: number;       // for boundary clipping
  llmCorrect?: (input: SpeakerCorrectionInput) => Promise<DiarizeSegment[]>;
}

// ─── Clustering helpers ─────────────────────────────────────

/**
 * Greedy clustering based on cosine similarity matrix.
 *
 * If numSpeakers > 0, assigns exactly that many clusters.
 * Otherwise (auto mode), creates a new cluster when no existing
 * centroid exceeds the threshold.
 *
 * Returns an array of cluster labels (one per segment).
 */
export function clusterByEmbedding(
  simMatrix: number[][],
  numSpeakers: number,
  threshold: number,
): number[] {
  const n = simMatrix.length;
  if (n === 0) return [];

  const labels = new Array<number>(n).fill(-1);
  // Each cluster tracks which segment indices belong to it
  const clusters: number[][] = [];

  // First segment always starts cluster 0
  labels[0] = 0;
  clusters.push([0]);

  for (let i = 1; i < n; i++) {
    // Compute average similarity to each existing cluster
    let bestCluster = -1;
    let bestSim = -Infinity;

    for (let c = 0; c < clusters.length; c++) {
      let totalSim = 0;
      for (const memberIdx of clusters[c]) {
        totalSim += simMatrix[i][memberIdx];
      }
      const avgSim = totalSim / clusters[c].length;
      if (avgSim > bestSim) {
        bestSim = avgSim;
        bestCluster = c;
      }
    }

    const autoMode = numSpeakers <= 0;
    const atLimit = !autoMode && clusters.length >= numSpeakers;

    if (bestSim >= threshold || atLimit) {
      // Assign to best existing cluster
      labels[i] = bestCluster;
      clusters[bestCluster].push(i);
    } else {
      // Create new cluster
      const newLabel = clusters.length;
      labels[i] = newLabel;
      clusters.push([i]);
    }
  }

  return labels;
}

/**
 * Measures clustering quality as the ratio of intra-cluster similarity
 * to inter-cluster similarity. Higher is better. Returns 0 if clustering
 * is degenerate (single cluster or no segments).
 */
export function clusteringConfidence(
  simMatrix: number[][],
  labels: number[],
): number {
  const n = simMatrix.length;
  if (n <= 1) return 0;

  const uniqueLabels = [...new Set(labels)];
  if (uniqueLabels.length <= 1) return 0;

  let intraSim = 0;
  let intraCount = 0;
  let interSim = 0;
  let interCount = 0;

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (labels[i] === labels[j]) {
        intraSim += simMatrix[i][j];
        intraCount++;
      } else {
        interSim += simMatrix[i][j];
        interCount++;
      }
    }
  }

  const avgIntra = intraCount > 0 ? intraSim / intraCount : 0;
  const avgInter = interCount > 0 ? interSim / interCount : 0;

  // Avoid division by zero — if inter is ~0, clustering is perfect
  if (avgInter <= 0) return 1.0;
  return Math.min(avgIntra / avgInter, 2.0); // cap at 2.0
}

// ─── Post-processing ────────────────────────────────────────

/**
 * Post-process diarization segments:
 *   1. Expand boundaries by ±expansion seconds
 *   2. Clip to [0, totalDuration] if provided
 *   3. Fill gaps shorter than maxGap by extending neighbors
 *   4. Merge consecutive same-speaker segments within mergeGap
 */
export function postProcess(
  segments: DiarizeSegment[],
  totalDuration: number | undefined,
  expansion: number,
  maxGap: number,
  mergeGap = 0.5,
): DiarizeSegment[] {
  if (segments.length === 0) return [];

  // 1. Expand boundaries
  let result = segments.map((seg) => ({
    start: seg.start - expansion,
    end: seg.end + expansion,
    speaker: seg.speaker,
  }));

  // 2. Clip to valid range
  const maxEnd = totalDuration ?? Infinity;
  result = result.map((seg) => ({
    start: Math.max(0, seg.start),
    end: Math.min(maxEnd, seg.end),
    speaker: seg.speaker,
  }));

  // Filter out degenerate segments
  result = result.filter((seg) => seg.end > seg.start);

  if (result.length === 0) return [];

  // Sort by start time
  result.sort((a, b) => a.start - b.start);

  // 3. Fill gaps: if gap between consecutive segments < maxGap, extend them to meet
  for (let i = 0; i < result.length - 1; i++) {
    const gap = result[i + 1].start - result[i].end;
    if (gap > 0 && gap < maxGap) {
      const mid = result[i].end + gap / 2;
      result[i].end = mid;
      result[i + 1].start = mid;
    }
  }

  // 4. Merge consecutive same-speaker segments within mergeGap
  const merged: DiarizeSegment[] = [result[0]];
  for (let i = 1; i < result.length; i++) {
    const prev = merged[merged.length - 1];
    const curr = result[i];
    if (curr.speaker === prev.speaker && (curr.start - prev.end) <= mergeGap) {
      // Extend the previous segment
      prev.end = Math.max(prev.end, curr.end);
    } else {
      merged.push({ ...curr });
    }
  }

  return merged;
}

// ─── EmbeddingDiarizer ──────────────────────────────────────

const MAX_SEGMENT_SAMPLES_SECONDS = 30; // cap embedding extraction at 30s per segment

export class EmbeddingDiarizer {
  private engine: SherpaEngineProxy;

  constructor(engine: SherpaEngineProxy) {
    this.engine = engine;
  }

  /**
   * Run embedding-based diarization.
   *
   * Uses a forked subprocess for VAD + embedding extraction to avoid
   * V8 Worker thread "External buffers are not allowed" errors with
   * sherpa-onnx native memory.
   *
   * @param audioPath  Path to 16kHz mono WAV file
   * @param _vadSegments  Ignored — subprocess runs its own VAD
   * @param options  Clustering and post-processing options
   */
  async diarize(
    audioPath: string,
    _vadSegments: VadSegment[],
    options: EmbeddingDiarizeOptions = {},
  ): Promise<DiarizeResult> {
    const {
      numSpeakers = -1,
      clusteringThreshold = 0.45,
      boundaryExpansion = 0.15,
      maxGapToFill = 2.0,
      totalDuration,
      llmCorrect,
    } = options;

    console.log(
      `[EmbeddingDiarizer] Starting subprocess for: ${audioPath}, ` +
      `numSpeakers=${numSpeakers}, threshold=${clusteringThreshold}`
    );

    // 1. Run VAD + embedding in subprocess (avoids Worker external buffer issues)
    const modelsDir = this.engine.getModelsDir();
    const subprocessResult = await this.runVadEmbedSubprocess(audioPath, modelsDir, clusteringThreshold);

    if (!subprocessResult || subprocessResult.segments.length === 0) {
      console.log('[EmbeddingDiarizer] No segments detected');
      return { segments: [] };
    }

    const { segments: rawSegments, duration } = subprocessResult;
    const audioDuration = totalDuration ?? duration;

    // Subprocess already clustered with OfflineSpeakerDiarization (threshold=0.35)
    // Segments come with speaker numbers — convert to SPEAKER_XX format
    let diarizeSegments: DiarizeSegment[] = rawSegments.map((seg: any) => ({
      start: seg.start,
      end: seg.end,
      speaker: `SPEAKER_${String(seg.speaker).padStart(2, '0')}`,
    }));
    diarizeSegments.sort((a, b) => a.start - b.start);

    const uniqueSpeakers = [...new Set(diarizeSegments.map(s => s.speaker))];
    console.log(
      `[EmbeddingDiarizer] Subprocess: ${diarizeSegments.length} segments, ` +
      `${uniqueSpeakers.length} speakers (${uniqueSpeakers.join(', ')}), ${audioDuration.toFixed(1)}s`
    );

    // Post-process: expand boundaries, fill gaps, merge
    diarizeSegments = postProcess(
      diarizeSegments,
      audioDuration,
      boundaryExpansion,
      maxGapToFill,
    );

    console.log(
      `[EmbeddingDiarizer] Post-process: ${diarizeSegments.length} segments, ` +
      `${[...new Set(diarizeSegments.map((s) => s.speaker))].length} speakers`
    );

    return { segments: diarizeSegments };
  }

  /**
   * Fork a child process to run VAD + embedding extraction.
   * Returns segments + similarity matrix, or null on failure.
   */
  private runVadEmbedSubprocess(
    audioPath: string,
    modelsDir: string,
    clusteringThreshold = 0.45,
  ): Promise<{ segments: Array<{ start: number; end: number; speaker: number }>; duration: number } | null> {
    return new Promise((resolve) => {
      const TIMEOUT = 5 * 60 * 1000; // 5 minutes

      // Resolve subprocess path (works in both dev and packaged builds)
      // In bundled builds, __dirname points to dist/main/
      const subprocessPath = path.resolve(__dirname, 'vad-embed-subprocess.js');

      let child: ChildProcess;
      try {
        child = fork(subprocessPath, [], {
          stdio: ['pipe', 'inherit', 'inherit', 'ipc'],
          env: { ...process.env },
        });
      } catch (err: any) {
        console.warn(`[EmbeddingDiarizer] Failed to fork subprocess: ${err.message}`);
        resolve(null);
        return;
      }

      const timer = setTimeout(() => {
        console.warn('[EmbeddingDiarizer] Subprocess timed out');
        child.kill('SIGKILL');
        resolve(null);
      }, TIMEOUT);

      child.on('message', (msg: any) => {
        if (msg?.type === 'ready') {
          // Send work request
          child.send({
            type: 'vadEmbed',
            audioPath,
            modelsDir,
            clusteringThreshold,
          });
        } else if (msg?.type === 'result') {
          clearTimeout(timer);
          child.kill();
          resolve({
            segments: msg.segments,
            duration: msg.duration,
          });
        } else if (msg?.type === 'error') {
          clearTimeout(timer);
          console.warn(`[EmbeddingDiarizer] Subprocess error: ${msg.message}`);
          child.kill();
          resolve(null);
        }
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        console.warn(`[EmbeddingDiarizer] Subprocess error: ${err.message}`);
        resolve(null);
      });

      child.on('exit', (code) => {
        clearTimeout(timer);
        if (code !== 0 && code !== null) {
          console.warn(`[EmbeddingDiarizer] Subprocess exited with code ${code}`);
          resolve(null);
        }
      });
    });
  }
}
