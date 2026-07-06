import { FileAudio, MessageSquare, Users, Sparkles, ListChecks, Database, FileText, Image, Video } from 'lucide-react';

export interface QueueItem {
  id: string;
  name: string;
  filePath: string;
  duration: string;
  size: string;
  progress: number;
  status: string;
  rawStatus: string;
  currentStep: number;
  error: string | null;
  notes: string | null;
  mediaType?: string;
}

export const STATUS_TO_STEP: Record<string, number> = {
  pending: -1,
  preprocessing: 0,
  vad: 1,
  transcribing: 2,
  diarizing: 3,
  optimizing: 4,
  extracting: 5,
  indexing: 6,
  completed: 6,
  failed: -1,
  cancelled: -1,
  interrupted: -1,
};

export const PIPELINE_STEPS = [
  { key: 'preprocessing', icon: FileAudio, label: 'FORMAT' },
  { key: 'transcribing', icon: MessageSquare, label: 'ASR' },
  { key: 'diarizing', icon: Users, label: 'DIAR' },
  { key: 'optimizing', icon: Sparkles, label: 'OPT' },
  { key: 'extracting', icon: ListChecks, label: 'EXTRACT' },
  { key: 'indexing', icon: Database, label: 'INDEX' },
  { key: 'generating notes', icon: FileText, label: 'MD' },
] as const;

/** Simplified pipeline steps for document processing (PDF/DOCX/TXT) */
export const DOC_PIPELINE_STEPS = [
  { key: 'preprocessing', icon: FileAudio, label: 'READ' },
  { key: 'optimizing', icon: Sparkles, label: 'OPT' },
  { key: 'extracting', icon: ListChecks, label: 'EXTRACT' },
  { key: 'indexing', icon: Database, label: 'INDEX' },
  { key: 'generating notes', icon: FileText, label: 'MD' },
] as const;

/** Simplified pipeline steps for image processing */
export const IMAGE_PIPELINE_STEPS = [
  { key: 'preprocessing', icon: Image, label: 'PREP' },
  { key: 'transcribing', icon: Sparkles, label: 'VISION' },
  { key: 'extracting', icon: ListChecks, label: 'EXTRACT' },
  { key: 'indexing', icon: Database, label: 'INDEX' },
  { key: 'generating notes', icon: FileText, label: 'MD' },
] as const;

/** Pipeline steps for video processing (keyframes + audio) */
export const VIDEO_PIPELINE_STEPS = [
  { key: 'preprocessing', icon: Video, label: 'PREP' },
  { key: 'transcribing', icon: Sparkles, label: 'VISION' },
  { key: 'diarizing', icon: MessageSquare, label: 'ASR' },
  { key: 'optimizing', icon: Sparkles, label: 'OPT' },
  { key: 'extracting', icon: ListChecks, label: 'EXTRACT' },
  { key: 'indexing', icon: Database, label: 'INDEX' },
  { key: 'generating notes', icon: FileText, label: 'MD' },
] as const;

const DOC_MEDIA_TYPES = new Set(['pdf', 'docx', 'text']);

export function getStepsForMediaType(mediaType?: string) {
  if (mediaType === 'image') return IMAGE_PIPELINE_STEPS;
  if (mediaType === 'video') return VIDEO_PIPELINE_STEPS;
  if (DOC_MEDIA_TYPES.has(mediaType || '')) return DOC_PIPELINE_STEPS;
  return PIPELINE_STEPS;
}

export interface HistoryItem {
  id: string;
  recordingId: number;
  name: string;
  date: string;
  duration: string;
  size: string;
  speakers: number;
  extracted: number;
  status: string;
  tags: string[];
  scene: string;
  mediaType: string;
  pageCount?: number;
  wordCount?: number;
  statusUpdatedAt?: string | null;
}

function historyItemStatusTime(item: Pick<HistoryItem, 'statusUpdatedAt'>): number {
  const value = item.statusUpdatedAt ? Date.parse(item.statusUpdatedAt) : NaN;
  return Number.isFinite(value) ? value : 0;
}

export function sortHistoryItemsForDisplay<T extends Pick<HistoryItem, 'recordingId' | 'statusUpdatedAt'>>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    const statusTimeDiff = historyItemStatusTime(b) - historyItemStatusTime(a);
    if (statusTimeDiff !== 0) return statusTimeDiff;
    return b.recordingId - a.recordingId;
  });
}

export interface TextNoteItem {
  id: string;
  noteId: number;
  content: string;
  fullContent: string;
  agentReply: string | null;
  date: string;
  channelId: string;
}

export const SCENE_BADGE: Record<string, { label: string; className: string }> = {
  dictation:      { label: '\u53E3\u8FF0',     className: 'bg-zinc-100 text-zinc-500 border-zinc-200' },
  local_meeting:  { label: '\u73B0\u573A\u4F1A\u8BAE', className: 'bg-zinc-200 text-zinc-600 border-zinc-300' },
  online_meeting: { label: '\u7EBF\u4E0A\u4F1A\u8BAE', className: 'bg-zinc-200 text-zinc-600 border-zinc-300' },
  media:          { label: '\u5A92\u4F53',     className: 'bg-zinc-800 text-zinc-300 border-zinc-700' },
};

export const MEDIA_TYPE_BADGE: Record<string, { label: string; zhLabel: string; className: string }> = {
  audio: { label: 'Audio', zhLabel: '\u97F3\u9891', className: 'bg-zinc-100 text-zinc-500 border-zinc-200' },
  video: { label: 'Video', zhLabel: '\u89C6\u9891', className: 'bg-violet-50 text-violet-600 border-violet-200' },
  pdf:   { label: 'PDF',   zhLabel: 'PDF',    className: 'bg-red-50 text-red-600 border-red-200' },
  docx:  { label: 'Word',  zhLabel: 'Word',   className: 'bg-blue-50 text-blue-600 border-blue-200' },
  text:  { label: 'Text',  zhLabel: '\u6587\u672C', className: 'bg-neutral-100 text-neutral-600 border-neutral-200' },
  image: { label: 'Image', zhLabel: '\u56FE\u7247', className: 'bg-amber-50 text-amber-600 border-amber-200' },
};
