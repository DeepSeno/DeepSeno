import fs from 'fs';
import type { SherpaEngineProxy } from './sherpa-engine-proxy';
import { postProcessDiarization } from './diarization-postprocess';

export interface DiarizeSegment { start: number; end: number; speaker: string; }
export interface DiarizeResult {
  segments: DiarizeSegment[];
  /** Per-speaker average embeddings (keyed by SPEAKER_XX label). Optional. */
  speakerEmbeddings?: Record<string, number[]>;
}

export class Diarizer {
  private engine: SherpaEngineProxy;

  constructor(engine: SherpaEngineProxy) {
    this.engine = engine;
  }

  async diarize(audioPath: string, _hfToken?: string): Promise<DiarizeResult> {
    // Adaptive clustering threshold based on audio duration
    // Shorter audio → lower threshold (more aggressive speaker separation)
    // Longer audio → higher threshold (more data means more confidence in clustering)
    const threshold = this.computeAdaptiveThreshold(audioPath);
    console.log(`[Diarizer] Adaptive clustering threshold: ${threshold.toFixed(2)}`);

    const rawSegments = await this.engine.diarize(audioPath, threshold);

    // Convert numeric speaker IDs to SPEAKER_XX format
    const segments: DiarizeSegment[] = rawSegments.map((seg) => ({
      start: seg.start,
      end: seg.end,
      speaker: `SPEAKER_${String(seg.speaker).padStart(2, '0')}`,
    }));

    // Post-process: remove short segments, merge same-speaker, filter spurious speakers
    const processed = postProcessDiarization(segments);
    console.log(`[Diarizer] Post-process: ${segments.length} → ${processed.length} segments, ${[...new Set(processed.map(s => s.speaker))].length} speakers`);

    return { segments: processed };
  }

  private computeAdaptiveThreshold(audioPath: string): number {
    try {
      const stats = fs.statSync(audioPath);
      // Rough estimate: 16kHz * 2 bytes/sample = 32000 bytes/sec for 16-bit PCM WAV
      const estimatedDurationSec = stats.size / 32000;
      if (estimatedDurationSec < 60) return 0.40;
      if (estimatedDurationSec < 300) return 0.45;
      // Long audio uses chunked diarization (10-min chunks), so each chunk is
      // effectively medium-length — use 0.45 instead of 0.50 for better separation
      if (estimatedDurationSec >= 15 * 60) {
        console.log(`[Diarizer] Long audio (~${Math.round(estimatedDurationSec / 60)}min), chunked diarization will be used`);
        return 0.45;
      }
      return 0.50;
    } catch {
      return 0.45; // safe default
    }
  }
}
