import { useState, useEffect, useRef, useCallback, useLayoutEffect, useMemo } from 'react';
import { Menu, PanelRightOpen, Mic } from 'lucide-react';
import { useI18n } from '../i18n';
import { useApi, RecordingRow, SegmentRow, ExtractedItemRow } from '../hooks/useApi';
import type { MeetingNotes } from '../hooks/useApi';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { useNotifications } from '../components/NotificationCenter';
import ConversationList from './transcripts/ConversationList';
import TranscriptHeader from './transcripts/TranscriptHeader';
import TranscriptContent from './transcripts/TranscriptContent';
import AudioPlayer from './transcripts/AudioPlayer';
import ExtractedPanel from './transcripts/ExtractedPanel';
import LoadingSkeleton from './transcripts/LoadingSkeleton';
import SummaryQAPanel from './transcripts/SummaryQAPanel';
import type { Conversation, Message, ExtractedItem, SearchResult, LiveSegment } from './transcripts/types';
import { classifyContent } from './transcripts/types';
import { getLibraryListDateMeta } from './transcripts/listDate';
import { deriveRecordingTitle } from '../utils/recordingTitle';

const LEFT_PANEL_STORAGE_KEY = 'deepseno-transcripts-left-panel-width';
const RIGHT_PANEL_STORAGE_KEY = 'deepseno-transcripts-right-panel-width';
const LEFT_PANEL_MIN = 240;
const LEFT_PANEL_MAX = 420;
const RIGHT_PANEL_MIN = 300;
const RIGHT_PANEL_MAX = 560;
const CENTER_PANEL_MIN = 420;

function readStoredPanelWidth(key: string, fallback: number): number {
  try {
    const raw = localStorage.getItem(key);
    const value = raw ? Number(raw) : NaN;
    return Number.isFinite(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export default function Transcripts() {
  const { t, lang } = useI18n();
  const api = useApi();
  const { toast } = useNotifications();
  const tr = t.trans;
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const dateFilter = searchParams.get('date');

  // Core state
  const [selectedConv, setSelectedConv] = useState(0);
  const [textMode, setTextMode] = useState<'raw' | 'clean'>('clean');
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [extractedItems, setExtractedItems] = useState<ExtractedItem[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [loading, setLoading] = useState(true);
  const [meetingNotes, setMeetingNotes] = useState<MeetingNotes | null>(null);
  const [isRegenerating, setIsRegenerating] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [highlightedSegment, setHighlightedSegment] = useState<number | null>(null);
  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  const [leftPanelWidth, setLeftPanelWidth] = useState(() => readStoredPanelWidth(LEFT_PANEL_STORAGE_KEY, 300));
  const [rightPanelWidth, setRightPanelWidth] = useState(() => readStoredPanelWidth(RIGHT_PANEL_STORAGE_KEY, 380));
  const leftDragging = useRef(false);
  const rightDragging = useRef(false);

  // Live mode state
  const [liveRecordingId, setLiveRecordingId] = useState<number | null>(null);
  const [liveSegments, setLiveSegments] = useState<LiveSegment[]>([]);
  const [liveStatus, setLiveStatus] = useState<'idle' | 'recording' | 'post_processing'>('idle');
  const [liveSelected, setLiveSelected] = useState(false);
  const liveEndRef = useRef<HTMLDivElement>(null);
  const liveRecordingIdRef = useRef<number | null>(null);

  // Audio/video player state
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const activeMediaRef = useRef<HTMLMediaElement | null>(null);
  const progressRef = useRef<HTMLDivElement>(null);
  const mediaLoadSeqRef = useRef(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playbackSpeed, setPlaybackSpeed] = useState(1);
  const [audioLoaded, setAudioLoaded] = useState(false);
  const [audioError, setAudioError] = useState(false);

  // Responsive layout state
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(1200);
  const [showSidebar, setShowSidebar] = useState(false);
  const [showExtracted, setShowExtracted] = useState(false);
  const [showTranscript, setShowTranscript] = useState(true);
  const isCompact = containerWidth < 1024;
  const isMobile = containerWidth < 768;
  const showSideQAPanel = showTranscript && !isMobile && containerWidth >= 1100;

  // --- Effects ---

  useEffect(() => {
    if (!containerRef.current) return;
    const ro = new ResizeObserver(([entry]) => setContainerWidth(entry.contentRect.width));
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, []);

  const getCurrentContainerWidth = useCallback(() => (
    containerRef.current?.getBoundingClientRect().width || containerWidth
  ), [containerWidth]);

  const getMaxLeftPanelWidth = useCallback((rightWidth = rightPanelWidth) => {
    const width = getCurrentContainerWidth();
    const rightReserve = showSideQAPanel ? rightWidth + 12 : 0;
    return Math.max(
      LEFT_PANEL_MIN,
      Math.min(LEFT_PANEL_MAX, width - CENTER_PANEL_MIN - rightReserve - 12),
    );
  }, [getCurrentContainerWidth, rightPanelWidth, showSideQAPanel]);

  const getMaxRightPanelWidth = useCallback((leftWidth = leftPanelWidth) => {
    const width = getCurrentContainerWidth();
    return Math.max(
      RIGHT_PANEL_MIN,
      Math.min(RIGHT_PANEL_MAX, width - leftWidth - CENTER_PANEL_MIN - 24),
    );
  }, [getCurrentContainerWidth, leftPanelWidth]);

  useLayoutEffect(() => {
    if (isMobile) return;
    setLeftPanelWidth((width) => clamp(width, LEFT_PANEL_MIN, getMaxLeftPanelWidth()));
    if (showSideQAPanel) {
      setRightPanelWidth((width) => clamp(width, RIGHT_PANEL_MIN, getMaxRightPanelWidth()));
    }
  }, [containerWidth, getMaxLeftPanelWidth, getMaxRightPanelWidth, isMobile, showSideQAPanel]);

  useEffect(() => {
    try { localStorage.setItem(LEFT_PANEL_STORAGE_KEY, String(leftPanelWidth)); } catch {}
  }, [leftPanelWidth]);

  useEffect(() => {
    try { localStorage.setItem(RIGHT_PANEL_STORAGE_KEY, String(rightPanelWidth)); } catch {}
  }, [rightPanelWidth]);

  const attachMediaListeners = useCallback((el: HTMLMediaElement): (() => void) => {
    // Guard: ignore events from inactive media elements to prevent race conditions
    // (e.g. clearing audio.src fires error after switching to video)
    const isActive = () => activeMediaRef.current === el;
    const onTimeUpdate = () => { if (isActive()) setCurrentTime(el.currentTime); };
    const onLoadedMetadata = () => { if (isActive()) { if (isFinite(el.duration)) setDuration(el.duration); setAudioLoaded(true); setAudioError(false); } };
    const onEnded = () => { if (isActive()) setIsPlaying(false); };
    const onPlay = () => { if (isActive()) setIsPlaying(true); };
    const onPause = () => { if (isActive()) setIsPlaying(false); };
    const onError = () => { if (isActive()) { setAudioError(true); setAudioLoaded(false); } };
    el.addEventListener('timeupdate', onTimeUpdate);
    el.addEventListener('loadedmetadata', onLoadedMetadata);
    el.addEventListener('ended', onEnded);
    el.addEventListener('play', onPlay);
    el.addEventListener('pause', onPause);
    el.addEventListener('error', onError);
    return () => {
      el.removeEventListener('timeupdate', onTimeUpdate);
      el.removeEventListener('loadedmetadata', onLoadedMetadata);
      el.removeEventListener('ended', onEnded);
      el.removeEventListener('play', onPlay);
      el.removeEventListener('pause', onPause);
      el.removeEventListener('error', onError);
    };
  }, []);

  useEffect(() => {
    const audio = new Audio();
    audioRef.current = audio;
    activeMediaRef.current = audio;
    const detach = attachMediaListeners(audio);
    return () => {
      detach();
      audio.pause();
      audio.src = '';
    };
  }, [attachMediaListeners]);

  // Attach listeners to video element when it mounts
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    return attachMediaListeners(video);
  }, [attachMediaListeners]);

  useEffect(() => { liveRecordingIdRef.current = liveRecordingId; }, [liveRecordingId]);

  const resolveVideoMediaUrl = useCallback(async (recordingId: number): Promise<string> => {
    try {
      let status = await api.lanServerGetStatus();
      if (!status.running) {
        const started = await api.lanServerStart();
        if (started.success) status = { ...status, ...started, running: true };
      }
      if (status.running && status.port && status.token) {
        const token = encodeURIComponent(status.token);
        return `http://127.0.0.1:${status.port}/api/recordings/${recordingId}/media?token=${token}`;
      }
    } catch (err) {
      console.warn('[Transcripts] LAN video media URL fallback:', err);
    }
    return `media://audio/${recordingId}`;
  }, [api]);

  const handleLeftDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    leftDragging.current = true;
    const startX = e.clientX;
    const startWidth = leftPanelWidth;
    const onMove = (ev: MouseEvent) => {
      if (!leftDragging.current) return;
      const delta = ev.clientX - startX;
      setLeftPanelWidth(clamp(startWidth + delta, LEFT_PANEL_MIN, getMaxLeftPanelWidth()));
    };
    const onUp = () => { leftDragging.current = false; document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); document.body.style.cursor = ''; document.body.style.userSelect = ''; };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, [getMaxLeftPanelWidth, leftPanelWidth]);

  const handleRightDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    rightDragging.current = true;
    const startX = e.clientX;
    const startWidth = rightPanelWidth;
    const onMove = (ev: MouseEvent) => {
      if (!rightDragging.current) return;
      const delta = startX - ev.clientX;
      setRightPanelWidth(clamp(startWidth + delta, RIGHT_PANEL_MIN, getMaxRightPanelWidth()));
    };
    const onUp = () => { rightDragging.current = false; document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); document.body.style.cursor = ''; document.body.style.userSelect = ''; };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, [getMaxRightPanelWidth, rightPanelWidth]);

  const loadRecordingData = useCallback(async (recordingId: number, durationSec?: number, recordedAt?: string | null, mediaType?: string) => {
    const loadSeq = ++mediaLoadSeqRef.current;
    const isDoc = ['pdf', 'docx', 'text', 'image'].includes(mediaType || '');
    try {
      const segments = await api.getSegmentsByRecording(recordingId);
      setMessages(segments.length > 0
        ? segments.map((seg: SegmentRow, idx: number) => {
            let wallClockTime = '';
            if (!isDoc && recordedAt) {
              const base = new Date(recordedAt);
              if (!isNaN(base.getTime())) {
                const wall = new Date(base.getTime() + (seg.start_time || 0) * 1000);
                wallClockTime = wall.toLocaleString(lang === 'zh' ? 'zh-CN' : 'en-US', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
              }
            }
            return {
              segmentId: seg.id,
              speaker: isDoc ? `§${idx + 1}` : (seg.speaker_name || tr.speaker_label),
              time: isDoc ? '' : formatSeconds(seg.start_time || 0),
              wallClockTime,
              startTime: seg.start_time || 0,
              endTime: seg.end_time || 0,
              raw: seg.raw_text || '',
              clean: seg.clean_text || '',
              self: false,
              sentiment: isDoc ? undefined : (seg.sentiment || undefined),
              bookmarked: !!seg.bookmarked,
            };
          })
        : []);
      const items = await api.getExtractedItems({ recordingId });
      setExtractedItems(items.length > 0 ? items.map((item: ExtractedItemRow) => ({ type: item.type, content: item.content, deadline: item.due_date || null })) : []);
      try { const notes = await api.getMeetingNotes(recordingId); setMeetingNotes(notes); } catch { setMeetingNotes(null); }
      const audio = audioRef.current;
      const video = videoRef.current;
      if (!isDoc && mediaType === 'video') {
        // Video mode: set active ref FIRST so stale audio events are ignored
        const vid = video || videoRef.current;
        if (vid) {
          activeMediaRef.current = vid;
          if (audio) { audio.pause(); audio.src = ''; }
          setIsPlaying(false); setCurrentTime(0); setDuration(durationSec && durationSec > 0 ? durationSec : 0); setAudioLoaded(false); setAudioError(false);
          const src = await resolveVideoMediaUrl(recordingId);
          if (loadSeq !== mediaLoadSeqRef.current || activeMediaRef.current !== vid) return;
          vid.src = src;
          vid.load();
        } else {
          // Video ref not yet mounted — retry after next render
          setTimeout(() => {
            const v = videoRef.current;
            if (v) {
              activeMediaRef.current = v;
              if (audio) { audio.pause(); audio.src = ''; }
              void resolveVideoMediaUrl(recordingId).then((src) => {
                if (loadSeq !== mediaLoadSeqRef.current || activeMediaRef.current !== v) return;
                v.src = src;
                v.load();
                setDuration(durationSec && durationSec > 0 ? durationSec : 0);
              });
            }
          }, 100);
        }
      } else if (audio && !isDoc) {
        // Audio mode: set active ref FIRST so stale video events are ignored
        activeMediaRef.current = audio;
        if (video) { video.pause(); video.removeAttribute('src'); video.load(); }
        audio.pause(); setIsPlaying(false); setCurrentTime(0); setDuration(durationSec && durationSec > 0 ? durationSec : 0); setAudioLoaded(false); setAudioError(false);
        audio.src = `media://audio/${recordingId}`;
        audio.load();
      } else if (isDoc) {
        activeMediaRef.current = null;
        if (audio) { audio.pause(); audio.src = ''; }
        if (video) { video.pause(); video.removeAttribute('src'); video.load(); }
        setIsPlaying(false); setAudioLoaded(false); setAudioError(false); setCurrentTime(0); setDuration(0);
        activeMediaRef.current = null;
      }
    } catch (err) { console.error('[Transcripts]', err); }
  }, [api, lang, resolveVideoMediaUrl, tr.speaker_label]);

  const loadConversations = useCallback(async () => {
    try {
      const recordings = (await api.getRecordings()).filter((rec: RecordingRow) => rec.status === 'completed');
      if (recordings.length > 0) {
        const now = new Date();
        const locale = lang === 'zh' ? 'zh-CN' : 'en-US';
        const convs = recordings.map((rec: RecordingRow) => {
          const dateMeta = getLibraryListDateMeta(rec, locale, now);
          const dur = rec.duration_seconds || 0;
          const spk = rec.speaker_count || 0;
          const mt = rec.media_type || undefined;
          const autoCategory = classifyContent(dur, spk, mt);
          return { id: `CONV-${String(rec.id).padStart(3, '0')}`, recordingId: rec.id, time: dateMeta.time, title: deriveRecordingTitle(rec), duration: dur ? formatDuration(dur) : '', durationSeconds: dur, speakers: spk, date: dateMeta.dateGroup, actualDate: dateMeta.actualDate, recordedAt: rec.recorded_at || null, mediaType: mt, category: (rec.custom_category as any) || autoCategory, pageCount: rec.page_count || undefined, wordCount: rec.word_count || undefined };
        });
        setConversations(convs);
        const recordingParam = searchParams.get('recording');
        if (recordingParam) {
          const recordingId = parseInt(recordingParam, 10);
          const idx = convs.findIndex((c: Conversation) => c.recordingId === recordingId);
          if (idx >= 0) { setSelectedConv(idx); await loadRecordingData(convs[idx].recordingId, convs[idx].durationSeconds, convs[idx].recordedAt, convs[idx].mediaType); setLoading(false); return; }
        }
        if (recordings[0]) await loadRecordingData(recordings[0].id, recordings[0].duration_seconds ?? undefined, recordings[0].recorded_at, recordings[0].media_type || undefined);
      } else {
        setConversations([]);
        setMessages([]);
        setExtractedItems([]);
        setMeetingNotes(null);
      }
    } catch (err) { console.error('[Transcripts]', err); }
    setLoading(false);
  }, [api, lang, searchParams, loadRecordingData]);

  useEffect(() => {
    api.realtimeStatus().then((status) => {
      if (status.recording && status.recordingId) {
        setLiveRecordingId(status.recordingId); setLiveStatus('recording'); setLiveSelected(true);
        api.getSegmentsByRecording(status.recordingId).then((segments) => {
          if (segments.length > 0) setLiveSegments(segments.map((seg: SegmentRow, i: number) => ({ index: i, text: seg.raw_text || '', start: seg.start_time || 0, end: seg.end_time || 0 })));
        });
      }
    }).catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const cleanups = [
      api.onLiveStarted((_evt, data) => { setLiveRecordingId(data.recordingId); setLiveSegments([]); setLiveStatus('recording'); setLiveSelected(true); }),
      api.onLiveSegment((_evt, data) => { setLiveSegments(prev => [...prev, { index: data.index, text: data.text, start: data.start, end: data.end }]); setTimeout(() => liveEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 50); }),
      api.onLiveStopped(() => { setLiveStatus('post_processing'); }),
      api.onLivePostComplete((_evt, data) => {
        setLiveStatus('idle'); const finishedId = liveRecordingIdRef.current; setLiveRecordingId(null); setLiveSegments([]); setLiveSelected(false);
        loadConversations().then(() => { const id = (data as any)?.recordingId || finishedId; if (id) setConversations(prev => { const idx = prev.findIndex(c => c.recordingId === id); if (idx >= 0) { setSelectedConv(idx); loadRecordingData(id, prev[idx].durationSeconds, prev[idx].recordedAt, prev[idx].mediaType); } return prev; }); });
      }),
      api.onLiveError((_evt, error) => { toast('error', tr.live_error, error); }),
    ];
    return () => cleanups.forEach(fn => fn());
  }, [loadConversations, loadRecordingData]);

  useEffect(() => { loadConversations(); }, [loadConversations]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key === 'k') { e.preventDefault(); searchInputRef.current?.focus(); } };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  useEffect(() => {
    const recordingParam = searchParams.get('recording');
    if (recordingParam && conversations.length > 0) {
      const recordingId = parseInt(recordingParam, 10);
      const idx = conversations.findIndex((c) => c.recordingId === recordingId);
      if (idx >= 0 && idx !== selectedConv) handleSelectConversation(idx);
    }
  }, [searchParams, conversations.length]);

  useEffect(() => {
    const segmentParam = searchParams.get('segment');
    if (segmentParam && messages.length > 0) {
      const segmentId = parseInt(segmentParam, 10);
      setHighlightedSegment(segmentId);
      requestAnimationFrame(() => { const el = document.getElementById(`segment-${segmentId}`); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' }); });
      const timer = setTimeout(() => setHighlightedSegment(null), 3000);
      return () => clearTimeout(timer);
    }
  }, [searchParams, messages.length]);

  useEffect(() => {
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    if (searchQuery.trim().length >= 2) {
      setIsSearching(true);
      searchTimerRef.current = setTimeout(async () => {
        try { const results = await api.searchSegments(searchQuery.trim()); setSearchResults(results.map((seg: SegmentRow) => ({ id: seg.id, recordingId: seg.recording_id, recordingName: seg.recording_name || '', speakerName: seg.speaker_name || tr.speaker_label, text: seg.clean_text || seg.raw_text || '', time: formatSeconds(seg.start_time || 0) }))); } catch { setSearchResults([]); }
        setIsSearching(false);
      }, 300);
    } else { setSearchResults([]); setIsSearching(false); }
    return () => { if (searchTimerRef.current) clearTimeout(searchTimerRef.current); };
  }, [searchQuery]);

  // --- Event handlers ---

  async function handleSelectConversation(idx: number) {
    setSelectedConv(idx); setLiveSelected(false);
    if (isMobile) setShowSidebar(false);
    const conv = conversations[idx];
    if (conv) {
      // Keep URL in sync so Dashboard ?recording=X re-navigations always
      // produce a distinct URL change (otherwise effects don't re-fire and
      // selection gets stuck on the previous sidebar click).
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        next.set('recording', String(conv.recordingId));
        return next;
      }, { replace: true });
      await loadRecordingData(conv.recordingId, conv.durationSeconds, conv.recordedAt, conv.mediaType);
    }
  }

  async function handleSearchResultClick(result: SearchResult) {
    const idx = conversations.findIndex((c) => c.recordingId === result.recordingId);
    if (idx >= 0) {
      await handleSelectConversation(idx); setSearchQuery(''); setHighlightedSegment(result.id);
      setTimeout(() => { const el = document.getElementById(`segment-${result.id}`); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' }); }, 100);
      setTimeout(() => setHighlightedSegment(null), 3000);
    }
  }

  const handleCopyText = useCallback(async () => {
    if (messages.length === 0) return;
    const conv = conversations[selectedConv];
    const lines = messages.map((msg) => `[${msg.time}] ${msg.speaker}: ${textMode === 'clean' ? msg.clean : msg.raw}`);
    const header = conv ? `# ${conv.title}\n\n` : '';
    try { await window.api.clipboardWriteText(header + lines.join('\n')); toast('success', tr.copy_done); } catch (err) { toast('error', String(err)); }
  }, [messages, conversations, selectedConv, textMode, toast, tr.copy_done]);

  const handleExport = useCallback(async () => {
    const conv = conversations[selectedConv]; if (!conv) return;
    try { const result = await api.exportTranscript(conv.recordingId); if (result.error) toast('error', t.export_btn, result.error); else if (result.filePath) toast('success', t.export_success, result.filePath); } catch (err) { toast('error', t.export_btn, String(err)); }
  }, [conversations, selectedConv, api, toast, t.export_btn, t.export_success]);

  async function handleRegenerateMeetingNotes() {
    const conv = conversations[selectedConv]; if (!conv) return;
    setIsRegenerating(true);
    try { const result = await api.regenerateMeetingNotes(conv.recordingId); if ('error' in result) toast('error', tr.regenerate_failed, result.error); else { setMeetingNotes(result); toast('success', tr.regenerate_success); } } catch (err) { toast('error', tr.regenerate_failed, String(err)); }
    setIsRegenerating(false);
  }

  function handleCopyMeetingNotesMarkdown() {
    if (!meetingNotes) return;
    const md = [`# ${meetingNotes.title}`, '', `## ${tr.mn_participants}`, ...meetingNotes.participants.map(p => `- ${p.name} (${Math.round(p.speakingTime / 60)}min)`), '', `## ${tr.mn_key_decisions}`, ...meetingNotes.decisions.map((d, i) => `${i + 1}. ${d}`), '', `## ${tr.mn_action_items}`, ...meetingNotes.actionItems.map(a => `- [ ] ${a.assignee}: ${a.task}${a.dueDate ? ` (due: ${a.dueDate})` : ''}`), '', `## ${tr.mn_discussion_summary}`, meetingNotes.discussionSummary, '', `## ${tr.mn_key_topics}`, meetingNotes.keyTopics.map(t => `\`${t}\``).join(' ')].join('\n');
    window.api.clipboardWriteText(md).then(() => toast('success', tr.copy_done));
  }

  async function handleToggleBookmark(segmentId: number) {
    const result = await api.toggleBookmark(segmentId);
    if (result.success) setMessages(prev => prev.map(m => m.segmentId === segmentId ? { ...m, bookmarked: !!result.bookmarked } : m));
  }

  async function handleEditSegment(segmentId: number, newText: string) {
    // Optimistically update local state
    setMessages(prev => prev.map(m =>
      m.segmentId === segmentId
        ? { ...m, clean: textMode === 'clean' ? newText : m.clean, raw: textMode === 'raw' ? newText : m.raw }
        : m
    ));
    try {
      const result = await api.updateSegmentText(segmentId, newText);
      if (!result.success) {
        console.error('[Transcripts] Failed to save segment text:', result.error);
        toast('error', 'Save failed', result.error);
      }
    } catch (err) {
      console.error('[Transcripts] Error saving segment text:', err);
    }
  }

  const togglePlayPause = useCallback(() => { const media = activeMediaRef.current; if (!media || !audioLoaded) return; if (media.paused) media.play().catch(() => {}); else media.pause(); }, [audioLoaded]);
  const handleSpeedChange = useCallback((speed: number) => { setPlaybackSpeed(speed); if (activeMediaRef.current) activeMediaRef.current.playbackRate = speed; }, []);
  const handleProgressClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => { const media = activeMediaRef.current; const bar = progressRef.current; if (!media || !bar || !audioLoaded) return; const rect = bar.getBoundingClientRect(); media.currentTime = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)) * media.duration; }, [audioLoaded]);
  const handleBubbleClick = useCallback((startTime: number) => { const media = activeMediaRef.current; if (!media || !audioLoaded) return; media.currentTime = Math.max(0, Math.min(startTime, media.duration || 0)); if (media.paused) media.play().catch(() => {}); }, [audioLoaded]);

  // --- Helpers ---

  function formatDuration(seconds: number): string {
    const h = Math.floor(seconds / 3600), m = Math.floor((seconds % 3600) / 60), s = Math.floor(seconds % 60);
    if (h > 0) return `${h}${t.duration_h} ${m}${t.duration_min}`;
    if (m > 0) return `${m}${t.duration_min} ${s}${t.duration_s}`;
    return `${s}${t.duration_s}`;
  }

  function formatSeconds(totalSec: number): string {
    const h = Math.floor(totalSec / 3600), m = Math.floor((totalSec % 3600) / 60), s = Math.floor(totalSec % 60);
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  // --- Derived state (memoized) ---

  const filteredConversations = useMemo(() => {
    let result = dateFilter ? conversations.filter((c) => c.actualDate === dateFilter) : conversations;
    if (categoryFilter !== 'all') result = result.filter((c) => c.category === categoryFilter);
    if (searchQuery.trim().length >= 1) result = result.filter((c) => c.title.toLowerCase().includes(searchQuery.trim().toLowerCase()));
    return result;
  }, [conversations, dateFilter, categoryFilter, searchQuery]);

  // Always show title-filtered conversation list; never switch to FTS-only mode
  const showSearchResults = searchQuery.trim().length >= 2 && searchResults.length > 0;

  // Build date groups — "today", "yesterday", then specific dates for earlier
  const dateGroups = useMemo(() => {
    const groups: { label: string; convs: Conversation[] }[] = [];
    const todayConvs = filteredConversations.filter((c) => c.date === 'today');
    const yesterdayConvs = filteredConversations.filter((c) => c.date === 'yesterday');
    if (todayConvs.length > 0) groups.push({ label: tr.today, convs: todayConvs });
    if (yesterdayConvs.length > 0) groups.push({ label: tr.yesterday, convs: yesterdayConvs });
    // Group "earlier" by actualDate
    const earlierConvs = filteredConversations.filter((c) => c.date === 'earlier');
    const earlierByDate = new Map<string, Conversation[]>();
    for (const c of earlierConvs) {
      const existing = earlierByDate.get(c.actualDate) || [];
      existing.push(c);
      earlierByDate.set(c.actualDate, existing);
    }
    // Sort dates descending and format
    for (const [dateStr, convs] of [...earlierByDate.entries()].sort((a, b) => b[0].localeCompare(a[0]))) {
      const d = new Date(dateStr + 'T00:00:00');
      const label = d.toLocaleDateString(lang === 'zh' ? 'zh-CN' : 'en-US', { month: 'short', day: 'numeric', weekday: 'short' });
      groups.push({ label, convs });
    }
    return groups;
  }, [filteredConversations, tr.today, tr.yesterday, lang]);

  const currentMediaType = conversations[selectedConv]?.mediaType || 'audio';
  const imageUrl = currentMediaType === 'image' && conversations[selectedConv]
    ? `media://image/${conversations[selectedConv].recordingId}`
    : null;

  // --- Delete recording (must be before early return to satisfy hooks rule) ---
  const handleDeleteRecording = useCallback(async (recordingId: number) => {
    try {
      await api.deleteRecording(recordingId);
      await loadConversations();
    } catch (err) {
      toast('error', tr.title, String(err));
    }
  }, [api, loadConversations, toast, tr.title]);

  // --- Rename recording ---
  const handleRenameRecording = useCallback(async (recordingId: number, newTitle: string) => {
    try {
      await api.updateRecordingTitle(recordingId, newTitle);
      setConversations(prev => prev.map(c => c.recordingId === recordingId ? { ...c, title: newTitle } : c));
    } catch (err) {
      toast('error', tr.title, String(err));
    }
  }, [api, toast, tr.title]);

  // --- Change recording category ---
  const handleChangeCategory = useCallback(async (recordingId: number, category: string | null) => {
    try {
      await api.updateRecordingCategory(recordingId, category);
      await loadConversations();
    } catch (err) {
      toast('error', tr.title, String(err));
    }
  }, [api, loadConversations, toast, tr.title]);

  // --- Category counts (computed from unfiltered conversations, memoized) ---
  const categoryCounts = useMemo(() => {
    const baseCounts = dateFilter ? conversations.filter((c) => c.actualDate === dateFilter) : conversations;
    return {
      all: baseCounts.length,
      note: baseCounts.filter((c) => c.category === 'note').length,
      meeting: baseCounts.filter((c) => c.category === 'meeting').length,
      document: baseCounts.filter((c) => c.category === 'document').length,
      media: baseCounts.filter((c) => c.category === 'media').length,
    };
  }, [conversations, dateFilter]);

  if (loading) return <LoadingSkeleton tr={tr} />;

  if (conversations.length === 0 && liveStatus === 'idle') {
    return (
      <div className="kz-empty" style={{ height: '100%' }}>
        <div className="kz-empty__icon"><Mic size={20} /></div>
        <div>
          <div className="kz-empty__title">{tr.empty_title}</div>
          <div className="kz-empty__sub" style={{ marginTop: 6 }}>{tr.empty_desc}</div>
        </div>
      </div>
    );
  }

  // --- Shared sidebar props ---
  const sidebarProps = {
    searchInputRef, searchQuery, onSearchChange: setSearchQuery, isSearching, showSearchResults, searchResults,
    onSearchResultClick: handleSearchResultClick, conversations, selectedConv, liveSelected, liveStatus, liveSegments,
    onSelectConversation: handleSelectConversation, onSelectLive: () => setLiveSelected(true), dateGroups, tr, lang,
    categoryFilter, onCategoryChange: setCategoryFilter, categoryCounts,
    onDeleteRecording: handleDeleteRecording,
    onRenameRecording: handleRenameRecording,
    onChangeCategory: handleChangeCategory,
  };

  return (
    <div ref={containerRef} className="h-full flex flex-col min-h-0">
      {/* Compact inline controls — only render when needed */}
      {(isMobile || dateFilter || (isCompact && extractedItems.length > 0)) && (
        <div className="flex items-center justify-between" style={{ marginBottom: 10, gap: 8 }}>
          <div className="flex items-center" style={{ gap: 8 }}>
            {isMobile && (
              <button onClick={() => setShowSidebar(!showSidebar)} className="kz-btn kz-btn--sm" title={tr.search}>
                <Menu size={14} />
              </button>
            )}
            {dateFilter && (
              <span className="kz-chip kz-chip--outline">
                <span className="kz-mono" style={{ fontSize: 11 }}>{tr.date_filter(dateFilter)}</span>
                <button onClick={() => navigate('/library')} className="kz-text-mute" style={{ marginLeft: 4 }}>{tr.clear_filter}</button>
              </span>
            )}
          </div>
          {isCompact && extractedItems.length > 0 && (
            <button onClick={() => setShowExtracted(!showExtracted)} className={`kz-btn kz-btn--sm ${showExtracted ? 'kz-btn--primary' : ''}`} title={tr.extracted_info}>
              <PanelRightOpen size={14} />
            </button>
          )}
        </div>
      )}

      <div
        className="flex flex-1 min-h-0 relative"
        style={{ background: 'var(--bg-card)', border: '1px solid var(--line)', borderRadius: 'var(--radius)', overflow: 'hidden', boxShadow: 'var(--shadow)' }}
      >
        {isMobile && showSidebar && (
          <div className="absolute inset-0 z-20 flex">
            <ConversationList {...sidebarProps} width={280} className="shadow-xl z-10" />
            <div className="flex-1 bg-black/20" onClick={() => setShowSidebar(false)} />
          </div>
        )}

        {!isMobile && (
          <>
            <ConversationList {...sidebarProps} width={leftPanelWidth} />
            <div
              onMouseDown={handleLeftDragStart}
              className="group/drag flex-shrink-0 cursor-col-resize flex items-center justify-center relative"
              style={{ width: 12 }}
            >
              <div className="group-hover/drag:bg-[var(--line-strong)] transition-colors" style={{ width: 1, height: '100%', background: 'var(--line)' }} />
            </div>
          </>
        )}

        {/* Main content area: per-column headers, no global top bar */}
        <div className="flex-1 flex min-h-0 min-w-0" style={{ background: 'var(--bg-card)' }}>
          {(() => {
            const isNonAudio = ['image', 'video', 'pdf', 'docx', 'text'].includes(currentMediaType);
            const transcriptColumn = (
              <div className="flex-1 flex flex-col min-w-0 min-h-0">
                {/* Column-scoped header: avatar + title + meta + 优化/原始 + 收起 + 复制 + 导出 */}
                <TranscriptHeader
                  liveSelected={liveSelected} liveStatus={liveStatus} liveSegments={liveSegments}
                  conversations={conversations} selectedConv={selectedConv}
                  messages={messages}
                  onCopyText={handleCopyText} onExport={handleExport}
                  onToggleTranscript={() => setShowTranscript(!showTranscript)}
                  showTranscript={showTranscript}
                  textMode={textMode} onTextModeChange={setTextMode}
                  tr={tr} t={t} lang={lang}
                />
                <TranscriptContent
                  liveSelected={liveSelected} liveStatus={liveStatus} liveSegments={liveSegments} liveEndRef={liveEndRef}
                  textMode={textMode} messages={messages} highlightedSegment={highlightedSegment}
                  currentTime={currentTime} isPlaying={isPlaying}
                  conversationCount={conversations.length} extractedElement={null}
                  extractedItems={extractedItems} mediaType={currentMediaType} imageUrl={imageUrl}
                  recordingId={conversations[selectedConv]?.recordingId}
                  pageCount={conversations[selectedConv]?.pageCount}
                  videoRef={videoRef}
                  onBubbleClick={handleBubbleClick} onToggleBookmark={handleToggleBookmark} onEditSegment={handleEditSegment} tr={tr} t={t} lang={lang}
                />
                {!isNonAudio && (
                  <AudioPlayer
                    audioRef={audioRef} progressRef={progressRef} isPlaying={isPlaying} currentTime={currentTime}
                    duration={duration} playbackSpeed={playbackSpeed} audioLoaded={audioLoaded} audioError={audioError}
                    liveSelected={liveSelected} onTogglePlayPause={togglePlayPause} onSpeedChange={handleSpeedChange}
                    onProgressClick={handleProgressClick} tr={tr}
                  />
                )}
              </div>
            );

            const qaColumn = showSideQAPanel ? (
              <>
                <div onMouseDown={handleRightDragStart} className="group/drag flex-shrink-0 cursor-col-resize flex items-center justify-center relative" style={{ width: 12 }}>
                  <div className="group-hover/drag:bg-[var(--line-strong)] transition-colors" style={{ width: 1, height: '100%', background: 'var(--line)' }} />
                </div>
                <div
                  style={{
                    flex: `0 0 ${rightPanelWidth}px`,
                    width: rightPanelWidth,
                    minWidth: RIGHT_PANEL_MIN,
                    background: 'var(--bg-card)',
                    minHeight: 0,
                    overflow: 'hidden',
                  }}
                  className="flex flex-col"
                >
                  {/* Section header + Clear button live inside SummaryQAPanel */}
                  <SummaryQAPanel
                    recordingId={conversations[selectedConv]?.recordingId}
                    meetingNotes={meetingNotes}
                    extractedItems={extractedItems}
                    mediaType={currentMediaType}
                    onRegenerateMeetingNotes={handleRegenerateMeetingNotes}
                    onCopyMeetingNotesMarkdown={handleCopyMeetingNotesMarkdown}
                    isRegenerating={isRegenerating}
                    tr={tr}
                    lang={lang}
                  />
                </div>
              </>
            ) : null;

            return (<>{transcriptColumn}{qaColumn}</>);
          })()}
        </div>

        {isCompact && showExtracted && extractedItems.length > 0 && (
          <div
            className="absolute bottom-0 left-0 right-0 z-10 overflow-y-auto"
            style={{
              background: 'var(--bg-card)',
              borderTop: '1px solid var(--line)',
              boxShadow: '0 -8px 22px oklch(0.3 0.02 60 / 0.08)',
              maxHeight: '40%',
              padding: '14px 18px',
            }}
          >
            <div className="flex justify-between items-center" style={{ marginBottom: 10 }}>
              <span className="kz-serif-italic kz-text-soft" style={{ fontSize: 13 }}>{tr.extracted_info}</span>
              <button onClick={() => setShowExtracted(false)} className="kz-btn kz-btn--ghost kz-btn--sm">&times;</button>
            </div>
            <ExtractedPanel items={extractedItems} tr={tr} />
          </div>
        )}
      </div>
    </div>
  );
}
