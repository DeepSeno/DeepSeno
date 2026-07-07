import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  Brain, ChevronDown, ChevronRight, RefreshCw,
  Sparkles, Check, X, Trash2, ArrowUp, ArrowDown, PencilLine,
} from 'lucide-react';
import { useI18n } from '../i18n';
import { useApi, type MemoryRow, type MemoryStats, type MemoryDocument, type MemoryDateEntry } from '../hooks/useApi';
import { useNotifications } from '../components/NotificationCenter';
import MarkdownSplitEditor from '../components/MarkdownSplitEditor';

// ─── Module-level generation tracker ─────────────────────
// Survives component unmount/remount so in-flight generation isn't lost
const pendingGenerations = new Map<string, Promise<{ content: string }>>();

// ─── Types ───────────────────────────────────────────────
type ViewMode = 'documents' | 'facts';
type LayerFilter = 'all' | 'core' | 'active' | 'archive';
type CategoryFilter = 'all' | 'person' | 'business' | 'preference' | 'relationship' | 'general';

// ─── Helpers ─────────────────────────────────────────────
function formatDate(dateStr: string): string {
  if (!dateStr) return '--';
  try {
    const d = new Date(dateStr);
    const m = d.getMonth() + 1;
    const day = d.getDate();
    return `${m}/${day}`;
  } catch {
    return dateStr;
  }
}

const WEEKDAYS_ZH = ['日', '一', '二', '三', '四', '五', '六'];
const WEEKDAYS_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function getWeekday(dateStr: string, lang: string): string {
  const d = new Date(dateStr + 'T00:00:00');
  const day = d.getDay();
  return lang === 'zh' ? `周${WEEKDAYS_ZH[day]}` : WEEKDAYS_EN[day];
}

function formatMonthLabel(monthKey: string, lang: string): string {
  const [year, month] = monthKey.split('-');
  if (lang === 'zh') return `${year}年${parseInt(month)}月`;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[parseInt(month) - 1]} ${year}`;
}

// ═════════════════════════════════════════════════════════
// Main Component
// ═════════════════════════════════════════════════════════
export default function MemoryManager() {
  const { t, lang } = useI18n();
  const api = useApi();
  const { toast } = useNotifications();
  const mt = t.memory;

  // ── View mode ────────────────────────────────────────
  const [viewMode, setViewMode] = useState<ViewMode>('documents');
  const [loading, setLoading] = useState(true);

  // ── Document view state ──────────────────────────────
  const [dates, setDates] = useState<MemoryDateEntry[]>([]);
  const [selectedDate, setSelectedDate] = useState<string>('');
  const [document, setDocument] = useState<MemoryDocument | null>(null);
  const [docContent, setDocContent] = useState('');
  const [generating, setGenerating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [lastSaved, setLastSaved] = useState<string | null>(null);
  const [draftOpen, setDraftOpen] = useState(false);
  const [confirmRegenerate, setConfirmRegenerate] = useState(false);

  // Sidebar collapse state: map of "YYYY-MM" -> boolean (true = collapsed)
  const [collapsedMonths, setCollapsedMonths] = useState<Record<string, boolean>>({});

  // ── Fact view state ──────────────────────────────────
  const [memories, setMemories] = useState<MemoryRow[]>([]);
  const [stats, setStats] = useState<MemoryStats>({ core: 0, active: 0, archive: 0 });
  const [layerFilter, setLayerFilter] = useState<LayerFilter>('all');
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>('all');

  // Edit state
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editText, setEditText] = useState('');
  const editRef = useRef<HTMLInputElement>(null);

  // Delete confirmation
  const [deleteConfirmId, setDeleteConfirmId] = useState<number | null>(null);

  // ── Today's date ─────────────────────────────────────
  const today = useMemo(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }, []);

  // ── Data loading ─────────────────────────────────────
  const loadDates = useCallback(async () => {
    try {
      const result = await api.memoryGetDocumentDates();
      setDates(result || []);
    } catch { setDates([]); }
  }, [api]);

  const loadDocument = useCallback(async (date: string) => {
    try {
      const doc = await api.memoryGetDocument(date);
      setDocument(doc);
      setDocContent(doc?.content || '');
      setDraftOpen(false);
      setConfirmRegenerate(false);
      setLastSaved(null);
    } catch {
      setDocument(null);
      setDocContent('');
      setDraftOpen(false);
      setConfirmRegenerate(false);
    }
  }, [api]);

  const loadStats = useCallback(async () => {
    try {
      const [memStats, allMem] = await Promise.all([api.memoryGetStats(), api.memoryGetAll()]);
      setStats(memStats || { core: 0, active: 0, archive: 0 });
      setMemories(allMem || []);
    } catch {}
    setLoading(false);
  }, [api]);

  // ── Initial load ─────────────────────────────────────
  useEffect(() => {
    loadDates();
    loadStats();
  }, [loadDates, loadStats]);

  // Auto-select today
  useEffect(() => {
    if (!selectedDate && dates.length >= 0) {
      setSelectedDate(today);
    }
  }, [dates, today, selectedDate]);

  // Load document when date changes
  useEffect(() => {
    if (selectedDate) loadDocument(selectedDate);
  }, [selectedDate, loadDocument]);

  // Focus edit input when entering edit mode
  useEffect(() => {
    if (editingId !== null && editRef.current) {
      editRef.current.focus();
      editRef.current.select();
    }
  }, [editingId]);

  // ── Debounced auto-save ──────────────────────────────
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleContentChange = useCallback((newContent: string) => {
    setDraftOpen(true);
    setConfirmRegenerate(false);
    setDocContent(newContent);
    setLastSaved(null);
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(async () => {
      setSaving(true);
      try {
        await api.memorySaveDocument(selectedDate, newContent);
        setDocument((prev) => ({
          id: prev?.id ?? 0,
          date: selectedDate,
          content: newContent,
          auto_generated: 0,
          updated_at: '',
        }));
        setLastSaved(new Date().toLocaleTimeString());
        await loadDates();
      } catch { /* ignore */ }
      setSaving(false);
    }, 1000);
  }, [selectedDate, api, loadDates]);

  const handleStartBlank = useCallback(() => {
    handleContentChange('');
  }, [handleContentChange]);

  // ── Generate / Regenerate ────────────────────────────
  const handleGenerate = useCallback(async () => {
    setConfirmRegenerate(false);
    setGenerating(true);
    const date = selectedDate;
    // Create or reuse pending generation promise
    let promise = pendingGenerations.get(date);
    if (!promise) {
      promise = api.memoryGenerateDocument(date);
      pendingGenerations.set(date, promise);
    }
    try {
      const result = await promise;
      setDocContent(result.content);
      setDocument({ id: 0, date, content: result.content, auto_generated: 1, updated_at: '' });
      setDraftOpen(false);
      setLastSaved(new Date().toLocaleTimeString());
      await loadDates();
    } catch {} finally {
      pendingGenerations.delete(date);
      setGenerating(false);
    }
  }, [api, selectedDate, loadDates]);

  // On mount/date change: reconnect to in-flight generation
  useEffect(() => {
    if (!selectedDate) return;
    const pending = pendingGenerations.get(selectedDate);
    if (!pending) return;
    let cancelled = false;
    setGenerating(true);
    pending.then(async (result) => {
      if (cancelled) return;
      setDocContent(result.content);
      setDocument({ id: 0, date: selectedDate, content: result.content, auto_generated: 1, updated_at: '' });
      setDraftOpen(false);
      setLastSaved(new Date().toLocaleTimeString());
      await loadDates();
    }).catch((err) => {
      console.error('[MemoryManager] Document generation failed:', err);
    }).finally(() => {
      if (cancelled) return;
      pendingGenerations.delete(selectedDate);
      setGenerating(false);
    });
    return () => { cancelled = true; };
  }, [selectedDate, loadDates]);

  const handleRegenerate = useCallback(() => {
    if (generating) return;
    if (document || draftOpen || docContent.trim()) {
      setConfirmRegenerate(true);
      return;
    }
    void handleGenerate();
  }, [docContent, document, draftOpen, generating, handleGenerate]);

  const handleConfirmRegenerate = useCallback(async () => {
    setConfirmRegenerate(false);
    await handleGenerate();
  }, [handleGenerate]);

  const hasDocumentSurface = Boolean(document || draftOpen || docContent);

  // ── Sidebar: group dates by month ────────────────────
  const datesByMonth = useMemo(() => {
    const dateSet = new Set(dates.map(d => d.date));
    const allEntries: MemoryDateEntry[] = dateSet.has(today)
      ? dates
      : [{ date: today, has_recordings: false, recording_count: 0 }, ...dates];

    const groups: Record<string, MemoryDateEntry[]> = {};
    for (const entry of allEntries) {
      const monthKey = entry.date.substring(0, 7);
      if (!groups[monthKey]) groups[monthKey] = [];
      groups[monthKey].push(entry);
    }

    return Object.entries(groups)
      .sort(([a], [b]) => b.localeCompare(a))
      .map(([monthKey, entries], idx) => ({
        monthKey,
        label: formatMonthLabel(monthKey, lang),
        entries: entries.sort((a, b) => b.date.localeCompare(a.date)),
        isFirst: idx === 0,
      }));
  }, [dates, today, lang]);

  const toggleMonth = useCallback((monthKey: string) => {
    setCollapsedMonths(prev => ({ ...prev, [monthKey]: !prev[monthKey] }));
  }, []);

  const isMonthCollapsed = useCallback((monthKey: string, isFirst: boolean) => {
    if (collapsedMonths[monthKey] !== undefined) return collapsedMonths[monthKey];
    // Default: first month open, others collapsed
    return !isFirst;
  }, [collapsedMonths]);

  // ── Fact management ──────────────────────────────────
  const filtered = memories.filter((m) => {
    if (layerFilter !== 'all' && m.layer !== layerFilter) return false;
    if (categoryFilter !== 'all' && m.category !== categoryFilter) return false;
    return true;
  });

  const layerOrder: Record<string, number> = { core: 0, active: 1, archive: 2 };
  const sorted = [...filtered].sort((a, b) => {
    const layerDiff = (layerOrder[a.layer] ?? 3) - (layerOrder[b.layer] ?? 3);
    if (layerDiff !== 0) return layerDiff;
    return new Date(b.last_seen).getTime() - new Date(a.last_seen).getTime();
  });

  const handlePromote = async (id: number, currentLayer: string, direction: 'up' | 'down') => {
    const order = ['archive', 'active', 'core'];
    const idx = order.indexOf(currentLayer);
    const newIdx = direction === 'up' ? idx + 1 : idx - 1;
    if (newIdx < 0 || newIdx >= order.length) return;
    const newLayer = order[newIdx];
    try {
      await api.memoryPromote(id, newLayer);
      await loadStats();
    } catch {
      toast('error', t.common.save_failed);
    }
  };

  const handleDelete = async (id: number) => {
    try {
      await api.memoryDelete(id);
      setDeleteConfirmId(null);
      await loadStats();
    } catch {
      toast('error', t.common.save_failed);
    }
  };

  const handleEditSave = async () => {
    if (editingId === null) return;
    const trimmed = editText.trim();
    if (!trimmed) return;
    try {
      await api.memoryUpdate(editingId, trimmed);
      setEditingId(null);
      setEditText('');
      await loadStats();
    } catch {
      toast('error', t.common.save_failed);
    }
  };

  const handleEditCancel = () => {
    setEditingId(null);
    setEditText('');
  };

  const startEdit = (mem: MemoryRow) => {
    setEditingId(mem.id);
    setEditText(mem.fact);
  };

  // ── Layer / Category filter config ───────────────────
  const layerTabs: { key: LayerFilter; label: string }[] = [
    { key: 'all', label: mt.filter_all },
    { key: 'core', label: mt.stats_core },
    { key: 'active', label: mt.stats_active },
    { key: 'archive', label: mt.stats_archive },
  ];

  const categories: CategoryFilter[] = ['all', 'person', 'business', 'preference', 'relationship', 'general'];
  const categoryLabels: Record<CategoryFilter, string> = {
    all: mt.category_all,
    person: mt.category_person,
    business: mt.category_business,
    preference: mt.category_preference,
    relationship: mt.category_relationship,
    general: mt.category_general,
  };

  const total = stats.core + stats.active + stats.archive;

  // ── Loading state ────────────────────────────────────
  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <RefreshCw size={16} className="animate-spin kz-text-mute mr-2" />
        <span className="text-sm kz-text-mute">{t.common.loading}</span>
      </div>
    );
  }

  // ═════════════════════════════════════════════════════
  // RENDER
  // ═════════════════════════════════════════════════════
  return (
    <div className="flex h-full" style={{ background: 'var(--bg)' }}>
      {/* ─── Left Sidebar ─── */}
      <div
        className="w-60 flex-shrink-0 flex flex-col"
        style={{ borderRight: '1px solid var(--line)', background: 'var(--bg)' }}
      >
        {/* View mode toggle — kz-tabs */}
        <div className="p-3" style={{ borderBottom: '1px solid var(--line-soft)' }}>
          <div className="kz-tabs kz-tabs--sm">
            <button
              onClick={() => setViewMode('documents')}
              className={viewMode === 'documents' ? 'is-on' : ''}
            >
              {mt.view_documents}
            </button>
            <button
              onClick={() => setViewMode('facts')}
              className={viewMode === 'facts' ? 'is-on' : ''}
            >
              {mt.view_facts}
            </button>
          </div>
        </div>

        {viewMode === 'documents' ? (
          <>
            {/* Date list by month — kz-card-soft container */}
            <div className="flex-1 overflow-y-auto kz-card-soft" style={{ margin: 10, padding: '8px 6px', borderRadius: 10 }}>
              {datesByMonth.map(group => {
                const collapsed = isMonthCollapsed(group.monthKey, group.isFirst);
                return (
                  <div key={group.monthKey} style={{ marginBottom: 6 }}>
                    <button
                      onClick={() => toggleMonth(group.monthKey)}
                      className="kz-row-hover"
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        width: '100%',
                        padding: '8px 10px',
                        borderRadius: 6,
                      }}
                    >
                      {collapsed ? <ChevronRight size={11} /> : <ChevronDown size={11} />}
                      <span className="kz-serif-italic kz-text-soft" style={{ fontSize: 12.5 }}>{group.label}</span>
                    </button>
                    {!collapsed && group.entries.map(entry => {
                      const dayNum = parseInt(entry.date.split('-')[2]);
                      const weekday = getWeekday(entry.date, lang);
                      const isSelected = entry.date === selectedDate;
                      const isToday = entry.date === today;
                      return (
                        <button
                          key={entry.date}
                          onClick={() => setSelectedDate(entry.date)}
                          className={isSelected ? 'kz-row-selected' : 'kz-row-hover'}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 10,
                            width: '100%',
                            padding: '7px 12px 7px 24px',
                            borderRadius: 6,
                            color: 'var(--ink)',
                          }}
                        >
                          <span
                            className="kz-num-display"
                            style={{
                              fontSize: 17,
                              width: 26,
                              textAlign: 'right',
                              color: isToday ? 'var(--c-accent)' : 'var(--ink)',
                            }}
                          >
                            {dayNum}
                          </span>
                          <span className="kz-text-mute" style={{ fontSize: 11.5 }}>{weekday}</span>
                          <span className="ml-auto flex items-center gap-1.5">
                            {isToday && (
                              <span className="kz-badge kz-badge--success">
                                {mt.today}
                              </span>
                            )}
                            {entry.recording_count > 0 && (
                              <span className="kz-mono kz-text-faint" style={{ fontSize: 11 }}>
                                {entry.recording_count}
                              </span>
                            )}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                );
              })}
            </div>

            {/* Bottom stats — 三层架构 */}
            <div className="p-4" style={{ borderTop: '1px solid var(--line-soft)' }}>
              <div className="kz-serif-italic kz-text-mute" style={{ fontSize: 11, marginBottom: 8 }}>
                {mt.title}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {[
                  { label: mt.stats_core, n: stats.core, tone: 'accent' },
                  { label: mt.stats_active, n: stats.active, tone: 'info' },
                  { label: mt.stats_archive, n: stats.archive, tone: 'mute' },
                ].map(r => (
                  <div key={r.label} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '4px 0' }}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
                      <span className={'kz-sdot kz-sdot--' + r.tone} />
                      {r.label}
                    </span>
                    <span className="kz-num-display" style={{ fontSize: 16, color: 'var(--ink)' }}>{r.n}</span>
                  </div>
                ))}
              </div>
            </div>
          </>
        ) : (
          /* Facts sidebar */
          <div className="flex-1 flex flex-col overflow-y-auto">
            {/* Layer filter — kz-card-soft */}
            <div className="kz-card-soft" style={{ margin: '10px 10px 6px', padding: '10px 8px' }}>
              <div className="kz-serif-italic kz-text-mute" style={{ fontSize: 12, marginBottom: 8, paddingLeft: 4 }}>
                {mt.table_layer}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                {layerTabs.map(tab => {
                  const dotTone = tab.key === 'core' ? 'accent' : tab.key === 'active' ? 'info' : tab.key === 'archive' ? 'mute' : null;
                  return (
                    <button
                      key={tab.key}
                      onClick={() => setLayerFilter(tab.key)}
                      className={layerFilter === tab.key ? 'kz-row-selected' : 'kz-row-hover'}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        padding: '7px 12px',
                        borderRadius: 6,
                        fontSize: 12.5,
                      }}
                    >
                      <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        {dotTone && <span className={'kz-sdot kz-sdot--' + dotTone} />}
                        <span>{tab.label}</span>
                      </span>
                      <span className="kz-mono kz-text-faint" style={{ fontSize: 11 }}>
                        {tab.key === 'all' ? total : tab.key === 'core' ? stats.core : tab.key === 'active' ? stats.active : stats.archive}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Category filter — kz-card-soft */}
            <div className="kz-card-soft" style={{ margin: '0 10px 10px', padding: '10px 8px' }}>
              <div className="kz-serif-italic kz-text-mute" style={{ fontSize: 12, marginBottom: 8, paddingLeft: 4 }}>
                {mt.table_category}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                {categories.map(cat => (
                  <button
                    key={cat}
                    onClick={() => setCategoryFilter(cat)}
                    className={categoryFilter === cat ? 'kz-row-selected' : 'kz-row-hover'}
                    style={{
                      display: 'block',
                      width: '100%',
                      textAlign: 'left',
                      padding: '7px 12px',
                      borderRadius: 6,
                      fontSize: 12.5,
                    }}
                  >
                    {categoryLabels[cat]}
                  </button>
                ))}
              </div>
            </div>

            {/* Bottom stats — 三层架构 */}
            <div className="mt-auto p-4" style={{ borderTop: '1px solid var(--line-soft)' }}>
              <div className="kz-serif-italic kz-text-mute" style={{ fontSize: 11, marginBottom: 8 }}>
                {mt.title}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {[
                  { label: mt.stats_core, n: stats.core, tone: 'accent' },
                  { label: mt.stats_active, n: stats.active, tone: 'info' },
                  { label: mt.stats_archive, n: stats.archive, tone: 'mute' },
                ].map(r => (
                  <div key={r.label} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '4px 0' }}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
                      <span className={'kz-sdot kz-sdot--' + r.tone} />
                      {r.label}
                    </span>
                    <span className="kz-num-display" style={{ fontSize: 16, color: 'var(--ink)' }}>{r.n}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ─── Main Content Area ─── */}
      <div className="flex-1 flex flex-col min-w-0">
        {viewMode === 'documents' ? (
          /* ── Document View ── */
          <>
            {/* Header bar — editorial: date serif + today badge + facts/talk meta + actions */}
            <div
              className="flex items-center justify-between px-6 py-3"
              style={{ borderBottom: '1px solid var(--line-soft)' }}
            >
              <div className="flex items-center gap-3 min-w-0">
                <span className="kz-serif" style={{ fontSize: 22, letterSpacing: '-0.015em' }}>
                  {(() => {
                    const parts = selectedDate.split('-');
                    const m = parseInt(parts[1]);
                    const d = parseInt(parts[2]);
                    return lang === 'zh' ? `${m} 月 ${d} 日` : `${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][m-1]} ${d}`;
                  })()}
                </span>
                <span className="kz-serif-italic kz-text-mute" style={{ fontSize: 13 }}>
                  {getWeekday(selectedDate, lang)}
                </span>
                {selectedDate === today && (
                  <span className="kz-badge kz-badge--success">{mt.today}</span>
                )}
                {document?.auto_generated === 1 && (
                  <span className="kz-badge kz-badge--mute">{mt.auto_label}</span>
                )}
              </div>
              <div className="flex items-center gap-3">
                {(() => {
                  const entry = datesByMonth
                    .flatMap(g => g.entries)
                    .find(d => d.date === selectedDate);
                  const recCount = entry?.recording_count || 0;
                  if (recCount > 0) {
                    return (
                      <span className="kz-mono kz-text-faint" style={{ fontSize: 10.5 }}>
                        {recCount} {(mt as any).rec_unit || '条录音'}
                      </span>
                    );
                  }
                  return null;
                })()}
                {saving && (
                  <span className="kz-text-mute" style={{ fontSize: 11 }}>{mt.doc_saving}</span>
                )}
                {!saving && lastSaved && (
                  <span className="kz-badge kz-badge--success">
                    <Check size={10} className="inline mr-0.5" />{lastSaved}
                  </span>
                )}
                {confirmRegenerate ? (
                  <>
                    <button
                      onClick={() => setConfirmRegenerate(false)}
                      className="kz-btn kz-btn--sm"
                    >
                      <X size={11} />
                      {t.common.cancel}
                    </button>
                    <button
                      onClick={handleConfirmRegenerate}
                      disabled={generating}
                      className="kz-btn kz-btn--sm kz-btn--primary"
                      style={{ opacity: generating ? 0.5 : 1 }}
                    >
                      <RefreshCw size={11} className={generating ? 'animate-spin' : ''} />
                      {mt.doc_regenerate}
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      onClick={handleRegenerate}
                      disabled={generating}
                      className="kz-btn kz-btn--sm"
                      style={{ opacity: generating ? 0.5 : 1 }}
                    >
                      {generating
                        ? <RefreshCw size={11} className="animate-spin" />
                        : hasDocumentSurface ? <RefreshCw size={11} /> : <Sparkles size={11} />
                      }
                      {hasDocumentSurface ? mt.doc_regenerate : mt.doc_generate}
                    </button>
                    <button
                      onClick={handleStartBlank}
                      disabled={generating}
                      className="kz-btn kz-btn--sm"
                      style={{ opacity: generating ? 0.5 : 1 }}
                    >
                      <PencilLine size={11} />
                      {(mt as any).start_blank || '从头开始编辑'}
                    </button>
                  </>
                )}
              </div>
            </div>

            {/* Content area */}
            {!hasDocumentSurface ? (
              /* Empty state — kz-empty */
              <div className="flex-1 flex items-center justify-center">
                <div className="kz-empty">
                  <div className="kz-empty__icon">
                    <Sparkles size={22} />
                  </div>
                  <div>
                    <div className="kz-empty__title">{mt.doc_empty}</div>
                    <div className="kz-empty__sub">{mt.start_writing}</div>
                  </div>
                  <div className="kz-empty__actions">
                    <button
                      onClick={handleGenerate}
                      disabled={generating}
                      className="kz-btn kz-btn--primary"
                      style={{ opacity: generating ? 0.5 : 1 }}
                    >
                      {generating
                        ? <RefreshCw size={12} className="animate-spin" />
                        : <Sparkles size={12} />
                      }
                      {mt.doc_generate}
                    </button>
                    <button
                      onClick={handleStartBlank}
                      className="kz-btn"
                    >
                      <PencilLine size={12} />
                      {(mt as any).start_blank || '从头开始编辑'}
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              /* Read-first editor — no kz-paper wrap so prose flows on the page */
              <div className="flex-1 overflow-hidden flex flex-col">
                <MarkdownSplitEditor
                  value={docContent}
                  onChange={handleContentChange}
                  placeholder={mt.edit_placeholder || 'Start writing...'}
                  className="flex-1"
                  mode="preview"
                />
              </div>
            )}
          </>
        ) : (
          /* ── Facts Table View ── */
          <div className="flex-1 flex flex-col overflow-hidden">
            {/* Facts header */}
            <div
              className="flex items-center justify-between px-5 py-3"
              style={{ borderBottom: '1px solid var(--line-soft)', background: 'var(--bg-elev)' }}
            >
              <div className="flex items-center gap-3">
                <span className="kz-serif" style={{ fontSize: 18 }}>{mt.view_facts}</span>
                <span className="kz-mono kz-text-faint" style={{ fontSize: 11 }}>
                  {sorted.length} / {total}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <span className="kz-badge kz-badge--accent kz-badge--dot">
                  {mt.stats_core}: {stats.core}
                </span>
                <span className="kz-badge kz-badge--info kz-badge--dot">
                  {mt.stats_active}: {stats.active}
                </span>
                <span className="kz-badge kz-badge--mute kz-badge--dot">
                  {mt.stats_archive}: {stats.archive}
                </span>
                <button
                  onClick={() => { setLoading(true); loadStats(); }}
                  className="kz-btn kz-btn--ghost kz-btn--sm"
                  title={mt.refresh}
                  style={{ padding: '0 8px' }}
                >
                  <RefreshCw size={13} />
                </button>
              </div>
            </div>

            {/* Facts table */}
            {sorted.length === 0 ? (
              <div className="flex-1 flex items-center justify-center">
                <div className="kz-empty">
                  <div className="kz-empty__icon">
                    <Brain size={22} />
                  </div>
                  <div>
                    <div className="kz-empty__title">{mt.empty}</div>
                    <div className="kz-empty__sub">{mt.empty_desc}</div>
                  </div>
                </div>
              </div>
            ) : (
              <div className="flex-1 overflow-y-auto p-6">
                <div className="kz-paper" style={{ overflow: 'hidden' }}>
                {/* Table header */}
                <div
                  className="grid grid-cols-[80px_1fr_100px_70px_60px_60px_70px] gap-0 sticky top-0"
                  style={{
                    background: 'var(--bg-elev)',
                    borderBottom: '1px solid var(--line)',
                    padding: '10px 14px',
                    fontFamily: 'var(--mono)',
                    fontSize: 10.5,
                    color: 'var(--ink-mute)',
                    letterSpacing: '0.08em',
                    textTransform: 'uppercase',
                  }}
                >
                  <span>{mt.table_layer}</span>
                  <span>{mt.table_fact}</span>
                  <span>{mt.table_category}</span>
                  <span>{mt.confidence}</span>
                  <span style={{ textAlign: 'center' }}>{mt.mentions}</span>
                  <span>{mt.last_seen}</span>
                  <span style={{ textAlign: 'right' }}>{mt.table_actions}</span>
                </div>

                {/* Rows */}
                {sorted.map((mem) => {
                  const isEditing = editingId === mem.id;
                  const isDeleting = deleteConfirmId === mem.id;
                  const layerTone = mem.layer === 'core' ? 'accent' : mem.layer === 'active' ? 'info' : 'mute';
                  const catLabel = categoryLabels[mem.category as CategoryFilter] || mem.category;

                  return (
                    <div
                      key={mem.id}
                      className="grid grid-cols-[80px_1fr_100px_70px_60px_60px_70px] gap-0 items-center kz-row-hover group"
                      style={{
                        padding: '12px 14px',
                        borderTop: '1px solid var(--line-soft)',
                      }}
                    >
                      {/* Layer badge */}
                      <div className="flex items-center gap-1.5">
                        <span className={'kz-sdot kz-sdot--' + layerTone} />
                        <span className={'kz-badge kz-badge--' + layerTone}>
                          {mem.layer}
                        </span>
                      </div>

                      {/* Fact (editable) */}
                      <div className="min-w-0 pr-2">
                        {isEditing ? (
                          <div className="flex items-center gap-1">
                            <input
                              ref={editRef}
                              type="text"
                              value={editText}
                              onChange={(e) => setEditText(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') handleEditSave();
                                if (e.key === 'Escape') handleEditCancel();
                              }}
                              className="kz-input flex-1"
                              style={{ height: 28, fontSize: 12 }}
                              placeholder={mt.edit_placeholder}
                            />
                            <button
                              onClick={handleEditSave}
                              className="kz-btn kz-btn--ghost kz-btn--sm"
                              style={{ color: 'var(--c-success)', padding: '0 6px' }}
                            >
                              <Check size={12} />
                            </button>
                            <button
                              onClick={handleEditCancel}
                              className="kz-btn kz-btn--ghost kz-btn--sm"
                              style={{ padding: '0 6px' }}
                            >
                              <X size={12} />
                            </button>
                          </div>
                        ) : (
                          <span
                            className="kz-text-ink cursor-pointer truncate block"
                            style={{ fontSize: 13.5 }}
                            onClick={() => startEdit(mem)}
                            title={mem.fact}
                          >
                            {mem.fact}
                          </span>
                        )}
                      </div>

                      {/* Category */}
                      <div>
                        <span className="kz-text-soft" style={{ fontSize: 12 }}>
                          {catLabel}
                        </span>
                      </div>

                      {/* Confidence */}
                      <div className="flex items-center gap-1">
                        <div
                          style={{
                            width: 32,
                            height: 3,
                            background: 'var(--line)',
                            borderRadius: 999,
                            overflow: 'hidden',
                          }}
                        >
                          <div
                            style={{
                              height: '100%',
                              background: 'var(--c-accent)',
                              borderRadius: 999,
                              width: `${Math.round(mem.confidence * 100)}%`,
                            }}
                          />
                        </div>
                        <span className="kz-mono kz-text-mute" style={{ fontSize: 11 }}>
                          {(mem.confidence * 100).toFixed(0)}%
                        </span>
                      </div>

                      {/* Mention count */}
                      <div className="text-center">
                        <span className="kz-mono kz-text-soft" style={{ fontSize: 11 }}>
                          {mem.mention_count}{mt.mentions}
                        </span>
                      </div>

                      {/* Last seen */}
                      <div>
                        <span className="kz-mono kz-text-faint" style={{ fontSize: 11 }}>
                          {formatDate(mem.last_seen)}
                        </span>
                      </div>

                      {/* Actions */}
                      <div className="flex items-center justify-end gap-0.5">
                        {isDeleting ? (
                          <div className="flex items-center gap-1">
                            <button
                              onClick={() => handleDelete(mem.id)}
                              className="kz-btn kz-btn--danger kz-btn--sm"
                              style={{ padding: '0 8px' }}
                              title={t.common.confirm}
                            >
                              <Check size={12} />
                            </button>
                            <button
                              onClick={() => setDeleteConfirmId(null)}
                              className="kz-btn kz-btn--ghost kz-btn--sm"
                              style={{ padding: '0 6px' }}
                              title={t.common.cancel}
                            >
                              <X size={12} />
                            </button>
                          </div>
                        ) : (
                          <>
                            {mem.layer !== 'core' && (
                              <button
                                onClick={() => handlePromote(mem.id, mem.layer, 'up')}
                                className="kz-btn kz-btn--ghost kz-btn--sm opacity-0 group-hover:opacity-100 transition-opacity"
                                style={{ padding: '0 6px' }}
                                title={mem.layer === 'archive' ? mt.promote_active : mt.promote_core}
                              >
                                <ArrowUp size={12} />
                              </button>
                            )}
                            {mem.layer !== 'archive' && (
                              <button
                                onClick={() => handlePromote(mem.id, mem.layer, 'down')}
                                className="kz-btn kz-btn--ghost kz-btn--sm opacity-0 group-hover:opacity-100 transition-opacity"
                                style={{ padding: '0 6px' }}
                                title={mt.demote_archive}
                              >
                                <ArrowDown size={12} />
                              </button>
                            )}
                            <button
                              onClick={() => setDeleteConfirmId(mem.id)}
                              className="kz-btn kz-btn--ghost kz-btn--sm opacity-0 group-hover:opacity-100 transition-opacity"
                              style={{ padding: '0 6px' }}
                              title={t.common.delete}
                            >
                              <Trash2 size={12} />
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                  );
                })}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
