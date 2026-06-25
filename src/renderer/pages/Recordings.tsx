import React, { useState, useEffect, useRef } from 'react';
import { FolderOpen, Upload } from 'lucide-react';
import { useI18n } from '../i18n';
import { useApi, QueueTaskEvent, RecordingRow } from '../hooks/useApi';
import { useNavigate } from 'react-router-dom';
import { useNotifications } from '../components/NotificationCenter';
import { Skeleton, SkeletonList } from '../components/Skeleton';
import DropZone from './recordings/DropZone';
import QueueSection from './recordings/QueueSection';
import HistorySection from './recordings/HistorySection';
import type { QueueItem, HistoryItem, TextNoteItem } from './recordings/types';
import { STATUS_TO_STEP } from './recordings/types';

export default function Recordings() {
  const { t, lang } = useI18n();
  const api = useApi();
  const navigate = useNavigate();
  const { toast } = useNotifications();
  const r = t.rec;

  const rRef = useRef(r);
  useEffect(() => { rRef.current = r; }, [r]);

  const [dragOver, setDragOver] = useState(false);
  const [filter, setFilter] = useState('ALL');
  const [deleteConfirmId, setDeleteConfirmId] = useState<number | null>(null);
  const [queueItems, setQueueItems] = useState<QueueItem[]>([]);
  const [historyItems, setHistoryItems] = useState<HistoryItem[]>([]);
  const [textNoteItems, setTextNoteItems] = useState<TextNoteItem[]>([]);
  const [selectedNote, setSelectedNote] = useState<TextNoteItem | null>(null);
  const [paused, setPaused] = useState(false);
  const [expandedErrors, setExpandedErrors] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);

  // --- Initial data load ---
  useEffect(() => {
    Promise.all([loadQueue(), loadHistory(), loadTextNotes()])
      .finally(() => setLoading(false));
    api.isQueuePaused().then(setPaused).catch((e) => console.warn('[Recordings] isQueuePaused:', e));
  }, []);

  // --- Live task events ---
  useEffect(() => {
    function taskToQueueItem(task: QueueTaskEvent): QueueItem {
      return {
        id: task.id,
        name: task.filePath.split(/[/\\]/).pop() || task.filePath,
        filePath: task.filePath, duration: '', size: '',
        progress: task.progress,
        status: task.status === 'pending' ? 'pending' : task.status === 'completed' ? 'done' : task.status === 'failed' ? 'error' : 'processing',
        rawStatus: task.status,
        currentStep: STATUS_TO_STEP[task.status] ?? -1,
        error: task.error || null,
        notes: task.notes || null,
        mediaType: task.mediaType,
      };
    }

    const unsubs = [
      api.onTaskAdded((_e, task) => {
        setQueueItems((prev) => [...prev, taskToQueueItem(task)]);
      }),
      api.onTaskProgress((_e, task) => {
        setQueueItems((prev) => prev.map((q) => q.id === task.id ? taskToQueueItem(task) : q));
      }),
      api.onTaskCompleted((_e, task) => {
        setQueueItems((prev) => prev.filter((q) => q.id !== task.id));
        loadHistory();
        const name = task.filePath.split(/[/\\]/).pop() || task.filePath;
        toast('success', rRef.current.pipeline_complete, name);
      }),
      api.onTaskFailed((_e, task) => {
        setQueueItems((prev) => prev.map((q) => q.id === task.id ? taskToQueueItem(task) : q));
        const name = task.filePath.split(/[/\\]/).pop() || task.filePath;
        toast('error', rRef.current.pipeline_failed, `${name}: ${task.error || rRef.current.unknown_error}`);
      }),
      api.onRecordingSaved(async (_e, data) => {
        const fname = data.filePath.split(/[/\\]/).pop() || '';
        toast('success', rRef.current.recording_saved, fname);
        try { await api.enqueue(data.filePath); } catch { /* Already enqueued by main process */ }
        loadQueue();
      }),
      api.onRecordingError((_e, error) => {
        if (error === 'microphone_denied') toast('error', rRef.current.mic_denied);
        else if (error === 'mic_disconnected') toast('error', rRef.current.mic_disconnected);
        else if (error === 'ffmpeg_unavailable') toast('error', rRef.current.ffmpeg_missing);
        else toast('error', rRef.current.recording_error, error);
      }),
      api.onTextNoteNew((_e, _note) => {
        loadTextNotes();
      }),
    ];
    return () => { unsubs.forEach((fn) => fn()); };
  }, []);

  // --- Data loading ---
  async function loadQueue() {
    try {
      const queue = await api.getQueue();
      setQueueItems(queue.map((item) => ({
        id: item.id, name: item.filePath.split(/[/\\]/).pop() || item.filePath,
        filePath: item.filePath, duration: '', size: '', progress: item.progress,
        status: item.status === 'pending' ? 'pending' : item.status === 'completed' ? 'done' : item.status === 'failed' ? 'error' : 'processing',
        rawStatus: item.status, currentStep: STATUS_TO_STEP[item.status] ?? -1,
        error: item.error || null,
        notes: (item as any).notes || null,
        mediaType: item.mediaType,
      })));
    } catch (err) { console.error('[Recordings] loadQueue failed:', err); }
  }

  async function loadHistory() {
    try {
      const recordings = await api.getRecordings();
      setHistoryItems(recordings.map((rec: RecordingRow) => ({
        id: `PROC-${String(rec.id).padStart(3, '0')}`, recordingId: rec.id,
        name: rec.file_name,
        date: rec.processed_at ? new Date(rec.processed_at).toLocaleDateString(lang === 'zh' ? 'zh-CN' : 'en-US', { month: '2-digit', day: '2-digit' }) : '',
        duration: rec.duration_seconds ? formatDuration(rec.duration_seconds) : '',
        size: '', speakers: rec.speaker_count || 0, extracted: rec.extracted_count || 0,
        status: rec.status === 'completed' ? 'done' : rec.status === 'failed' ? 'error' : 'active',
        tags: rec.tags ? (() => { try { return JSON.parse(rec.tags); } catch { return []; } })() : [],
        scene: rec.capture_scene || 'dictation',
        mediaType: rec.media_type || 'audio',
        pageCount: rec.page_count,
        wordCount: rec.word_count,
      })));
    } catch (err) { console.error('[Recordings] loadHistory failed:', err); }
  }

  async function loadTextNotes() {
    try {
      const notes = await api.getTextNotes(200);
      setTextNoteItems(notes.map((n: any) => ({
        id: `NOTE-${String(n.id).padStart(3, '0')}`, noteId: n.id,
        content: (n.content || '').slice(0, 60) + ((n.content || '').length > 60 ? '\u2026' : ''),
        fullContent: n.content || '', agentReply: n.agent_reply || null,
        date: n.created_at ? new Date(n.created_at).toLocaleDateString(lang === 'zh' ? 'zh-CN' : 'en-US', { month: '2-digit', day: '2-digit' }) : '',
        channelId: n.channel_id || 'feishu',
      })));
    } catch (err) { console.error('[Recordings] loadTextNotes failed:', err); }
  }

  function formatDuration(seconds: number): string {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) return `${h}${t.duration_h} ${m}${t.duration_min}`;
    if (m > 0) return `${m}${t.duration_min} ${s}${t.duration_s}`;
    return `${s}${t.duration_s}`;
  }

  // --- Action handlers ---
  const ACCEPTED_EXTENSIONS = new Set([
    'wav', 'mp3', 'm4a', 'flac', 'ogg', 'webm',
    'mp4', 'mkv', 'avi', 'mov', 'wmv',
    'pdf', 'docx', 'txt', 'md',
    'jpg', 'jpeg', 'png', 'heic', 'webp',
  ]);
  const DOC_EXTENSIONS = new Set(['pdf', 'docx', 'txt', 'md']);
  const IMPORT_FILTERS = [
    { name: 'All Supported', extensions: ['wav', 'mp3', 'm4a', 'flac', 'ogg', 'webm', 'mp4', 'mkv', 'avi', 'mov', 'wmv', 'pdf', 'docx', 'txt', 'md', 'jpg', 'jpeg', 'png', 'heic', 'webp'] },
    { name: 'Audio', extensions: ['wav', 'mp3', 'm4a', 'flac', 'ogg', 'webm'] },
    { name: 'Video', extensions: ['mp4', 'mkv', 'avi', 'mov', 'wmv'] },
    { name: 'Documents', extensions: ['pdf', 'docx', 'txt', 'md'] },
    { name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'heic', 'webp'] },
  ];
  const MAX_MEDIA_SIZE = 500 * 1024 * 1024; // 500MB for audio/video
  const MAX_DOC_SIZE = 50 * 1024 * 1024;    // 50MB for documents

  async function handleFileDrop(e: React.DragEvent) {
    e.preventDefault(); setDragOver(false);
    const files = Array.from(e.dataTransfer.files);
    let enqueued = 0, skipped = 0, tooLarge = 0;
    for (const file of files) {
      const ext = file.name.split('.').pop()?.toLowerCase();
      if (ACCEPTED_EXTENSIONS.has(ext || '')) {
        let filePath = '';
        try { filePath = api.getPathForFile ? api.getPathForFile(file) : (file as any).path || ''; } catch { filePath = (file as any).path || ''; }
        console.log(`[Drop] file=${file.name} ext=${ext} path=${filePath ? filePath.slice(0, 50) : 'EMPTY'}`);
        if (!filePath) { skipped++; continue; }
        const maxSize = DOC_EXTENSIONS.has(ext || '') ? MAX_DOC_SIZE : MAX_MEDIA_SIZE;
        if (file.size > maxSize) { tooLarge++; continue; }
        try {
          const result = await api.enqueue(filePath);
          if (result?.status === 'failed') { skipped++; }
          else { enqueued++; }
        } catch { skipped++; }
      } else { skipped++; }
    }
    if (tooLarge > 0) toast('error', `${tooLarge} ${r.file_too_large}`);
    if (enqueued > 0) toast('success', `${enqueued} ${r.files_queued}`, skipped > 0 ? `${skipped} ${r.files_skipped}` : undefined);
    else if (skipped > 0 && tooLarge === 0) toast('error', r.drop_formats);
    loadQueue();
  }

  async function handleBrowse() {
    try {
      const filePaths = await api.openFiles(IMPORT_FILTERS);
      if (!filePaths || filePaths.length === 0) return;

      let enqueued = 0;
      let skipped = 0;
      let lastError = '';
      for (const filePath of filePaths) {
        try {
          const result = await api.enqueue(filePath);
          if (result?.status === 'failed') {
            skipped++;
            lastError = result.error || r.unknown_error;
          } else {
            enqueued++;
          }
        } catch (err) {
          skipped++;
          lastError = String(err);
        }
      }
      if (enqueued > 0) {
        toast('success', `${enqueued} ${r.files_queued}`, skipped > 0 ? `${skipped} ${r.files_skipped}` : undefined);
      } else if (skipped > 0) {
        toast('error', r.pipeline_failed, lastError || r.drop_formats);
      }
      loadQueue();
    } catch (err) {
      toast('error', r.pipeline_failed, String(err));
    }
  }

  async function handleRetry(taskId: string) {
    try { await api.retryTask(taskId); } catch (err) { toast('error', r.pipeline_failed, String(err)); }
    loadQueue();
  }

  async function handleCancel(taskId: string) {
    try { await api.cancelTask(taskId); setQueueItems((prev) => prev.filter((q) => q.id !== taskId)); }
    catch (err) { console.error('[Recordings] Cancel failed:', err); }
  }

  async function handlePauseToggle() {
    try {
      if (paused) { await api.resumeQueue(); setPaused(false); }
      else { await api.pauseQueue(); setPaused(true); }
    } catch (err) { console.error('[Recordings] Pause/resume failed:', err); }
  }

  async function handleResetStuck() {
    try {
      const result = await api.resetStuckTasks();
      const total = result.queueCount + result.dbCount;
      if (total > 0) toast('success', r.reset_stuck_done(total));
      else toast('success', r.reset_stuck_none);
      loadQueue(); loadHistory();
    } catch (err) { toast('error', r.reset_failed, String(err)); }
  }

  async function handleReprocess(recordingId: number, name: string) {
    try {
      const result = await api.reprocessRecording(recordingId);
      if (result.ok) { toast('success', r.reprocess, name); loadQueue(); loadHistory(); }
      else toast('error', r.pipeline_failed, result.error || '');
    } catch (err) { toast('error', r.pipeline_failed, String(err)); }
  }

  async function handleDeleteConfirm(recordingId: number) {
    try { await api.deleteRecording(recordingId); setDeleteConfirmId(null); loadHistory(); }
    catch (err) { console.error('[Recordings] Delete failed:', err); toast('error', r.delete_failed, String(err)); setDeleteConfirmId(null); }
  }

  // --- Derived state ---
  // Compute per-filter counts so each chip shows N matching items (matches design)
  const counts = {
    ALL: historyItems.length,
    AUDIO: historyItems.filter((i) => i.mediaType === 'audio').length,
    VIDEO: historyItems.filter((i) => i.mediaType === 'video').length,
    DOCUMENT: historyItems.filter((i) => ['pdf', 'docx'].includes(i.mediaType)).length,
    IMAGE: historyItems.filter((i) => i.mediaType === 'image').length,
    TEXT: textNoteItems.length,
    DONE: historyItems.filter((i) => i.status === 'done').length,
    ERROR: historyItems.filter((i) => i.status === 'error').length,
  };
  const filters = [
    { key: 'ALL', label: r.filter_all, count: counts.ALL },
    { key: 'AUDIO', label: r.filter_audio, count: counts.AUDIO },
    { key: 'VIDEO', label: r.filter_video, count: counts.VIDEO },
    { key: 'DOCUMENT', label: r.filter_document, count: counts.DOCUMENT },
    { key: 'IMAGE', label: r.filter_image, count: counts.IMAGE },
    { key: 'TEXT', label: r.filter_text, count: counts.TEXT },
    { key: 'DONE', label: r.filter_done, count: counts.DONE },
    { key: 'ERROR', label: r.filter_error, count: counts.ERROR },
  ];

  const filteredHistory = historyItems.filter((item) => {
    if (filter === 'TEXT') return item.mediaType === 'text';
    if (filter === 'ALL') return true;
    if (filter === 'AUDIO') return item.mediaType === 'audio';
    if (filter === 'VIDEO') return item.mediaType === 'video';
    if (filter === 'DOCUMENT') return ['pdf', 'docx'].includes(item.mediaType);
    if (filter === 'IMAGE') return item.mediaType === 'image';
    if (filter === 'DONE') return item.status === 'done';
    if (filter === 'ERROR') return item.status === 'error';
    return true;
  });

  const filteredNotes = textNoteItems.filter(() => filter === 'ALL' || filter === 'TEXT');

  if (loading) {
    return (
      <div role="status" aria-label="Loading">
        <div className="mb-8">
          <Skeleton variant="text" className="h-6 w-48 mb-2" />
          <Skeleton variant="text" className="h-4 w-72" />
        </div>
        <Skeleton className="h-32 w-full rounded-lg mb-6" />
        <div className="mb-6">
          <Skeleton variant="text" className="h-4 w-24 mb-3" />
          <SkeletonList rows={3} />
        </div>
        <div>
          <Skeleton variant="text" className="h-4 w-32 mb-3" />
          <SkeletonList rows={5} />
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="kz-ph">
        <div>
          <div className="kz-ph__title">{r.title}</div>
          {r.desc && <div className="kz-ph__sub">{r.desc}</div>}
        </div>
        <div className="kz-ph__right">
          <button className="kz-btn kz-btn--sm" onClick={() => navigate('/settings')} title={(r as any).open_watch_dir}>
            <FolderOpen size={13} /> {(r as any).open_watch_dir}
          </button>
          <button className="kz-btn kz-btn--sm" onClick={handleBrowse} title={(r as any).browse_btn}>
            <Upload size={13} /> {(r as any).browse_btn}
          </button>
        </div>
      </div>

      <DropZone
        dragOver={dragOver}
        r={r}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleFileDrop}
        onBrowse={handleBrowse}
      />

      <QueueSection
        queueItems={queueItems}
        historyItems={historyItems}
        paused={paused}
        expandedErrors={expandedErrors}
        r={r}
        onPauseToggle={handlePauseToggle}
        onCancel={handleCancel}
        onRetry={handleRetry}
        onResetStuck={handleResetStuck}
        onToggleError={(itemId) => {
          setExpandedErrors((prev) => {
            const next = new Set(prev);
            next.has(itemId) ? next.delete(itemId) : next.add(itemId);
            return next;
          });
        }}
      />

      <HistorySection
        filteredHistory={filteredHistory}
        filteredNotes={filteredNotes}
        filter={filter}
        filters={filters}
        deleteConfirmId={deleteConfirmId}
        selectedNote={selectedNote}
        lang={lang}
        r={r}
        t={t}
        onFilterChange={setFilter}
        onRecordingClick={(recordingId) => navigate('/library?recording=' + recordingId)}
        onReprocess={handleReprocess}
        onDeleteRequest={setDeleteConfirmId}
        onDeleteConfirm={handleDeleteConfirm}
        onDeleteCancel={() => setDeleteConfirmId(null)}
        onNoteClick={setSelectedNote}
        onNoteClose={() => setSelectedNote(null)}
      />
    </div>
  );
}
