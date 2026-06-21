import type { VoiceBrainDB } from '../db/database';
import type { TextOptimizer } from '../llm/text-optimizer';

const SESSION_WINDOW_MINUTES = 10;
const SESSION_MEDIA_TYPES = new Set(['audio', 'video']);

export interface AssembleSessionInput {
  recordingId: number;
  transcript: string;
  durationSec: number;
  captureScene: string;
  date: string;        // YYYY-MM-DD (local)
  recordedAt: string;  // ISO timestamp
  mediaType?: string;  // defaults to 'audio'
}

/**
 * Decide whether a newly-completed recording joins an active session or
 * starts a new one. Called from Processor Step 7.6 (and from backfill).
 *
 * Behavior:
 *   - Non-audio/video recordings are standalone (no session at all — photos
 *     and documents are first-class events on their own merit).
 *   - Look up an unfinalized session on the same day + capture_scene within
 *     SESSION_WINDOW_MINUTES of last activity.
 *   - If a candidate exists and LLM declares the topic coherent → join +
 *     update session topic/summary.
 *   - If candidate exists but LLM rejects coherence → finalize the old
 *     session and start a new one for this recording.
 *   - If no candidate → create a fresh single-member session (will accept
 *     more members within the window).
 */
export async function assembleSession(
  db: VoiceBrainDB,
  optimizer: TextOptimizer,
  input: AssembleSessionInput,
): Promise<void> {
  const mediaType = input.mediaType || 'audio';
  if (!SESSION_MEDIA_TYPES.has(mediaType)) return;

  const active = db.findActiveCaptureSession({
    date: input.date,
    captureScene: input.captureScene,
    windowMinutes: SESSION_WINDOW_MINUTES,
  });

  if (!active) {
    const sid = db.createCaptureSession({
      date: input.date,
      started_at: input.recordedAt,
      ended_at: input.recordedAt,
    });
    db.addRecordingToCaptureSession(input.recordingId, sid, input.recordedAt);
    return;
  }

  // Candidate exists — verify topic coherence with existing members + new.
  const existingMembers = db.getCaptureSessionMembers(active.id);
  const allMemberTexts = [
    ...existingMembers.map((m) => ({
      transcript: db.getRecordingTranscriptText(m.id),
      durationSec: m.duration_seconds || 0,
    })),
    { transcript: input.transcript, durationSec: input.durationSec },
  ];

  const { topic, summary, isCoherent } = await optimizer.detectSessionTopic(allMemberTexts);

  if (isCoherent) {
    db.addRecordingToCaptureSession(input.recordingId, active.id, input.recordedAt);
    if (topic || summary) {
      db.updateCaptureSession(active.id, { topic, summary });
    }
  } else {
    db.updateCaptureSession(active.id, { is_finalized: 1 });
    const sid = db.createCaptureSession({
      date: input.date,
      started_at: input.recordedAt,
      ended_at: input.recordedAt,
    });
    db.addRecordingToCaptureSession(input.recordingId, sid, input.recordedAt);
  }
}
