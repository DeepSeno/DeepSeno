/**
 * Post-processing for speaker diarization output.
 *
 * Cleans up raw diarization segments by:
 * 1. Removing short noise segments (<0.3s) — absorbed into previous segment
 * 2. Merging adjacent same-speaker segments with small gaps (<0.5s)
 * 3. Removing spurious speakers (total speaking time <1.0s) — reassigned to nearest valid speaker
 * 4. Final merge pass after reassignment
 */

export interface DiarSegment {
  start: number;
  end: number;
  speaker: string;
}

export interface PostProcessOptions {
  minSegmentDuration?: number; // default: 0.3
  mergeGap?: number; // default: 0.5
  minSpeakerDuration?: number; // default: 1.0
  light?: boolean; // light mode: only merge adjacent same-speaker segments, skip aggressive filtering
}

const DEFAULT_OPTIONS: Required<PostProcessOptions> = {
  minSegmentDuration: 0.3,
  mergeGap: 0.5,
  minSpeakerDuration: 1.0,
  light: false,
};

/**
 * Merge adjacent segments that share the same speaker and have a gap smaller
 * than `mergeGap` seconds.
 */
function mergeSameSpeaker(segments: DiarSegment[], mergeGap: number): DiarSegment[] {
  if (segments.length === 0) return [];

  const merged: DiarSegment[] = [{ ...segments[0] }];

  for (let i = 1; i < segments.length; i++) {
    const prev = merged[merged.length - 1];
    const cur = segments[i];

    if (cur.speaker === prev.speaker && cur.start - prev.end < mergeGap) {
      // Extend previous segment to cover current
      prev.end = Math.max(prev.end, cur.end);
    } else {
      merged.push({ ...cur });
    }
  }

  return merged;
}

/**
 * Find the nearest valid speaker to a given segment based on temporal proximity.
 * Looks at the closest segment boundary (end of previous or start of next) among
 * segments belonging to valid speakers.
 */
function findNearestSpeaker(
  segment: DiarSegment,
  allSegments: DiarSegment[],
  validSpeakers: Set<string>,
): string | null {
  let bestSpeaker: string | null = null;
  let bestDistance = Infinity;

  for (const other of allSegments) {
    if (!validSpeakers.has(other.speaker)) continue;

    // Distance = smallest gap between the two segments
    const distance = Math.min(
      Math.abs(segment.start - other.end),
      Math.abs(other.start - segment.end),
    );

    if (distance < bestDistance) {
      bestDistance = distance;
      bestSpeaker = other.speaker;
    }
  }

  return bestSpeaker;
}

/**
 * Light merge: only merge adjacent same-speaker segments with small gaps.
 * Skips aggressive short-segment removal and spurious-speaker reassignment.
 * Useful when the upstream diarizer already does its own post-processing.
 */
function mergeAdjacentSameSpeaker(segments: DiarSegment[], mergeGap: number): DiarSegment[] {
  if (segments.length === 0) return [];
  const sorted = [...segments].sort((a, b) => a.start - b.start);
  const merged: DiarSegment[] = [{ ...sorted[0] }];
  for (let i = 1; i < sorted.length; i++) {
    const prev = merged[merged.length - 1];
    const curr = sorted[i];
    if (prev.speaker === curr.speaker && (curr.start - prev.end) < mergeGap) {
      merged[merged.length - 1] = { ...prev, end: curr.end };
    } else {
      merged.push({ ...curr });
    }
  }
  return merged;
}

/**
 * Post-process raw diarization segments to clean up noise, merge fragments,
 * and remove spurious speakers.
 */
export function postProcessDiarization(
  segments: DiarSegment[],
  options?: PostProcessOptions,
): DiarSegment[] {
  if (segments.length === 0) return [];

  // Light mode: only merge adjacent same-speaker segments, skip aggressive filtering
  if (options?.light) {
    return mergeAdjacentSameSpeaker(segments, options?.mergeGap ?? 0.3);
  }

  const opts = { ...DEFAULT_OPTIONS, ...options };

  // --- Step 1: Remove short segments (absorb into previous) ---
  const afterShortRemoval: DiarSegment[] = [];

  for (const seg of segments) {
    const duration = seg.end - seg.start;

    if (duration < opts.minSegmentDuration) {
      // Absorb into previous segment by extending its end time
      if (afterShortRemoval.length > 0) {
        afterShortRemoval[afterShortRemoval.length - 1].end = Math.max(
          afterShortRemoval[afterShortRemoval.length - 1].end,
          seg.end,
        );
      }
      // If no previous segment exists, simply drop it
      continue;
    }

    afterShortRemoval.push({ ...seg });
  }

  // --- Step 2: Merge adjacent same-speaker segments ---
  const afterMerge = mergeSameSpeaker(afterShortRemoval, opts.mergeGap);

  // --- Step 3: Remove spurious speakers ---
  // Calculate total duration per speaker
  const speakerDurations = new Map<string, number>();
  for (const seg of afterMerge) {
    const dur = seg.end - seg.start;
    speakerDurations.set(seg.speaker, (speakerDurations.get(seg.speaker) || 0) + dur);
  }

  const validSpeakers = new Set<string>();
  for (const [speaker, totalDur] of speakerDurations) {
    if (totalDur >= opts.minSpeakerDuration) {
      validSpeakers.add(speaker);
    }
  }

  // If all speakers are spurious, return what we have (don't delete everything)
  if (validSpeakers.size === 0) {
    return afterMerge;
  }

  // Reassign spurious speaker segments to nearest valid speaker
  const afterReassign: DiarSegment[] = afterMerge.map((seg) => {
    if (validSpeakers.has(seg.speaker)) return { ...seg };

    const nearest = findNearestSpeaker(seg, afterMerge, validSpeakers);
    return { ...seg, speaker: nearest || seg.speaker };
  });

  // --- Step 4: Final merge pass ---
  return mergeSameSpeaker(afterReassign, opts.mergeGap);
}
