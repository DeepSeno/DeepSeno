import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Search, BookOpen, Users, Lightbulb, FolderKanban, Sparkles,
  RefreshCw, Loader2, Network, ArrowRight, ArrowLeft, X,
  Pencil, Trash2, Check, AlertTriangle, ChevronDown, Clock,
} from 'lucide-react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useSearchParams } from 'react-router-dom';
import { useI18n } from '../i18n';
import { useApi } from '../hooks/useApi';
import PageGraph from './knowledge/PageGraph';
import DuplicatePanel from './knowledge/DuplicatePanel';
import type { LucideIcon } from 'lucide-react';

// ─── Types ──────────────────────────────────────────────────────
interface KnowledgePage {
  id: number;
  slug: string;
  type: string;
  title: string;
  content_markdown: string;
  summary: string | null;
  source_segment_ids: string;
  source_recording_ids: string;
  tags: string;
  compilation_count: number;
  content_edited: number;
  last_compiled_at: string | null;
  created_at: string;
  updated_at: string;
}

interface KnowledgeLink {
  id: number;
  from_page_id: number;
  to_page_id: number;
  link_type: string;
  context: string | null;
  to_title?: string;
  to_slug?: string;
  to_type?: string;
  from_title?: string;
  from_slug?: string;
  from_type?: string;
}

interface QueueStatus {
  pending: number;
  processing: number;
}

interface QueueEntry {
  id: number;
  recording_id: number;
  recording_name: string | null;
  status: string;
  priority: number;
  error_message: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

interface KnowledgeStats {
  total: number;
  person: number;
  topic: number;
  project: number;
  concept: number;
}

// ─── Constants ──────────────────────────────────────────────────
const TYPE_FILTERS = ['all', 'person', 'topic', 'project', 'concept'] as const;
type PageType = (typeof TYPE_FILTERS)[number];

const TYPE_ICONS: Record<string, LucideIcon> = {
  person: Users,
  topic: Lightbulb,
  project: FolderKanban,
  concept: BookOpen,
};

// Editorial palette mapping: person→info (blue), topic→accent (ochre/warn), project→success (green), concept→violet
// kz-badge--<tone> is the badge utility; cssVar.* are CSS variables for inline use.
const TYPE_TONES: Record<string, { tone: string; bg: string; fg: string }> = {
  person:  { tone: 'info',    bg: 'var(--c-info-bg)',    fg: 'var(--c-info)' },
  topic:   { tone: 'accent',  bg: 'var(--c-accent-bg)',  fg: 'var(--c-accent)' },
  project: { tone: 'success', bg: 'var(--c-success-bg)', fg: 'var(--c-success)' },
  concept: { tone: 'violet',  bg: 'var(--c-violet-bg)',  fg: 'var(--c-violet)' },
};

function getTypeIcon(type: string): LucideIcon {
  return TYPE_ICONS[type] || Sparkles;
}

function getTypeTone(type: string) {
  return TYPE_TONES[type] || { tone: 'mute', bg: 'var(--bg-elev)', fg: 'var(--ink-soft)' };
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return '—';
  const d = new Date(dateStr);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

// Compact elapsed time for queue entries. SQLite timestamps are UTC ('YYYY-MM-DD HH:MM:SS').
function formatAge(dateStr: string | null): string {
  if (!dateStr) return '';
  const ms = new Date(dateStr.replace(' ', 'T') + 'Z').getTime();
  if (isNaN(ms)) return '';
  const sec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h`;
  return `${Math.floor(sec / 86400)}d`;
}

const QUEUE_DOT: Record<string, string> = {
  processing: 'kz-sdot--accent',
  pending: 'kz-sdot--mute',
  failed: 'kz-sdot--danger',
};

function getTypeLabel(type: string, t: any): string {
  const k = t?.knowledge || {};
  const map: Record<string, string> = {
    all: k.filter_all || 'All',
    person: k.type_person || 'Person',
    topic: k.type_topic || 'Topic',
    project: k.type_project || 'Project',
    concept: k.type_concept || 'Concept',
  };
  return map[type] || type;
}

// Compilation lifecycle status: 已编辑 (manually edited) > 已编译 (compiled) > 未编译 (never compiled)
type PageStatus = 'edited' | 'compiled' | 'uncompiled';

function getPageStatus(page: { content_edited?: number; compilation_count: number }): PageStatus {
  if (page.content_edited) return 'edited';
  if (page.compilation_count > 0) return 'compiled';
  return 'uncompiled';
}

const STATUS_TONE: Record<PageStatus, string> = {
  edited: 'accent',
  compiled: 'success',
  uncompiled: 'mute',
};

function getStatusLabel(status: PageStatus, t: any): string {
  const k = t?.knowledge || {};
  const map: Record<PageStatus, string> = {
    edited: k.status_edited || 'Edited',
    compiled: k.status_compiled || 'Compiled',
    uncompiled: k.status_uncompiled || 'Not compiled',
  };
  return map[status];
}

// ─── Component ──────────────────────────────────────────────────
export default function KnowledgePage() {
  const { t } = useI18n();
  const api = useApi();
  const [searchParams, setSearchParams] = useSearchParams();

  // State
  const [pages, setPages] = useState<KnowledgePage[]>([]);
  const [selectedPage, setSelectedPage] = useState<KnowledgePage | null>(null);
  const [links, setLinks] = useState<KnowledgeLink[]>([]);
  const [backlinks, setBacklinks] = useState<KnowledgeLink[]>([]);
  const [stats, setStats] = useState<KnowledgeStats>({ total: 0, person: 0, topic: 0, project: 0, concept: 0 });
  const [queueStatus, setQueueStatus] = useState<QueueStatus>({ pending: 0, processing: 0 });
  const [queueEntries, setQueueEntries] = useState<QueueEntry[]>([]);
  const [queueExpanded, setQueueExpanded] = useState(false);
  const [clearingQueue, setClearingQueue] = useState(false);

  const [searchQuery, setSearchQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState<PageType>('all');
  const [loading, setLoading] = useState(true);
  const [recompiling, setRecompiling] = useState(false);
  const [rebuildingAll, setRebuildingAll] = useState(false);
  const [showGraph, setShowGraph] = useState(false);
  const [graphData, setGraphData] = useState<{ nodes: any[]; edges: any[] }>({ nodes: [], edges: [] });
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());

  // Edit mode
  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState('');
  const [editType, setEditType] = useState('');
  const [editContent, setEditContent] = useState('');
  const [saving, setSaving] = useState(false);

  // Delete
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Resizable graph panel
  const [graphPanelWidth, setGraphPanelWidth] = useState(384);
  const isDraggingPanel = useRef(false);

  // ─── Data Loading ───────────────────────────────────────────
  const loadPages = useCallback(async () => {
    try {
      const typeArg = typeFilter === 'all' ? undefined : typeFilter;
      let result: KnowledgePage[];
      if (searchQuery.trim()) {
        result = await api.knowledgeSearch(searchQuery.trim(), typeArg);
      } else {
        result = await api.knowledgeGetAll(typeArg);
      }
      setPages(result);
    } catch {
      setPages([]);
    }
  }, [api, searchQuery, typeFilter]);

  const loadStats = useCallback(async () => {
    try {
      const [s, q, entries] = await Promise.all([
        api.knowledgeGetStats(),
        api.knowledgeGetQueueStatus(),
        (api as any).knowledgeGetQueueEntries?.() ?? Promise.resolve([]),
      ]);
      setStats(s);
      setQueueStatus(q);
      setQueueEntries(Array.isArray(entries) ? entries : []);
    } catch { /* ignore */ }
  }, [api]);

  const handleClearStuckQueue = async () => {
    if (clearingQueue) return;
    setClearingQueue(true);
    try {
      await (api as any).knowledgeClearStuckQueue?.();
      await loadStats();
    } finally {
      setClearingQueue(false);
    }
  };

  const loadPageDetail = useCallback(async (slug: string) => {
    try {
      const page = await api.knowledgeGetBySlug(slug);
      if (page) {
        setSelectedPage(page);
        const [l, bl] = await Promise.all([
          api.knowledgeGetLinks(page.id),
          api.knowledgeGetBacklinks(page.id),
        ]);
        setLinks(l);
        setBacklinks(bl);
      } else {
        setSelectedPage(null);
        setLinks([]);
        setBacklinks([]);
      }
    } catch {
      setSelectedPage(null);
    }
  }, [api]);

  const loadGraph = useCallback(async () => {
    try {
      const data = await api.knowledgeGetGraph();
      setGraphData(data);
    } catch { /* ignore */ }
  }, [api]);

  // Initial load
  useEffect(() => {
    setLoading(true);
    Promise.all([loadPages(), loadStats()]).finally(() => setLoading(false));
  }, [loadPages, loadStats]);

  // Poll the queue while work is active or the detail panel is open, so counts
  // and per-entry progress refresh without a manual reload.
  useEffect(() => {
    const active = queueStatus.processing > 0 || queueStatus.pending > 0;
    if (!active && !queueExpanded) return;
    const id = setInterval(() => { loadStats(); }, 4000);
    return () => clearInterval(id);
  }, [queueStatus.processing, queueStatus.pending, queueExpanded, loadStats]);

  // Load graph for the overview preview and when the side panel is toggled on
  useEffect(() => {
    loadGraph();
  }, [loadGraph]);

  useEffect(() => {
    if (showGraph) loadGraph();
  }, [showGraph, loadGraph]);

  // URL-driven page selection
  useEffect(() => {
    const slug = searchParams.get('page');
    if (slug) {
      loadPageDetail(slug);
    } else {
      setSelectedPage(null);
      setLinks([]);
      setBacklinks([]);
    }
    setEditing(false);
    setShowDeleteConfirm(false);
  }, [searchParams, loadPageDetail]);

  // ─── Handlers ───────────────────────────────────────────────
  // Stable identity: PageGraph keys its d3 simulation on the onSelectPage prop,
  // so an inline function would restart the layout on every parent re-render
  // (e.g. the queue poll tick).
  const selectPage = useCallback((slug: string) => {
    setSearchParams({ page: slug });
  }, [setSearchParams]);

  const handleRecompile = async () => {
    if (!selectedPage || recompiling) return;
    setRecompiling(true);
    try {
      await api.knowledgeRecompile(selectedPage.id);
      await loadPageDetail(selectedPage.slug);
      await loadStats();
    } finally {
      setRecompiling(false);
    }
  };

  const handleToggleSelectMode = () => {
    setSelectMode((prev) => {
      if (prev) setSelectedIds(new Set());
      return !prev;
    });
  };

  const handleToggleSelection = (id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const handleMergeComplete = async () => {
    setSelectMode(false);
    setSelectedIds(new Set());
    await Promise.all([loadPages(), loadStats()]);
  };

  const handleRebuildAll = async () => {
    if (rebuildingAll) return;
    setRebuildingAll(true);
    try {
      await api.knowledgeCompileAll();
      await Promise.all([loadPages(), loadStats()]);
    } finally {
      setRebuildingAll(false);
    }
  };

  const enterEditMode = () => {
    if (!selectedPage) return;
    setEditTitle(selectedPage.title);
    setEditType(selectedPage.type);
    setEditContent(selectedPage.content_markdown || '');
    setEditing(true);
  };

  const cancelEdit = () => {
    setEditing(false);
  };

  const saveEdit = async () => {
    if (!selectedPage || saving) return;
    setSaving(true);
    try {
      // Title or type changed → rename
      if (editTitle !== selectedPage.title || editType !== selectedPage.type) {
        const result = await api.knowledgeRenamePage(selectedPage.id, editTitle, editType);
        if (!result.success) {
          alert(result.error);
          setSaving(false);
          return;
        }
        // Content changed → also save content
        if (editContent !== selectedPage.content_markdown) {
          await api.knowledgeEditContent(selectedPage.id, editContent);
        }
        // Reload with new slug
        await loadPages();
        await loadStats();
        setSearchParams({ page: result.newSlug });
      } else if (editContent !== selectedPage.content_markdown) {
        // Only content changed
        await api.knowledgeEditContent(selectedPage.id, editContent);
        await loadPageDetail(selectedPage.slug);
      }
      setEditing(false);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!selectedPage || deleting) return;
    setDeleting(true);
    try {
      await api.knowledgeDelete(selectedPage.id);
      setShowDeleteConfirm(false);
      setSearchParams({});
      await Promise.all([loadPages(), loadStats()]);
    } finally {
      setDeleting(false);
    }
  };

  const handleBatchDelete = async () => {
    if (selectedIds.size === 0 || deleting) return;
    setDeleting(true);
    try {
      await api.knowledgeBatchDelete([...selectedIds]);
      setSelectMode(false);
      setSelectedIds(new Set());
      setSearchParams({});
      await Promise.all([loadPages(), loadStats()]);
    } finally {
      setDeleting(false);
    }
  };

  // ─── Graph Panel Resize ──────────────────────────────────────
  const handlePanelDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isDraggingPanel.current = true;
    const startX = e.clientX;
    const startWidth = graphPanelWidth;
    const onMove = (ev: MouseEvent) => {
      if (!isDraggingPanel.current) return;
      const delta = startX - ev.clientX;
      setGraphPanelWidth(Math.max(240, Math.min(720, startWidth + delta)));
    };
    const onUp = () => {
      isDraggingPanel.current = false;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, [graphPanelWidth]);

  // ─── Render Helpers ─────────────────────────────────────────
  const TypeBadge = ({ type }: { type: string }) => {
    const tone = getTypeTone(type);
    return (
      <span className={`kz-badge kz-badge--${tone.tone}`}>
        {getTypeLabel(type, t)}
      </span>
    );
  };

  const StatusBadge = ({ page }: { page: { content_edited?: number; compilation_count: number } }) => {
    const status = getPageStatus(page);
    const count = page.compilation_count;
    const label = getStatusLabel(status, t);
    return (
      <span className={`kz-badge kz-badge--${STATUS_TONE[status]} kz-badge--dot`}>
        {status === 'compiled' && count > 1 ? `${label} ${count}×` : label}
      </span>
    );
  };

  const LinkChip = ({ slug, title, type }: { slug: string; title: string; type: string }) => {
    const tone = getTypeTone(type);
    const Icon = getTypeIcon(type);
    return (
      <button
        onClick={() => selectPage(slug)}
        className="kz-card inline-flex items-center gap-1.5 group"
        style={{
          padding: '4px 10px',
          fontFamily: 'var(--mono)',
          fontSize: 11.5,
          color: 'var(--ink-soft)',
          borderLeft: `2px solid ${tone.fg}`,
        }}
      >
        <Icon size={11} style={{ color: tone.fg }} />
        <span className="group-hover:kz-text-ink">{title}</span>
      </button>
    );
  };

  const hasLinks = links.length > 0 || backlinks.length > 0;

  // ─── Layout ─────────────────────────────────────────────────
  return (
    <div className="-m-6 flex" style={{ height: 'calc(100% + 3rem)', background: 'var(--bg)' }}>
      {/* ─── Left Sidebar ─────────────────────────────────── */}
      <div
        className="w-72 flex-shrink-0 flex flex-col h-full"
        style={{ borderRight: '1px solid var(--line)', background: 'var(--bg)' }}
      >
        {/* Search */}
        <div className="px-3 pt-3 pb-2">
          <div className="kz-search-wrap">
            <Search size={13} className="kz-text-mute" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={t.knowledge?.search_placeholder || 'Search pages...'}
            />
          </div>
        </div>

        {/* Type Filters — chips */}
        <div className="px-3 pb-2 flex gap-1 flex-wrap">
          {TYPE_FILTERS.map((f) => (
            <button
              key={f}
              onClick={() => setTypeFilter(f)}
              className={`kz-chip ${typeFilter === f ? 'kz-chip--on' : 'kz-chip--outline'}`}
            >
              {getTypeLabel(f, t)}
              {f !== 'all' && (
                <span className="kz-chip__count">{stats[f as keyof KnowledgeStats] || 0}</span>
              )}
            </button>
          ))}
        </div>

        {/* Compile queue — click to expand the per-recording detail panel */}
        {(() => {
          const failedCount = queueEntries.filter((e) => e.status === 'failed').length;
          const hasAny = queueStatus.pending > 0 || queueStatus.processing > 0 || failedCount > 0;
          if (!hasAny) return null;
          const hasRecoverable = queueEntries.some((e) => e.status === 'processing' || e.status === 'failed');
          return (
            <div className="mx-3 mb-2">
              <button
                onClick={() => setQueueExpanded((v) => !v)}
                className="w-full px-2 py-1 flex items-center gap-2 kz-card-soft kz-row-hover"
                style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--ink-mute)', border: 0, cursor: 'pointer', borderRadius: 6 }}
                title={t.knowledge?.queue_toggle || '查看编译队列'}
              >
                {queueStatus.processing > 0
                  ? <Loader2 size={10} className="animate-spin kz-text-mute" />
                  : failedCount > 0
                    ? <AlertTriangle size={10} style={{ color: 'var(--c-danger)' }} />
                    : <Clock size={10} className="kz-text-mute" />}
                <span className="flex-1 text-left truncate">
                  {[
                    queueStatus.processing > 0 ? `${queueStatus.processing} ${t.knowledge?.compiling || '编译中'}` : '',
                    queueStatus.pending > 0 ? `${queueStatus.pending} ${t.knowledge?.pending || '等待'}` : '',
                    failedCount > 0 ? `${failedCount} ${t.knowledge?.queue_failed || '失败'}` : '',
                  ].filter(Boolean).join(' · ')}
                </span>
                <ChevronDown
                  size={11}
                  style={{ transform: queueExpanded ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s', flexShrink: 0 }}
                />
              </button>
              {queueExpanded && (
                <div className="kz-card-soft mt-1" style={{ padding: 4, maxHeight: 240, overflowY: 'auto', borderRadius: 6 }}>
                  {queueEntries.length === 0 ? (
                    <div className="kz-text-faint" style={{ fontFamily: 'var(--mono)', fontSize: 10, padding: '8px 6px', textAlign: 'center' }}>
                      {t.knowledge?.queue_empty || '队列为空'}
                    </div>
                  ) : (
                    queueEntries.map((entry) => (
                      <div
                        key={entry.id}
                        className="flex items-center gap-2 px-2 py-1.5"
                        style={{ fontFamily: 'var(--mono)', fontSize: 10 }}
                        title={entry.error_message || undefined}
                      >
                        <span className={`kz-sdot ${QUEUE_DOT[entry.status] || 'kz-sdot--mute'}`} style={{ flexShrink: 0 }} />
                        <span className="flex-1 truncate" style={{ color: 'var(--ink-soft)' }}>
                          {entry.recording_name || `#${entry.recording_id}`}
                        </span>
                        {entry.status === 'failed' ? (
                          <span style={{ color: 'var(--c-danger)', flexShrink: 0 }}>{t.knowledge?.queue_failed || '失败'}</span>
                        ) : (
                          <span className="kz-text-faint" style={{ flexShrink: 0 }}>
                            {formatAge(entry.started_at || entry.created_at)}
                          </span>
                        )}
                      </div>
                    ))
                  )}
                  {hasRecoverable && (
                    <button
                      onClick={handleClearStuckQueue}
                      disabled={clearingQueue}
                      className="kz-btn kz-btn--sm kz-btn--ghost w-full"
                      style={{ marginTop: 4, color: 'var(--c-danger)', justifyContent: 'center' }}
                      title={t.knowledge?.queue_clear_hint || '清除卡住或失败的任务'}
                    >
                      {clearingQueue ? <Loader2 size={11} className="animate-spin" /> : <Trash2 size={11} />}
                      {t.knowledge?.queue_clear || '清理卡住/失败的任务'}
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })()}

        {/* Separator */}
        <div className="kz-divider" />

        {/* Page List — scrollable */}
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 size={16} className="animate-spin kz-text-faint" />
            </div>
          ) : pages.length === 0 ? (
            <div className="kz-empty">
              <div className="kz-empty__icon">
                <Network size={20} />
              </div>
              <div>
                <div className="kz-empty__title">{t.knowledge?.empty || 'No knowledge pages yet'}</div>
                <div className="kz-empty__sub">
                  {t.knowledge?.empty_hint || 'Process recordings to build your knowledge base'}
                </div>
              </div>
            </div>
          ) : (
            pages.map((page, idx) => {
              const Icon = getTypeIcon(page.type);
              const isActive = selectedPage?.slug === page.slug;
              const isSelected = selectedIds.has(page.id);
              const tone = getTypeTone(page.type);
              return (
                <button
                  key={page.id}
                  onClick={() => selectMode ? handleToggleSelection(page.id) : selectPage(page.slug)}
                  className={`w-full flex items-start gap-2 px-3 py-2.5 text-left kz-row-hover ${
                    isActive && !selectMode ? 'kz-row-selected' : ''
                  } ${isSelected ? 'kz-row-selected' : ''}`}
                  style={{ borderTop: idx ? '1px solid var(--line-soft)' : 0 }}
                >
                  {selectMode ? (
                    <div
                      className="mt-0.5 flex-shrink-0 flex items-center justify-center"
                      style={{
                        width: 16, height: 16, borderRadius: 5,
                        border: '1.5px solid ' + (isSelected ? 'var(--c-accent)' : 'var(--line-strong)'),
                        background: isSelected ? 'var(--c-accent)' : 'transparent',
                        transition: 'background 0.14s, border-color 0.14s',
                      }}
                    >
                      {isSelected && (
                        <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                          <path d="M2 5L4 7L8 3" stroke="var(--c-accent-ink)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      )}
                    </div>
                  ) : (
                    <span
                      className="flex-shrink-0"
                      style={{
                        width: 28, height: 28, borderRadius: 8,
                        background: tone.bg, color: tone.fg,
                        display: 'grid', placeItems: 'center',
                      }}
                    >
                      <Icon size={14} />
                    </span>
                  )}
                  <div className="flex-1 min-w-0">
                    <div
                      className="truncate block"
                      style={{
                        fontSize: 12.5,
                        color: 'var(--ink)',
                        fontFamily: 'var(--sans)',
                      }}
                    >
                      {page.title}
                    </div>
                    <div className="flex items-center gap-1.5 mt-0.5" style={{ fontFamily: 'var(--mono)', fontSize: 10 }}>
                      <span style={{ color: tone.fg, opacity: 0.85 }}>
                        {getTypeLabel(page.type, t)}
                      </span>
                      <span className="kz-text-faint">·</span>
                      <StatusBadge page={page} />
                    </div>
                  </div>
                </button>
              );
            })
          )}
        </div>

        {/* Unified bottom toolbar — 查重 · 选择 · [删除 N | 重建] */}
        <DuplicatePanel
          pages={pages}
          selectMode={selectMode}
          selectedIds={selectedIds}
          onToggleSelectMode={handleToggleSelectMode}
          onToggleSelection={handleToggleSelection}
          onMergeComplete={handleMergeComplete}
          rightSlot={
            selectMode && selectedIds.size > 0 ? (
              <button
                onClick={() => {
                  if (confirm(
                    (t.knowledge?.delete_confirm_batch || 'Delete {count} selected pages?')
                      .replace('{count}', String(selectedIds.size))
                  )) {
                    handleBatchDelete();
                  }
                }}
                disabled={deleting}
                className="kz-btn kz-btn--sm kz-btn--danger"
              >
                <Trash2 size={11} />
                {(t.knowledge?.delete_batch || 'Delete {count}').replace('{count}', String(selectedIds.size))}
              </button>
            ) : stats.total > 0 ? (
              <button
                onClick={handleRebuildAll}
                disabled={rebuildingAll}
                className="kz-btn kz-btn--primary kz-btn--sm"
              >
                {rebuildingAll ? (
                  <Loader2 size={11} className="animate-spin" />
                ) : (
                  <RefreshCw size={11} />
                )}
                {t.knowledge?.rebuild_all || 'Rebuild All'}
              </button>
            ) : null
          }
        />
      </div>

      {/* ─── Center Content ───────────────────────────────── */}
      <div className="flex-1 overflow-y-auto" style={{ background: 'var(--bg)' }}>
        {!selectedPage ? (
          /* ─── Knowledge Overview ───
             Grid with a trailing 1fr row so short content still pushes a footer
             line to the viewport bottom, while long content (272 rows) keeps
             its natural height and scrolls under the outer overflow-y-auto. */
          <div
            className="max-w-3xl mx-auto px-8"
            style={{ height: '100%', display: 'flex', flexDirection: 'column', paddingTop: 32, paddingBottom: 24 }}
          >
            {/* Page header */}
            <div className="kz-ph" style={{ flexShrink: 0 }}>
              <div>
                <div className="kz-ph__title">{t.knowledge?.overview_title || '知识图谱'}</div>
                <div className="kz-ph__sub">
                  {t.knowledge?.overview_sub || 'Agent 从录音里自动抽出的人物、主题、项目和概念。'}
                </div>
              </div>
              {stats.total > 0 && (
                <div className="kz-ph__right">
                  <button
                    onClick={handleRebuildAll}
                    disabled={rebuildingAll}
                    className="kz-btn kz-btn--sm"
                    title={t.knowledge?.rebuild_all || 'Rebuild All'}
                  >
                    {rebuildingAll ? (
                      <Loader2 size={12} className="animate-spin" />
                    ) : (
                      <RefreshCw size={12} />
                    )}
                    {t.knowledge?.rebuild_all || 'Rebuild All'}
                  </button>
                </div>
              )}
            </div>

            {/* 2×2 stat cards — large, prominent */}
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: '1fr 1fr',
                gap: 14,
                marginBottom: 20,
                flexShrink: 0,
              }}
            >
              {(['person', 'topic', 'project', 'concept'] as const).map((type) => {
                const Icon = getTypeIcon(type);
                const tone = getTypeTone(type);
                const count = stats[type] || 0;
                return (
                  <button
                    key={type}
                    onClick={() => { setTypeFilter(type); }}
                    className="kz-paper text-left"
                    style={{
                      padding: 22,
                      display: 'flex',
                      alignItems: 'center',
                      gap: 16,
                      transition: 'transform 0.14s, box-shadow 0.14s',
                      cursor: 'pointer',
                    }}
                  >
                    <span
                      style={{
                        width: 44, height: 44, borderRadius: 12,
                        background: tone.bg, color: tone.fg,
                        display: 'grid', placeItems: 'center',
                        flexShrink: 0,
                      }}
                    >
                      <Icon size={20} />
                    </span>
                    <div>
                      <div className="kz-num-display" style={{ fontSize: 28, color: 'var(--ink)', lineHeight: 1 }}>
                        {count}
                      </div>
                      <div className="kz-text-mute" style={{ fontSize: 12, marginTop: 4 }}>
                        {getTypeLabel(type, t)}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>

            {/* Knowledge graph — fills the remaining height down to the page bottom */}
            {pages.length > 0 ? (
              <>
                <h3 className="kz-section-title" style={{ marginBottom: 12, flexShrink: 0 }}>
                  <span>{t.knowledge?.graph_title || '知识图谱'}</span>
                  <span className="kz-section-title__count">
                    {graphData.nodes.length} · {graphData.edges.length}
                  </span>
                </h3>
                <div style={{ flex: 1, minHeight: 0 }}>
                  <PageGraph graph={graphData} onSelectPage={selectPage} />
                </div>
              </>
            ) : (
              <div className="kz-empty" style={{ flex: 1 }}>
                <div className="kz-empty__icon">
                  <Sparkles size={20} />
                </div>
                <div>
                  <div className="kz-empty__title">{t.knowledge?.empty_title || '知识图谱还是空的'}</div>
                  <div className="kz-empty__sub" style={{ marginTop: 6 }}>
                    {t.knowledge?.empty_sub || '处理一些录音后，Agent 会自动抽取人物、主题、项目和概念。'}
                  </div>
                </div>
                {stats.total === 0 && (
                  <div className="kz-empty__actions">
                    <button
                      onClick={handleRebuildAll}
                      disabled={rebuildingAll}
                      className="kz-btn kz-btn--primary"
                    >
                      {rebuildingAll ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
                      {t.knowledge?.rebuild_all || 'Rebuild All'}
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        ) : (
          <div className="max-w-3xl mx-auto py-8 px-8">

            {/* ═══ EDIT MODE ═══ */}
            {editing ? (
              <>
                {/* Sticky save bar */}
                <div
                  className="sticky top-0 z-20 -mx-8 px-8 py-3 mb-6 flex items-center justify-between"
                  style={{
                    background: 'color-mix(in oklch, var(--c-accent) 8%, var(--bg))',
                    backdropFilter: 'blur(6px)',
                    borderBottom: '1px solid color-mix(in oklch, var(--c-accent) 25%, transparent)',
                    boxShadow: 'inset 3px 0 0 var(--c-accent)',
                  }}
                >
                  <div className="flex items-center gap-3">
                    <Pencil size={12} style={{ color: 'var(--c-accent)' }} />
                    <span className="kz-serif-italic" style={{ fontSize: 12, color: 'var(--c-accent)' }}>
                      {t.knowledge?.edit_content || 'Edit Content'}
                    </span>
                    <span className="kz-text-mute" style={{ fontFamily: 'var(--mono)', fontSize: 10.5 }}>
                      / {editType} / {editTitle}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <button onClick={cancelEdit} className="kz-btn kz-btn--ghost kz-btn--sm">
                      {t.knowledge?.edit_cancel || 'Cancel'}
                    </button>
                    <button
                      onClick={saveEdit}
                      disabled={saving}
                      className="kz-btn kz-btn--primary kz-btn--sm"
                    >
                      {saving ? <Loader2 size={11} className="animate-spin" /> : <Check size={11} />}
                      {t.knowledge?.edit_save || 'Save'}
                    </button>
                  </div>
                </div>

                {/* Title + Type editor */}
                <div className="mb-5 space-y-3">
                  <input
                    type="text"
                    value={editTitle}
                    onChange={(e) => setEditTitle(e.target.value)}
                    className="w-full bg-transparent px-0 py-2 focus:outline-none transition-colors"
                    style={{
                      fontFamily: 'var(--serif)',
                      fontSize: 24,
                      letterSpacing: '-0.02em',
                      color: 'var(--ink)',
                      borderBottom: '2px solid var(--line)',
                    }}
                    placeholder={t.knowledge?.edit_title || 'Title'}
                  />
                  <div className="flex items-center gap-3">
                    <span className="kz-serif-italic kz-text-mute" style={{ fontSize: 11 }}>
                      {t.knowledge?.edit_type || 'Type'}
                    </span>
                    <div className="flex gap-1">
                      {(['person', 'topic', 'project', 'concept'] as const).map((tp) => {
                        const tone = getTypeTone(tp);
                        const isActive = editType === tp;
                        return (
                          <button
                            key={tp}
                            onClick={() => setEditType(tp)}
                            className={`kz-chip ${isActive ? '' : 'kz-chip--outline'}`}
                            style={isActive ? { background: tone.bg, color: tone.fg } : undefined}
                          >
                            {getTypeLabel(tp, t)}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>

                {/* Markdown editor — light theme, clean */}
                <div className="kz-paper">
                  <div
                    className="px-4 py-2 flex items-center justify-between"
                    style={{ borderBottom: '1px solid var(--line-soft)' }}
                  >
                    <span className="kz-serif-italic kz-text-mute" style={{ fontSize: 11 }}>Markdown</span>
                    <span className="kz-mono kz-text-faint" style={{ fontSize: 10.5 }}>
                      {editContent.length} chars
                    </span>
                  </div>
                  <textarea
                    value={editContent}
                    onChange={(e) => setEditContent(e.target.value)}
                    className="w-full min-h-[500px] p-5 resize-y focus:outline-none"
                    style={{
                      fontFamily: 'var(--mono)',
                      fontSize: 13,
                      color: 'var(--ink)',
                      background: 'var(--bg-card)',
                      lineHeight: 1.9,
                      border: 0,
                    }}
                    placeholder="Markdown content..."
                    spellCheck={false}
                  />
                </div>
              </>
            ) : (
              <>
                {/* ═══ VIEW MODE ═══ */}

                {/* Back to overview */}
                <button
                  onClick={() => setSelectedPage(null)}
                  className="kz-btn kz-btn--ghost kz-btn--sm"
                  style={{ marginBottom: 14 }}
                >
                  <ArrowLeft size={13} />
                  {t.knowledge?.back_to_overview || '返回总览'}
                </button>

                {/* ─── Hero header ─── */}
                {(() => {
                  const tone = getTypeTone(selectedPage.type);
                  const HeroIcon = getTypeIcon(selectedPage.type);
                  return (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 22 }}>
                      <span
                        style={{
                          width: 56, height: 56, borderRadius: 16,
                          background: tone.bg, color: tone.fg,
                          display: 'grid', placeItems: 'center',
                          flexShrink: 0,
                        }}
                      >
                        <HeroIcon size={26} />
                      </span>
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <h1
                          className="kz-serif"
                          style={{ fontSize: 28, lineHeight: 1.15, letterSpacing: '-0.02em', color: 'var(--ink)', margin: 0 }}
                        >
                          {selectedPage.title}
                        </h1>
                        <div className="kz-text-mute" style={{ fontSize: 12, marginTop: 4 }}>
                          <span className="kz-serif-italic">{getTypeLabel(selectedPage.type, t)}</span>
                          <span> · </span>
                          <span className="kz-mono">{selectedPage.compilation_count || 0}</span>
                          <span>{t.knowledge?.compile_unit_short || ' 次编译'}</span>
                          <span> · </span>
                          <span>{t.knowledge?.last_compiled || '最近 '}</span>
                          <span className="kz-mono">{formatDate(selectedPage.updated_at)}</span>
                        </div>
                      </div>
                      <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                        <button
                          onClick={enterEditMode}
                          className="kz-btn kz-btn--sm"
                          title={t.knowledge?.edit || 'Edit'}
                        >
                          <Pencil size={12} />
                          {t.knowledge?.edit || '编辑'}
                        </button>
                        <button
                          onClick={handleRecompile}
                          disabled={recompiling}
                          className="kz-btn kz-btn--sm"
                          title={t.knowledge?.recompile || 'Recompile'}
                        >
                          {recompiling ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
                          {t.knowledge?.recompile || '重编译'}
                        </button>
                        <button
                          onClick={() => setShowGraph(!showGraph)}
                          className={`kz-btn kz-btn--sm ${showGraph ? 'kz-btn--primary' : ''}`}
                          style={{ padding: '0 10px' }}
                          title={t.knowledge?.graph_title || 'Knowledge Graph'}
                        >
                          <Network size={12} />
                        </button>
                      </div>
                    </div>
                  );
                })()}

                {/* Tags inline */}
                {selectedPage.tags && selectedPage.tags !== '[]' && (
                  <div className="flex flex-wrap gap-1" style={{ marginBottom: 18 }}>
                    {(JSON.parse(selectedPage.tags) as string[]).map((tag) => (
                      <span key={tag} className="kz-badge kz-badge--mute">
                        #{tag}
                      </span>
                    ))}
                  </div>
                )}

                {/* Summary as italic intro */}
                {selectedPage.summary && (
                  <div
                    className="kz-prose"
                    style={{ fontSize: 14, color: 'var(--ink-soft)', fontStyle: 'italic', fontFamily: 'var(--serif)', maxWidth: 'none', marginBottom: 18, lineHeight: 1.7 }}
                  >
                    <Markdown remarkPlugins={[remarkGfm]}>{selectedPage.summary}</Markdown>
                  </div>
                )}

                {/* ─── Content — editorial prose, no card wrapper ─── */}
                {selectedPage.content_markdown ? (
                  <div className="kz-prose" style={{ maxWidth: 'none' }}>
                    <Markdown remarkPlugins={[remarkGfm]}>{selectedPage.content_markdown}</Markdown>
                  </div>
                ) : (
                  <p className="kz-text-mute kz-serif-italic" style={{ fontSize: 13, padding: '24px 0', textAlign: 'center' }}>
                    {t.knowledge?.no_content || 'No content yet — recompile to generate'}
                  </p>
                )}

                {/* ─── Related: Links + Backlinks ─── */}
                {hasLinks && (
                  <div className="mt-6 pt-5 space-y-4">
                    {/* Links → */}
                    {links.length > 0 && (
                      <div>
                        <h3 className="kz-section-title">
                          <ArrowRight size={11} className="kz-text-faint" />
                          <span>{t.knowledge?.links || 'Links'}</span>
                          <span className="kz-section-title__count">{links.length}</span>
                        </h3>
                        <div className="flex flex-wrap gap-1.5">
                          {links.map((link) => (
                            <LinkChip
                              key={link.id}
                              slug={link.to_slug || ''}
                              title={link.to_title || link.to_slug || ''}
                              type={link.to_type || 'topic'}
                            />
                          ))}
                        </div>
                      </div>
                    )}

                    {/* ← Backlinks */}
                    {backlinks.length > 0 && (
                      <div>
                        <h3 className="kz-section-title">
                          <ArrowLeft size={11} className="kz-text-faint" />
                          <span>{t.knowledge?.backlinks || 'Backlinks'}</span>
                          <span className="kz-section-title__count">{backlinks.length}</span>
                        </h3>
                        <div className="flex flex-wrap gap-1.5">
                          {backlinks.map((link) => (
                            <LinkChip
                              key={link.id}
                              slug={link.from_slug || ''}
                              title={link.from_title || link.from_slug || ''}
                              type={link.from_type || 'topic'}
                            />
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* Source Info */}
                {selectedPage.source_recording_ids && selectedPage.source_recording_ids !== '[]' && (
                  <div className="mt-6 pt-4 kz-rule">
                    {t.knowledge?.sources || 'Sources'} · {(t.knowledge?.recordings_count || '{count} recording(s)').replace('{count}', String((JSON.parse(selectedPage.source_recording_ids) as number[]).length))}
                  </div>
                )}

                {/* Danger zone — subtle delete affordance */}
                <div
                  style={{
                    marginTop: 40,
                    paddingTop: 20,
                    borderTop: '1px solid var(--line-soft)',
                    display: 'flex',
                    justifyContent: 'flex-end',
                  }}
                >
                  <button
                    onClick={() => setShowDeleteConfirm(true)}
                    className="kz-btn kz-btn--sm kz-btn--ghost"
                    style={{ color: 'var(--c-danger)' }}
                    title={t.knowledge?.delete || 'Delete'}
                  >
                    <Trash2 size={12} />
                    {t.knowledge?.delete_page || '删除此页'}
                  </button>
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {/* ─── Drag Handle + Right Panel: Knowledge Graph ───── */}
      {showGraph && (
        <>
          {/* Resize handle */}
          <div
            onMouseDown={handlePanelDragStart}
            className="group/drag w-3 flex-shrink-0 cursor-col-resize flex items-center justify-center relative"
          >
            <div
              className="w-px h-full transition-colors"
              style={{ background: 'var(--line)' }}
            />
          </div>
          {/* Graph panel */}
          <div
            style={{ width: graphPanelWidth, background: 'var(--bg)' }}
            className="flex-shrink-0 flex flex-col h-full"
          >
            {/* Graph Header */}
            <div
              className="px-3 py-2.5 flex items-center justify-between flex-shrink-0"
              style={{ borderBottom: '1px solid var(--line-soft)' }}
            >
              <div className="flex items-center gap-2">
                <Network size={12} className="kz-text-soft" />
                <span className="kz-serif-italic" style={{ fontSize: 12.5, color: 'var(--ink-soft)' }}>
                  {t.knowledge?.graph_title || 'Knowledge Graph'}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <span className="kz-mono kz-text-mute" style={{ fontSize: 10.5 }}>
                  {graphData.nodes.length} {t.knowledge?.graph_nodes || 'nodes'} · {graphData.edges.length} {t.knowledge?.graph_edges || 'edges'}
                </span>
                <button
                  onClick={() => setShowGraph(false)}
                  className="kz-btn kz-btn--ghost kz-btn--sm"
                  style={{ padding: '0 6px' }}
                >
                  <X size={12} />
                </button>
              </div>
            </div>
            {/* Graph Body — fills remaining height */}
            <div className="flex-1 p-2 min-h-0">
              <PageGraph
                graph={graphData}
                selectedSlug={selectedPage?.slug}
                onSelectPage={selectPage}
              />
            </div>
          </div>
        </>
      )}

      {/* ─── Delete Confirmation Dialog ─── */}
      {showDeleteConfirm && selectedPage && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'oklch(0 0 0 / 0.2)', backdropFilter: 'blur(2px)' }}>
          <div className="kz-paper w-[400px] kz-anim-in">
            {/* Header with red accent */}
            <div
              className="px-5 py-4"
              style={{ borderBottom: '1px solid var(--line-soft)', background: 'var(--c-danger-bg)' }}
            >
              <div className="flex items-center gap-2.5">
                <div
                  className="flex items-center justify-center"
                  style={{ width: 28, height: 28, borderRadius: 8, background: 'var(--c-danger-bg)', color: 'var(--c-danger)', border: '1px solid var(--c-danger)' }}
                >
                  <AlertTriangle size={13} />
                </div>
                <div>
                  <div className="kz-serif" style={{ fontSize: 15, color: 'var(--ink)' }}>
                    {t.knowledge?.delete_confirm_title || 'Confirm Delete'}
                  </div>
                  <div className="kz-mono kz-text-mute" style={{ fontSize: 10.5, marginTop: 2 }}>{selectedPage.slug}</div>
                </div>
              </div>
            </div>
            {/* Body */}
            <div className="px-5 py-4">
              <p className="kz-text-soft" style={{ fontSize: 12.5 }}>
                {(t.knowledge?.delete_confirm_msg || 'Delete "{title}"? References in other pages will become dead links.')
                  .replace('{title}', selectedPage.title)}
              </p>
              {backlinks.length > 0 && (
                <div className="kz-badge kz-badge--warn mt-3" style={{ padding: '6px 10px' }}>
                  <AlertTriangle size={11} />
                  {(t.knowledge?.backlinks_count || 'Referenced by {count} page(s)')
                    .replace('{count}', String(backlinks.length))}
                </div>
              )}
            </div>
            {/* Actions */}
            <div
              className="px-5 py-3.5 flex justify-end gap-2"
              style={{ borderTop: '1px solid var(--line-soft)', background: 'var(--bg-elev)' }}
            >
              <button onClick={() => setShowDeleteConfirm(false)} className="kz-btn kz-btn--sm">
                {t.knowledge?.edit_cancel || 'Cancel'}
              </button>
              <button
                onClick={handleDelete}
                disabled={deleting}
                className="kz-btn kz-btn--sm"
                style={{ background: 'var(--c-danger)', color: 'var(--bg)', borderColor: 'var(--c-danger)' }}
              >
                {deleting && <Loader2 size={11} className="animate-spin" />}
                {t.knowledge?.delete_btn || 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
