import type { RecordingRow } from '../hooks/useApi';

/**
 * Derive a display title for a recording. Used by every UI surface that
 * lists recordings (Dashboard, Transcripts, Library, Search results) so
 * the same row never shows two different labels across pages.
 *
 * Priority:
 *   1. User-set custom_title
 *   2. Document source filename (documents keep file identity by default)
 *   3. AI meeting-notes title (full LLM analysis — only for "real" meetings)
 *   4. AI auto_title (lightweight whole-transcript summary — covers
 *      dictation/notes/short audio that don't trigger meeting-notes)
 *   5. AI discussionSummary truncated (meeting-notes summary as fallback)
 *   6. First transcript segment truncated (pre-LLM fallback)
 *   7. file_name without extension (last resort)
 */
export function deriveRecordingTitle(rec: RecordingRow, maxLen = 40): string {
  const custom = rec.custom_title?.trim();
  if (custom) return custom;

  const fileBaseName = rec.file_name.replace(/\.[^.]+$/, '');
  if (['pdf', 'docx', 'text'].includes(rec.media_type || '')) {
    return fileBaseName;
  }

  let aiTitle: string | null = null;
  let aiSummary: string | null = null;
  if (rec.meeting_notes_json) {
    try {
      const notes = JSON.parse(rec.meeting_notes_json) as {
        title?: string;
        discussionSummary?: string;
      };
      aiTitle = notes.title?.trim() || null;
      aiSummary = notes.discussionSummary?.trim() || null;
    } catch {
      /* malformed JSON — fall through */
    }
  }
  if (aiTitle) return aiTitle;

  const auto = rec.auto_title?.trim();
  if (auto) return auto;

  const truncate = (s: string): string =>
    s.length > maxLen ? s.slice(0, maxLen) + '…' : s;

  if (aiSummary) return truncate(aiSummary);

  const firstSeg = rec.first_segment_text?.trim();
  if (firstSeg) return truncate(firstSeg);

  return fileBaseName;
}
