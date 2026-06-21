// ─── Dashboard shared types & helpers ─────────────────────

export type MediaType = 'audio' | 'video' | 'pdf' | 'docx' | 'text' | 'image';

export interface TimelineItem {
  date: string; // YYYY-MM-DD for grouping
  time: string;
  event: string;
  type: 'major' | 'minor';
  mediaType?: MediaType;
  duration?: string;
  durationSeconds?: number;
  speakers?: number;
  recordingId: number;
}

export interface ChartData {
  recordingsPerDay: { date: string; count: number }[];
  sentimentDistribution: { sentiment: string; count: number }[];
  topSpeakers: { id: number; name: string; count: number; duration: number }[];
  calendarActivity: { date: string; count: number }[];
}

// ─── Helpers (pure, outside component) ───────────────────────

export function formatDuration(seconds: number): string {
  if (seconds >= 60) return `${Math.floor(seconds / 60)}min`;
  return `${Math.floor(seconds)}s`;
}

export function formatHoursMinutes(totalSec: number): string {
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export function toLocalDateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
