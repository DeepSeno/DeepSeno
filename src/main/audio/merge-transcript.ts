import { TranscribeResult } from './transcriber';
import { DiarizeResult } from './diarizer';

export interface MergedSegment { start: number; end: number; speaker: string; text: string; }

export function mergeTranscriptWithDiarization(transcript: TranscribeResult, diarization: DiarizeResult): MergedSegment[] {
  // SenseVoice ASR returns a single segment with no timestamps (start:0, end:0).
  // In this case, find the dominant speaker from diarization by total duration.
  if (
    transcript.segments.length === 1 &&
    transcript.segments[0].start === 0 &&
    transcript.segments[0].end === 0
  ) {
    const speakerDurations: Record<string, number> = {};
    for (const d of diarization.segments) {
      speakerDurations[d.speaker] = (speakerDurations[d.speaker] || 0) + (d.end - d.start);
    }
    let dominantSpeaker = 'UNKNOWN';
    let maxDuration = 0;
    for (const [speaker, dur] of Object.entries(speakerDurations)) {
      if (dur > maxDuration) {
        maxDuration = dur;
        dominantSpeaker = speaker;
      }
    }
    return [{
      start: 0,
      end: 0,
      text: transcript.segments[0].text,
      speaker: dominantSpeaker,
    }];
  }

  // Original logic for ASR models that provide per-segment timestamps (e.g. Whisper)
  return transcript.segments.map((tSeg) => {
    const mid = (tSeg.start + tSeg.end) / 2;
    const dSeg = diarization.segments.find((d) => d.start <= mid && d.end >= mid);
    return { start: tSeg.start, end: tSeg.end, speaker: dSeg?.speaker || 'UNKNOWN', text: tSeg.text };
  });
}

export interface DualSourceSegment {
  start_time: number;
  end_time: number;
  text: string;
  source: 'mic' | 'system';
  speaker_id?: number;
  speaker_label?: string;
}

/**
 * Merge segments from mic and system sources into a unified timeline.
 * Segments are sorted by start_time. Overlapping segments from different
 * sources are preserved (people talking simultaneously is normal in meetings).
 */
export function mergeDualSourceSegments(
  micSegments: DualSourceSegment[],
  systemSegments: DualSourceSegment[],
): DualSourceSegment[] {
  const all = [
    ...micSegments.map(s => ({ ...s, source: 'mic' as const })),
    ...systemSegments.map(s => ({ ...s, source: 'system' as const })),
  ];
  return all.sort((a, b) => a.start_time - b.start_time);
}
