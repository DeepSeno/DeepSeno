export interface Source {
  id: string;
  segmentId: number;
  recordingId?: number;
  time: string;
  speaker: string;
  text: string;
}

export interface ChatMessage {
  id: string;
  /** Database row id — set once a message has been persisted. Used for delete. */
  dbId?: number;
  role: 'system' | 'user' | 'assistant';
  content: string;
  sources?: Source[];
  streaming?: boolean;
}

export interface Session {
  id: number;
  title: string;
  created_at: string;
  updated_at: string;
}

export interface UnifiedSession {
  id: number;
  title: string;
  updatedAt: string;
  type: 'local' | 'channel';
  channelId?: string;
  channelLabel?: string;
  readOnly?: boolean;
}

export function nextMsgId() {
  return Date.now().toString(36) + Math.random().toString(36);
}

export const SOURCES_PREVIEW_COUNT = 3;

// SQLite CURRENT_TIMESTAMP yields "YYYY-MM-DD HH:MM:SS" in UTC with no tz suffix.
// V8 parses that shape as local time, not UTC — append 'Z' so Date() reads it correctly.
export function parseDbTime(s: string): number {
  if (!s) return NaN;
  if (s.includes('T') || /[Zz]|[+-]\d{2}:?\d{2}$/.test(s)) return new Date(s).getTime();
  return new Date(s.replace(' ', 'T') + 'Z').getTime();
}

function localDateKey(ts: number): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function relativeTime(
  dateStr: string,
  labels: { just_now: string; minutes_ago: string; hours_ago: string; days_ago: string },
  locale: string
): string {
  const now = Date.now();
  const then = parseDbTime(dateStr);
  const diffMin = Math.max(0, Math.floor((now - then) / 60000));
  if (diffMin < 1) return labels.just_now;
  if (diffMin < 60) return `${diffMin}${labels.minutes_ago}`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `${diffH}${labels.hours_ago}`;
  const diffD = Math.floor(diffH / 24);
  if (diffD < 7) return `${diffD}${labels.days_ago}`;
  return new Date(then).toLocaleDateString(locale, { month: '2-digit', day: '2-digit' });
}

function groupByTime<T>(items: T[], getTime: (item: T) => string): { today: T[]; week: T[]; earlier: T[] } {
  const nowTs = Date.now();
  const todayKey = localDateKey(nowTs);
  const weekAgoTs = nowTs - 7 * 86400000;

  const today: T[] = [];
  const week: T[] = [];
  const earlier: T[] = [];

  for (const item of items) {
    const ts = parseDbTime(getTime(item));
    if (Number.isNaN(ts)) { earlier.push(item); continue; }
    if (localDateKey(ts) === todayKey) today.push(item);
    else if (ts >= weekAgoTs) week.push(item);
    else earlier.push(item);
  }
  return { today, week, earlier };
}

export function groupSessions(sessions: Session[]): { today: Session[]; week: Session[]; earlier: Session[] } {
  return groupByTime(sessions, s => s.updated_at);
}

export function groupUnifiedSessions(sessions: UnifiedSession[]): { today: UnifiedSession[]; week: UnifiedSession[]; earlier: UnifiedSession[] } {
  return groupByTime(sessions, s => s.updatedAt);
}
