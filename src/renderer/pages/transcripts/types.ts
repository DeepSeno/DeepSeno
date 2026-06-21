import { Check, Zap, Calendar, User } from 'lucide-react';

export type ContentCategory = 'note' | 'meeting' | 'document' | 'media';

export function classifyContent(durationSeconds: number, speakers: number, mediaType?: string): ContentCategory {
  if (['pdf', 'docx', 'text'].includes(mediaType || '')) return 'document';
  if (['image', 'video'].includes(mediaType || '')) return 'media';
  if (durationSeconds <= 120 && speakers <= 1) return 'note';
  return 'meeting';
}

export interface Conversation {
  id: string;
  recordingId: number;
  time: string;
  title: string;
  duration: string;
  durationSeconds: number;
  speakers: number;
  date: string;
  actualDate: string; // YYYY-MM-DD for date filtering
  recordedAt: string | null; // ISO 8601 for wall-clock calculation
  mediaType?: string; // 'audio' | 'video' | 'pdf' | 'docx' | 'text' | 'image'
  category: ContentCategory;
  pageCount?: number;
  wordCount?: number;
}

export interface Message {
  segmentId: number;
  speaker: string;
  time: string;
  wallClockTime: string;
  startTime: number;
  endTime: number;
  raw: string;
  clean: string;
  self: boolean;
  sentiment?: string;
  bookmarked: boolean;
}

export interface ExtractedItem {
  type: string;
  content: string;
  deadline: string | null;
}

export interface SearchResult {
  id: number;
  recordingId: number;
  recordingName: string;
  speakerName: string;
  text: string;
  time: string;
}

export interface LiveSegment {
  index: number;
  text: string;
  start: number;
  end: number;
}

export const SENTIMENT_COLORS: Record<string, string> = {
  positive: 'bg-emerald-50 border-emerald-200 text-emerald-700',
  negative: 'bg-red-50 border-red-200 text-red-700',
  neutral: 'bg-neutral-50 border-neutral-200 text-neutral-500',
  excited: 'bg-amber-50 border-amber-200 text-amber-700',
  frustrated: 'bg-orange-50 border-orange-200 text-orange-700',
  concerned: 'bg-blue-50 border-blue-200 text-blue-700',
  confident: 'bg-violet-50 border-violet-200 text-violet-700',
};

export const ITEM_TYPE_CONFIG: Record<string, { icon: typeof Check; color: string }> = {
  todo: { icon: Check, color: 'bg-amber-50 border-amber-200 text-amber-700' },
  decision: { icon: Zap, color: 'bg-blue-50 border-blue-200 text-blue-700' },
  meeting: { icon: Calendar, color: 'bg-violet-50 border-violet-200 text-violet-700' },
  contact: { icon: User, color: 'bg-emerald-50 border-emerald-200 text-emerald-700' },
};

export const SPEED_OPTIONS = [
  { label: '0.5x', value: 0.5 },
  { label: '1x', value: 1 },
  { label: '1.5x', value: 1.5 },
  { label: '2x', value: 2 },
];
