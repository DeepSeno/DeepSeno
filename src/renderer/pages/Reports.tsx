import { useState, useEffect } from 'react';
import { Loader2, Download, FileText, Calendar, Plus, Trash2, Check } from 'lucide-react';
import { useI18n } from '../i18n';
import { useApi } from '../hooks/useApi';
import { useNotifications } from '../components/NotificationCenter';

interface DailySummaryRow {
  id: number;
  date: string;
  summary_text: string;
  timeline_json: string | null;
  key_events_json: string | null;
}

interface TimelineItem {
  time: string;
  event: string;
}

interface TodoItem {
  content: string;
  due_date?: string;
  person?: string;
  done?: boolean;
}

interface ParsedKeyEvents {
  todos: TodoItem[];
  decisions: string[];
}

interface WeeklySummaryRow {
  id: number;
  start_date: string;
  end_date: string;
  summary_json: string | null;
}

interface WeeklyResult {
  summary: string;
  highlights: string[];
  todos_summary: Array<{ content: string; status?: string; person?: string }>;
  decisions: string[];
  next_week_focus: string[];
}

interface MonthlySummaryRow {
  id: number;
  start_date: string;
  end_date: string;
  summary_json: string | null;
}

interface MonthlyResult {
  summary: string;
  highlights: string[];
  todos_summary: Array<{ content: string; status?: string; person?: string }>;
  decisions: string[];
  next_month_focus: string[];
}

type ViewMode = 'detail' | 'generate';

export default function Reports() {
  const { t } = useI18n();
  const api = useApi();
  const { toast } = useNotifications();
  const r = t.reports;

  // Left panel state
  const [mode, setMode] = useState<'daily' | 'weekly' | 'monthly'>('daily');
  const [summaries, setSummaries] = useState<DailySummaryRow[]>([]);
  const [weeklySummaries, setWeeklySummaries] = useState<WeeklySummaryRow[]>([]);
  const [monthlySummaries, setMonthlySummaries] = useState<MonthlySummaryRow[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [selectedWeeklyId, setSelectedWeeklyId] = useState<number | null>(null);
  const [selectedMonthlyId, setSelectedMonthlyId] = useState<number | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>('detail');

  // Generate form state
  const [date, setDate] = useState(() => new Date().toISOString().split('T')[0]);
  const [startDate, setStartDate] = useState(() => {
    const d = new Date();
    const day = d.getDay();
    const diff = day === 0 ? 6 : day - 1;
    d.setDate(d.getDate() - diff);
    return d.toISOString().split('T')[0];
  });
  const [endDate, setEndDate] = useState(() => {
    const d = new Date();
    const day = d.getDay();
    d.setDate(d.getDate() + (7 - (day === 0 ? 7 : day)));
    return d.toISOString().split('T')[0];
  });
  // Monthly generate range — defaults to the current calendar month.
  const [monthStart, setMonthStart] = useState(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1, 12).toISOString().split('T')[0];
  });
  const [monthEnd, setMonthEnd] = useState(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth() + 1, 0, 12).toISOString().split('T')[0];
  });

  // Inline delete confirmation
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);
  const [confirmDeleteWeeklyId, setConfirmDeleteWeeklyId] = useState<number | null>(null);
  const [confirmDeleteMonthlyId, setConfirmDeleteMonthlyId] = useState<number | null>(null);

  // Right panel state
  const [loading, setLoading] = useState(false);
  const [weeklyResult, setWeeklyResult] = useState<WeeklyResult | null>(null);
  const [monthlyResult, setMonthlyResult] = useState<MonthlyResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [exportPath, setExportPath] = useState<string | null>(null);

  // Load summaries on mount
  useEffect(() => {
    loadSummaries();
    loadWeeklySummaries();
    loadMonthlySummaries();
  }, []);

  async function loadSummaries() {
    try {
      const data = await api.getAllDailySummaries();
      const sorted = (data || []).sort((a: DailySummaryRow, b: DailySummaryRow) =>
        b.date.localeCompare(a.date)
      );
      setSummaries(sorted);
      if (sorted.length > 0 && !selectedId) {
        setSelectedId(sorted[0].id);
        setViewMode('detail');
      }
    } catch {
      setSummaries([]);
    }
  }

  async function loadWeeklySummaries() {
    try {
      const data = await api.getAllWeeklySummaries();
      setWeeklySummaries(data || []);
    } catch {
      setWeeklySummaries([]);
    }
  }

  async function loadMonthlySummaries() {
    try {
      const data = await api.getAllMonthlySummaries();
      setMonthlySummaries(data || []);
    } catch {
      setMonthlySummaries([]);
    }
  }

  function getSelected(): DailySummaryRow | null {
    return summaries.find((s) => s.id === selectedId) || null;
  }

  function parseTimeline(row: DailySummaryRow): TimelineItem[] {
    if (!row.timeline_json) return [];
    try {
      return JSON.parse(row.timeline_json);
    } catch {
      return [];
    }
  }

  function parseKeyEvents(row: DailySummaryRow): ParsedKeyEvents {
    if (!row.key_events_json) return { todos: [], decisions: [] };
    try {
      const parsed = JSON.parse(row.key_events_json);
      return {
        todos: Array.isArray(parsed.todos) ? parsed.todos : [],
        decisions: Array.isArray(parsed.decisions) ? parsed.decisions : [],
      };
    } catch {
      return { todos: [], decisions: [] };
    }
  }

  function summaryPreview(text: string): string {
    if (!text) return '--';
    return text.length > 60 ? text.slice(0, 60) + '...' : text;
  }

  async function handleGenerate() {
    setLoading(true);
    setError(null);
    setWeeklyResult(null);
    setMonthlyResult(null);
    setExportPath(null);

    try {
      if (mode === 'daily') {
        const result = await api.generateDailySummary(date);
        if (result.error === 'no_data') {
          setError(r.no_data);
        } else {
          // Reload list and select the new report
          const data = await api.getAllDailySummaries();
          const sorted = (data || []).sort((a: DailySummaryRow, b: DailySummaryRow) =>
            b.date.localeCompare(a.date)
          );
          setSummaries(sorted);
          // Find the newly generated report by date
          const newReport = sorted.find((s: DailySummaryRow) => s.date === date);
          if (newReport) {
            setSelectedId(newReport.id);
            setViewMode('detail');
          }
        }
      } else if (mode === 'weekly') {
        const result = await api.generateWeeklySummary(startDate, endDate);
        if (result.error === 'no_data') {
          setError(r.no_dailies);
        } else {
          setWeeklyResult(result);
          // Reload weekly list and select the new entry
          const weeklyData = await api.getAllWeeklySummaries();
          setWeeklySummaries(weeklyData || []);
          const found = (weeklyData || []).find(
            (w: WeeklySummaryRow) => w.start_date === startDate && w.end_date === endDate
          );
          if (found) {
            setSelectedWeeklyId(found.id);
            setViewMode('detail');
          }
        }
      } else {
        const result = await api.generateMonthlySummary(monthStart, monthEnd);
        if (result.error === 'no_data') {
          setError(r.no_dailies);
        } else {
          setMonthlyResult(result as unknown as MonthlyResult);
          // Reload monthly list and select the new entry
          const monthlyData = await api.getAllMonthlySummaries();
          setMonthlySummaries(monthlyData || []);
          const found = (monthlyData || []).find(
            (m: MonthlySummaryRow) => m.start_date === monthStart && m.end_date === monthEnd
          );
          if (found) {
            setSelectedMonthlyId(found.id);
            setViewMode('detail');
          }
        }
      }
    } catch {
      setError(r.error);
    } finally {
      setLoading(false);
    }
  }

  async function handleExport() {
    try {
      const selected = getSelected();
      if (mode === 'daily' && selected) {
        const result = await api.exportDailySummary(selected.date);
        if (result.filePath) {
          setExportPath(result.filePath);
          toast('success', t.export_success, result.filePath);
        }
      } else if (mode === 'weekly' && weeklyResult) {
        const result = await api.exportWeeklySummary(startDate, endDate, weeklyResult);
        if (result.filePath) {
          setExportPath(result.filePath);
          toast('success', t.export_success, result.filePath);
        }
      } else if (mode === 'monthly' && monthlyResult) {
        const result = await api.exportMonthlySummary(monthStart, monthEnd, monthlyResult as unknown as Record<string, unknown>);
        if (result.filePath) {
          setExportPath(result.filePath);
          toast('success', t.export_success, result.filePath);
        }
      }
    } catch {
      toast('error', r.error);
    }
  }

  async function handleDelete(id: number, dateStr: string) {
    if (confirmDeleteId !== id) {
      setConfirmDeleteId(id);
      return;
    }
    try {
      await api.deleteDailySummary(dateStr);
      const remaining = summaries.filter((s) => s.id !== id);
      setSummaries(remaining);
      setConfirmDeleteId(null);
      if (selectedId === id) {
        if (remaining.length > 0) {
          setSelectedId(remaining[0].id);
          setViewMode('detail');
        } else {
          setSelectedId(null);
          setViewMode('generate');
        }
      }
    } catch {
      toast('error', r.error);
    }
  }

  function handleGenerateNew() {
    setViewMode('generate');
    setError(null);
    setWeeklyResult(null);
    setMonthlyResult(null);
    setExportPath(null);
  }

  function handleSelectMonthly(row: MonthlySummaryRow) {
    setSelectedMonthlyId(row.id);
    setSelectedId(null);
    setSelectedWeeklyId(null);
    if (row.summary_json) {
      try {
        setMonthlyResult(JSON.parse(row.summary_json));
      } catch {
        setMonthlyResult(null);
      }
    }
    setMonthStart(row.start_date);
    setMonthEnd(row.end_date);
    setViewMode('detail');
    setError(null);
    setExportPath(null);
  }

  async function handleDeleteMonthly(id: number, start: string, end: string) {
    if (confirmDeleteMonthlyId !== id) {
      setConfirmDeleteMonthlyId(id);
      return;
    }
    try {
      await api.deleteMonthlySummary(start, end);
      const remaining = monthlySummaries.filter((m) => m.id !== id);
      setMonthlySummaries(remaining);
      setConfirmDeleteMonthlyId(null);
      if (selectedMonthlyId === id) {
        setSelectedMonthlyId(null);
        setMonthlyResult(null);
        if (remaining.length > 0) {
          handleSelectMonthly(remaining[0]);
        } else {
          setViewMode('generate');
        }
      }
    } catch {
      toast('error', r.error);
    }
  }

  async function handleTodoToggle(index: number) {
    const sel = getSelected();
    if (!sel) return;
    const parsed = parseKeyEvents(sel);
    const updatedTodos = parsed.todos.map((todo, i) =>
      i === index ? { ...todo, done: !todo.done } : todo
    );
    const updatedJson = JSON.stringify({ todos: updatedTodos, decisions: parsed.decisions });
    const prevJson = sel.key_events_json;
    // Optimistic update
    setSummaries((prev) =>
      prev.map((s) => s.id === sel.id ? { ...s, key_events_json: updatedJson } : s)
    );
    try {
      await api.updateDailySummaryKeyEvents(sel.date, updatedJson);
    } catch {
      // Revert on error
      setSummaries((prev) =>
        prev.map((s) => s.id === sel.id ? { ...s, key_events_json: prevJson } : s)
      );
      toast('error', r.error);
    }
  }

  function handleSelectReport(id: number) {
    setSelectedId(id);
    setSelectedWeeklyId(null);
    setViewMode('detail');
    setError(null);
    setWeeklyResult(null);
    setExportPath(null);
  }

  function handleSelectWeekly(row: WeeklySummaryRow) {
    setSelectedWeeklyId(row.id);
    setSelectedId(null);
    if (row.summary_json) {
      try {
        setWeeklyResult(JSON.parse(row.summary_json));
      } catch {
        setWeeklyResult(null);
      }
    }
    setStartDate(row.start_date);
    setEndDate(row.end_date);
    setViewMode('detail');
    setError(null);
    setExportPath(null);
  }

  async function handleDeleteWeekly(id: number, start: string, end: string) {
    if (confirmDeleteWeeklyId !== id) {
      setConfirmDeleteWeeklyId(id);
      return;
    }
    try {
      await api.deleteWeeklySummary(start, end);
      const remaining = weeklySummaries.filter((w) => w.id !== id);
      setWeeklySummaries(remaining);
      setConfirmDeleteWeeklyId(null);
      if (selectedWeeklyId === id) {
        setSelectedWeeklyId(null);
        setWeeklyResult(null);
        if (remaining.length > 0) {
          handleSelectWeekly(remaining[0]);
        } else {
          setViewMode('generate');
        }
      }
    } catch {
      toast('error', r.error);
    }
  }

  const selected = getSelected();
  const timeline = selected ? parseTimeline(selected) : [];
  const keyEvents = selected ? parseKeyEvents(selected) : { todos: [], decisions: [] };
  const todos = keyEvents.todos;
  const decisions = keyEvents.decisions;

  return (
    <div className="-m-6" style={{ height: 'calc(100% + 3rem)', background: 'var(--bg)' }}>
      <div className="flex h-full overflow-hidden">
        {/* Left panel - report list */}
        <div
          className="w-[320px] flex flex-col flex-shrink-0"
          style={{ borderRight: '1px solid var(--line)', background: 'var(--bg)' }}
        >
          {/* Mode toggle — matches Settings tabs design spec (8px 16px / 12.5px) */}
          <div className="p-4" style={{ borderBottom: '1px solid var(--line-soft)' }}>
            <div
              style={{
                display: 'inline-flex',
                gap: 4,
                padding: 4,
                border: '1px solid var(--line)',
                borderRadius: 10,
                background: 'var(--bg-card)',
                width: 'fit-content',
              }}
            >
              {([
                { key: 'daily', label: r.daily },
                { key: 'weekly', label: r.weekly },
                { key: 'monthly', label: (r as any).monthly },
              ] as const).map(({ key, label }) => {
                const on = mode === key;
                return (
                  <button
                    key={key}
                    onClick={() => { setMode(key as typeof mode); setWeeklyResult(null); setMonthlyResult(null); setError(null); }}
                    style={{
                      padding: '8px 16px',
                      borderRadius: 7,
                      fontSize: 12.5,
                      whiteSpace: 'nowrap',
                      background: on ? 'var(--c-accent)' : 'transparent',
                      color: on ? 'var(--c-accent-ink)' : 'var(--ink-soft)',
                      border: 0,
                      cursor: 'pointer',
                      transition: 'background 0.14s, color 0.14s',
                    }}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* History label */}
          <div
            className="px-4 py-2 flex justify-between items-center"
            style={{ borderBottom: '1px solid var(--line-soft)', background: 'var(--bg-elev)' }}
          >
            <span className="kz-serif-italic kz-text-mute" style={{ fontSize: 11.5 }}>{r.history}</span>
            <span className="kz-mono kz-text-ink" style={{ fontSize: 11 }}>
              {mode === 'daily' ? summaries.length : mode === 'weekly' ? weeklySummaries.length : monthlySummaries.length}
            </span>
          </div>

          {/* Report list */}
          <div className="flex-1 overflow-y-auto">
            {mode === 'monthly' ? (
              monthlySummaries.length === 0 ? (
                <div className="kz-empty">
                  <div className="kz-empty__icon">
                    <FileText size={20} />
                  </div>
                  <div>
                    <div className="kz-empty__title">{r.no_history}</div>
                  </div>
                </div>
              ) : (
                monthlySummaries.map((row, idx) => {
                  let preview = '--';
                  try { if (row.summary_json) preview = summaryPreview(JSON.parse(row.summary_json).summary || ''); } catch { /* */ }
                  const isSel = selectedMonthlyId === row.id && viewMode === 'detail';
                  return (
                    <div
                      key={row.id}
                      onClick={() => handleSelectMonthly(row)}
                      className={`group px-4 py-3 kz-row-hover relative ${isSel ? 'kz-row-selected' : ''}`}
                      style={{ borderTop: idx ? '1px solid var(--line-soft)' : 0 }}
                    >
                      <div className="flex items-center justify-between mb-1.5">
                        <div className="flex items-center gap-2">
                          <Calendar size={11} className="kz-text-faint" />
                          <span className="kz-mono" style={{ fontSize: 11, color: 'var(--ink-soft)' }}>
                            {row.start_date} ~ {row.end_date}
                          </span>
                        </div>
                        {confirmDeleteMonthlyId === row.id ? (
                          <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                            <button
                              onClick={() => setConfirmDeleteMonthlyId(null)}
                              className="kz-btn kz-btn--ghost kz-btn--sm"
                              style={{ padding: '2px 6px', height: 'auto', fontSize: 10.5 }}
                            >
                              {t.common.cancel}
                            </button>
                            <button
                              onClick={() => handleDeleteMonthly(row.id, row.start_date, row.end_date)}
                              className="kz-btn kz-btn--sm"
                              style={{ padding: '2px 6px', height: 'auto', fontSize: 10.5, color: 'var(--c-danger)', borderColor: 'transparent', background: 'transparent' }}
                            >
                              {r.delete}
                            </button>
                          </div>
                        ) : (
                          <button
                            onClick={(e) => { e.stopPropagation(); handleDeleteMonthly(row.id, row.start_date, row.end_date); }}
                            className="opacity-0 group-hover:opacity-100 p-1 transition-all kz-text-mute"
                            style={{ borderRadius: 4 }}
                            title={r.delete}
                          >
                            <Trash2 size={12} />
                          </button>
                        )}
                      </div>
                      <p className="kz-text-mute line-clamp-2" style={{ fontSize: 11.5, lineHeight: 1.55 }}>{preview}</p>
                    </div>
                  );
                })
              )
            ) : mode === 'daily' ? (
              summaries.length === 0 ? (
                <div className="kz-empty">
                  <div className="kz-empty__icon">
                    <FileText size={20} />
                  </div>
                  <div>
                    <div className="kz-empty__title">{r.no_history}</div>
                  </div>
                </div>
              ) : (
                summaries.map((row, idx) => {
                  const isSel = selectedId === row.id && viewMode === 'detail';
                  return (
                    <div
                      key={row.id}
                      onClick={() => handleSelectReport(row.id)}
                      className={`group px-4 py-3 kz-row-hover relative ${isSel ? 'kz-row-selected' : ''}`}
                      style={{ borderTop: idx ? '1px solid var(--line-soft)' : 0 }}
                    >
                      <div className="flex items-center justify-between mb-1.5">
                        <div className="flex items-center gap-2">
                          <Calendar size={11} className="kz-text-faint" />
                          <span className="kz-mono" style={{ fontSize: 11, color: 'var(--ink-soft)' }}>{row.date}</span>
                        </div>
                        {confirmDeleteId === row.id ? (
                          <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                            <button
                              onClick={() => setConfirmDeleteId(null)}
                              className="kz-btn kz-btn--ghost kz-btn--sm"
                              style={{ padding: '2px 6px', height: 'auto', fontSize: 10.5 }}
                            >
                              {t.common.cancel}
                            </button>
                            <button
                              onClick={() => handleDelete(row.id, row.date)}
                              className="kz-btn kz-btn--sm"
                              style={{ padding: '2px 6px', height: 'auto', fontSize: 10.5, color: 'var(--c-danger)', borderColor: 'transparent', background: 'transparent' }}
                            >
                              {r.delete}
                            </button>
                          </div>
                        ) : (
                          <button
                            onClick={(e) => { e.stopPropagation(); handleDelete(row.id, row.date); }}
                            className="opacity-0 group-hover:opacity-100 p-1 transition-all kz-text-mute"
                            style={{ borderRadius: 4 }}
                            title={r.delete}
                          >
                            <Trash2 size={12} />
                          </button>
                        )}
                      </div>
                      <div className="kz-serif mb-1" style={{ fontSize: 14, lineHeight: 1.35, color: 'var(--ink)' }}>
                        {row.date}
                      </div>
                      <p className="kz-text-mute line-clamp-2" style={{ fontSize: 11.5, lineHeight: 1.55 }}>
                        {summaryPreview(row.summary_text)}
                      </p>
                    </div>
                  );
                })
              )
            ) : (
              weeklySummaries.length === 0 ? (
                <div className="kz-empty">
                  <div className="kz-empty__icon">
                    <FileText size={20} />
                  </div>
                  <div>
                    <div className="kz-empty__title">{r.no_history}</div>
                  </div>
                </div>
              ) : (
                weeklySummaries.map((row, idx) => {
                  let preview = '--';
                  try { if (row.summary_json) preview = summaryPreview(JSON.parse(row.summary_json).summary || ''); } catch { /* */ }
                  const isSel = selectedWeeklyId === row.id && viewMode === 'detail';
                  return (
                    <div
                      key={row.id}
                      onClick={() => handleSelectWeekly(row)}
                      className={`group px-4 py-3 kz-row-hover relative ${isSel ? 'kz-row-selected' : ''}`}
                      style={{ borderTop: idx ? '1px solid var(--line-soft)' : 0 }}
                    >
                      <div className="flex items-center justify-between mb-1.5">
                        <div className="flex items-center gap-2">
                          <Calendar size={11} className="kz-text-faint" />
                          <span className="kz-mono" style={{ fontSize: 11, color: 'var(--ink-soft)' }}>
                            {row.start_date} ~ {row.end_date}
                          </span>
                        </div>
                        {confirmDeleteWeeklyId === row.id ? (
                          <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                            <button
                              onClick={() => setConfirmDeleteWeeklyId(null)}
                              className="kz-btn kz-btn--ghost kz-btn--sm"
                              style={{ padding: '2px 6px', height: 'auto', fontSize: 10.5 }}
                            >
                              {t.common.cancel}
                            </button>
                            <button
                              onClick={() => handleDeleteWeekly(row.id, row.start_date, row.end_date)}
                              className="kz-btn kz-btn--sm"
                              style={{ padding: '2px 6px', height: 'auto', fontSize: 10.5, color: 'var(--c-danger)', borderColor: 'transparent', background: 'transparent' }}
                            >
                              {r.delete}
                            </button>
                          </div>
                        ) : (
                          <button
                            onClick={(e) => { e.stopPropagation(); handleDeleteWeekly(row.id, row.start_date, row.end_date); }}
                            className="opacity-0 group-hover:opacity-100 p-1 transition-all kz-text-mute"
                            style={{ borderRadius: 4 }}
                            title={r.delete}
                          >
                            <Trash2 size={12} />
                          </button>
                        )}
                      </div>
                      <p className="kz-text-mute line-clamp-2" style={{ fontSize: 11.5, lineHeight: 1.55 }}>{preview}</p>
                    </div>
                  );
                })
              )
            )}
          </div>

          {/* Generate new button */}
          <div className="p-3" style={{ borderTop: '1px solid var(--line-soft)' }}>
            <button
              onClick={handleGenerateNew}
              className="kz-btn kz-btn--primary w-full justify-center"
            >
              <Plus size={13} />
              {r.generate_new}
            </button>
          </div>
        </div>

        {/* Right panel - content or generate form */}
        <div className="flex-1 flex flex-col overflow-hidden" style={{ background: 'var(--bg)' }}>
          {/* Generate form view */}
          {viewMode === 'generate' && (
            <div className="flex-1 overflow-y-auto">
              <div
                className="p-6"
                style={{ borderBottom: '1px solid var(--line-soft)', background: 'var(--bg-elev)' }}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    {mode === 'daily' ? (
                      <div className="flex items-center gap-2">
                        <Calendar size={14} className="kz-text-mute" />
                        <span className="kz-serif-italic kz-text-mute" style={{ fontSize: 12 }}>{r.select_date}:</span>
                        <input
                          type="date"
                          value={date}
                          max={new Date().toISOString().split('T')[0]}
                          onChange={(e) => setDate(e.target.value)}
                          className="kz-input"
                          style={{ height: 28, padding: '0 8px', fontSize: 12 }}
                        />
                      </div>
                    ) : mode === 'weekly' ? (
                      <div className="flex items-center gap-2">
                        <Calendar size={14} className="kz-text-mute" />
                        <span className="kz-serif-italic kz-text-mute" style={{ fontSize: 12 }}>{r.start_date}:</span>
                        <input
                          type="date"
                          value={startDate}
                          max={new Date().toISOString().split('T')[0]}
                          onChange={(e) => setStartDate(e.target.value)}
                          className="kz-input"
                          style={{ height: 28, padding: '0 8px', fontSize: 12 }}
                        />
                        <span className="kz-serif-italic kz-text-mute" style={{ fontSize: 12 }}>{r.end_date}:</span>
                        <input
                          type="date"
                          value={endDate}
                          max={new Date().toISOString().split('T')[0]}
                          onChange={(e) => setEndDate(e.target.value)}
                          className="kz-input"
                          style={{ height: 28, padding: '0 8px', fontSize: 12 }}
                        />
                      </div>
                    ) : (
                      <div className="flex items-center gap-2">
                        <Calendar size={14} className="kz-text-mute" />
                        <span className="kz-serif-italic kz-text-mute" style={{ fontSize: 12 }}>{r.start_date}:</span>
                        <input
                          type="date"
                          value={monthStart}
                          max={new Date().toISOString().split('T')[0]}
                          onChange={(e) => setMonthStart(e.target.value)}
                          className="kz-input"
                          style={{ height: 28, padding: '0 8px', fontSize: 12 }}
                        />
                        <span className="kz-serif-italic kz-text-mute" style={{ fontSize: 12 }}>{r.end_date}:</span>
                        <input
                          type="date"
                          value={monthEnd}
                          max={new Date().toISOString().split('T')[0]}
                          onChange={(e) => setMonthEnd(e.target.value)}
                          className="kz-input"
                          style={{ height: 28, padding: '0 8px', fontSize: 12 }}
                        />
                      </div>
                    )}
                  </div>
                  <button
                    onClick={handleGenerate}
                    disabled={loading}
                    className={`kz-btn kz-btn--sm ${loading ? '' : 'kz-btn--primary'}`}
                  >
                    {loading ? r.generating : r.generate}
                  </button>
                </div>
              </div>

              <div className="p-6">
                {loading && (
                  <div className="flex flex-col items-center justify-center py-16">
                    <Loader2 size={24} className="animate-spin kz-text-mute mb-3" />
                    <span className="kz-serif-italic kz-text-mute" style={{ fontSize: 13 }}>{r.generating}</span>
                  </div>
                )}

                {error && !loading && (
                  <div className="kz-empty">
                    <div className="kz-empty__icon"><FileText size={20} /></div>
                    <div>
                      <div className="kz-empty__title">{error}</div>
                    </div>
                  </div>
                )}

                {!loading && !error && !weeklyResult && (
                  <div className="kz-empty">
                    <div className="kz-empty__icon"><FileText size={20} /></div>
                    <div>
                      <div className="kz-empty__sub">{r.desc}</div>
                    </div>
                  </div>
                )}

                {/* Weekly result (daily results auto-redirect to detail view) */}
                {!loading && weeklyResult && mode === 'weekly' && (
                  <div className="kz-prose" style={{ maxWidth: 780 }}>
                    <Section title={r.summary}>
                      <p>{weeklyResult.summary}</p>
                    </Section>

                    <Section title={r.highlights}>
                      {weeklyResult.highlights.length === 0 ? (
                        <Empty />
                      ) : (
                        <ul>
                          {weeklyResult.highlights.map((h, i) => (
                            <li key={`hl-${h.slice(0, 20)}-${i}`}>
                              <span className="kz-text-accent" style={{ marginRight: 6 }}>*</span>{h}
                            </li>
                          ))}
                        </ul>
                      )}
                    </Section>

                    <Section title={r.todos}>
                      {weeklyResult.todos_summary.length === 0 ? (
                        <Empty />
                      ) : (
                        <ul style={{ listStyle: 'none', padding: 0 }}>
                          {weeklyResult.todos_summary.map((todo, i) => (
                            <li key={`todo-${todo.content.slice(0, 20)}-${i}`} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0' }}>
                              <span style={{
                                width: 14, height: 14, borderRadius: 4,
                                border: '1.4px solid var(--line-strong)',
                                background: todo.status === 'completed' ? 'var(--c-success)' : 'transparent',
                                flexShrink: 0,
                              }} />
                              <span style={{ color: 'var(--ink)' }}>
                                {todo.content}
                                {todo.person && <span className="kz-serif-italic kz-text-mute" style={{ marginLeft: 8, fontSize: 11.5 }}>@{todo.person}</span>}
                              </span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </Section>

                    <Section title={r.decisions}>
                      {weeklyResult.decisions.length === 0 ? (
                        <Empty />
                      ) : (
                        <ul>
                          {weeklyResult.decisions.map((d, i) => (
                            <li key={`dec-${d.slice(0, 20)}-${i}`}>
                              <span className="kz-text-mute" style={{ marginRight: 6 }}>\u2014</span>{d}
                            </li>
                          ))}
                        </ul>
                      )}
                    </Section>

                    <Section title={r.next_week}>
                      {weeklyResult.next_week_focus.length === 0 ? (
                        <Empty />
                      ) : (
                        <ul>
                          {weeklyResult.next_week_focus.map((f, i) => (
                            <li key={`nw-${f.slice(0, 20)}-${i}`}>
                              <span style={{ color: 'var(--c-info)', marginRight: 6 }}>{'\u2192'}</span>{f}
                            </li>
                          ))}
                        </ul>
                      )}
                    </Section>
                  </div>
                )}
              </div>

              {/* Export bar for weekly */}
              {mode === 'weekly' && weeklyResult && !loading && (
                <div
                  className="px-6 py-3 flex items-center justify-between mt-auto"
                  style={{ borderTop: '1px solid var(--line-soft)', background: 'var(--bg-elev)' }}
                >
                  <div>
                    {exportPath && (
                      <span className="kz-badge kz-badge--success">
                        {r.exported} {exportPath}
                      </span>
                    )}
                  </div>
                  <button onClick={handleExport} className="kz-btn">
                    <Download size={13} />
                    {r.export_md}
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Detail view for selected daily report */}
          {viewMode === 'detail' && mode === 'daily' && selected && (
            <div className="flex-1 flex flex-col overflow-hidden">
              {/* Detail header — magazine masthead */}
              <div
                className="px-10 pt-8 pb-4 flex items-start justify-between flex-shrink-0"
                style={{ borderBottom: '1px solid var(--line-soft)' }}
              >
                <div>
                  <div className="kz-mono kz-text-mute" style={{ fontSize: 10.5, letterSpacing: 0.4 }}>
                    {r.daily} · {selected.date}
                  </div>
                  <h1 className="kz-serif" style={{ fontSize: 30, lineHeight: 1.15, margin: '6px 0 0', color: 'var(--ink)' }}>
                    {selected.date}
                  </h1>
                </div>
                <div className="flex items-center gap-2">
                  {exportPath && (
                    <span className="kz-badge kz-badge--success">{r.exported}</span>
                  )}
                  <button onClick={handleExport} className="kz-btn">
                    <Download size={13} />
                    {r.export_md}
                  </button>
                </div>
              </div>

              {/* Detail content */}
              <div className="flex-1 overflow-y-auto px-10 py-8" style={{ display: 'flex', flexDirection: 'column' }}>
                <div className="kz-prose" style={{ maxWidth: 780 }}>
                <Section title={r.summary}>
                  <p style={{ whiteSpace: 'pre-wrap' }}>
                    {selected.summary_text}
                  </p>
                </Section>

                <Section title={r.timeline}>
                  {timeline.length === 0 ? (
                    <Empty />
                  ) : (
                    <ul style={{ listStyle: 'none', padding: 0 }}>
                      {timeline.map((item, i) => (
                        <li key={`tl-${item.time}-${i}`} style={{ display: 'flex', alignItems: 'flex-start', gap: 12, padding: '4px 0' }}>
                          <span className="kz-mono kz-text-mute" style={{ fontSize: 11, width: 48, flexShrink: 0, paddingTop: 4 }}>{item.time}</span>
                          <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--c-accent)', marginTop: 8, flexShrink: 0 }} />
                          <span style={{ color: 'var(--ink)' }}>{item.event}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </Section>

                <Section title={r.todos}>
                  {todos.length === 0 ? (
                    <Empty />
                  ) : (
                    <ul style={{ listStyle: 'none', padding: 0 }}>
                      {todos.map((todo, i) => (
                        <li
                          key={`todo-${todo.content.slice(0, 20)}-${i}`}
                          className="group"
                          style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0', cursor: 'pointer', opacity: todo.done ? 0.45 : 1 }}
                          onClick={() => handleTodoToggle(i)}
                        >
                          <span style={{
                            width: 16, height: 16, borderRadius: 4,
                            border: '1.4px solid var(--line-strong)',
                            background: todo.done ? 'var(--c-success)' : 'transparent',
                            display: 'grid', placeItems: 'center',
                            color: 'var(--c-accent-ink)', flexShrink: 0,
                          }}>
                            {todo.done && <Check size={11} strokeWidth={2.4} />}
                          </span>
                          <span style={{
                            color: todo.done ? 'var(--ink-mute)' : 'var(--ink)',
                            textDecoration: todo.done ? 'line-through' : 'none',
                          }}>
                            {todo.content}
                            {todo.person && <span className="kz-serif-italic kz-text-mute" style={{ marginLeft: 8, fontSize: 11.5 }}>@{todo.person}</span>}
                            {todo.due_date && <span className="kz-mono kz-text-mute" style={{ marginLeft: 8, fontSize: 11 }}>({todo.due_date})</span>}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </Section>

                <Section title={r.decisions}>
                  {decisions.length === 0 ? (
                    <Empty />
                  ) : (
                    <ul style={{ listStyle: 'none', padding: 0 }}>
                      {decisions.map((d, i) => (
                        <li key={`dec-${d.slice(0, 20)}-${i}`}>
                          <blockquote style={{
                            margin: '12px 0', padding: '12px 16px',
                            borderLeft: '3px solid var(--c-accent)',
                            background: 'var(--c-accent-bg)',
                            borderRadius: '0 8px 8px 0',
                          }}>
                            <div className="kz-serif-italic" style={{ fontSize: 14.5, color: 'var(--ink)' }}>
                              "{d}"
                            </div>
                          </blockquote>
                        </li>
                      ))}
                    </ul>
                  )}
                </Section>
                </div>
                {/* Spacer keeps the scroll surface flush with the viewport when content is short */}
                <div style={{ flex: 1, minHeight: 24 }} />
              </div>
            </div>
          )}

          {/* Detail view for selected weekly report */}
          {viewMode === 'detail' && mode === 'weekly' && weeklyResult && (
            <div className="flex-1 flex flex-col overflow-hidden">
              <div
                className="px-10 pt-8 pb-4 flex items-start justify-between flex-shrink-0"
                style={{ borderBottom: '1px solid var(--line-soft)' }}
              >
                <div>
                  <div className="kz-mono kz-text-mute" style={{ fontSize: 10.5, letterSpacing: 0.4 }}>
                    {r.weekly}
                  </div>
                  <h1 className="kz-serif" style={{ fontSize: 30, lineHeight: 1.15, margin: '6px 0 0', color: 'var(--ink)' }}>
                    {startDate} ~ {endDate}
                  </h1>
                </div>
                <div className="flex items-center gap-2">
                  {exportPath && (
                    <span className="kz-badge kz-badge--success">{r.exported}</span>
                  )}
                  <button onClick={handleExport} className="kz-btn">
                    <Download size={13} />
                    {r.export_md}
                  </button>
                </div>
              </div>
              <div className="flex-1 overflow-y-auto px-10 py-8" style={{ display: 'flex', flexDirection: 'column' }}>
                <div className="kz-prose" style={{ maxWidth: 780 }}>
                <Section title={r.summary}>
                  <p>{weeklyResult.summary}</p>
                </Section>
                <Section title={r.highlights}>
                  {weeklyResult.highlights.length === 0 ? <Empty /> : (
                    <ul>
                      {weeklyResult.highlights.map((h, i) => (
                        <li key={`whl-${h.slice(0, 20)}-${i}`}>
                          <span className="kz-text-accent" style={{ marginRight: 6 }}>*</span>{h}
                        </li>
                      ))}
                    </ul>
                  )}
                </Section>
                <Section title={r.todos}>
                  {weeklyResult.todos_summary.length === 0 ? <Empty /> : (
                    <ul style={{ listStyle: 'none', padding: 0 }}>
                      {weeklyResult.todos_summary.map((todo, i) => (
                        <li key={`wtodo-${todo.content.slice(0, 20)}-${i}`} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0' }}>
                          <span style={{
                            width: 14, height: 14, borderRadius: 4,
                            border: '1.4px solid var(--line-strong)',
                            background: todo.status === 'completed' ? 'var(--c-success)' : 'transparent',
                            flexShrink: 0,
                          }} />
                          <span style={{ color: 'var(--ink)' }}>
                            {todo.content}
                            {todo.person && <span className="kz-serif-italic kz-text-mute" style={{ marginLeft: 8, fontSize: 11.5 }}>@{todo.person}</span>}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </Section>
                <Section title={r.decisions}>
                  {weeklyResult.decisions.length === 0 ? <Empty /> : (
                    <ul style={{ listStyle: 'none', padding: 0 }}>
                      {weeklyResult.decisions.map((d, i) => (
                        <li key={`wdec-${d.slice(0, 20)}-${i}`}>
                          <blockquote style={{
                            margin: '12px 0', padding: '12px 16px',
                            borderLeft: '3px solid var(--c-accent)',
                            background: 'var(--c-accent-bg)',
                            borderRadius: '0 8px 8px 0',
                          }}>
                            <div className="kz-serif-italic" style={{ fontSize: 14.5, color: 'var(--ink)' }}>
                              "{d}"
                            </div>
                          </blockquote>
                        </li>
                      ))}
                    </ul>
                  )}
                </Section>
                <Section title={r.next_week}>
                  {weeklyResult.next_week_focus.length === 0 ? <Empty /> : (
                    <ul>
                      {weeklyResult.next_week_focus.map((f, i) => (
                        <li key={`wnw-${f.slice(0, 20)}-${i}`}>
                          <span style={{ color: 'var(--c-info)', marginRight: 6 }}>{'\u2192'}</span>{f}
                        </li>
                      ))}
                    </ul>
                  )}
                </Section>
                </div>
                <div style={{ flex: 1, minHeight: 24 }} />
              </div>
            </div>
          )}

          {/* Detail view for selected monthly report */}
          {viewMode === 'detail' && mode === 'monthly' && monthlyResult && (
            <div className="flex-1 flex flex-col overflow-hidden">
              <div
                className="px-10 pt-8 pb-4 flex items-start justify-between flex-shrink-0"
                style={{ borderBottom: '1px solid var(--line-soft)' }}
              >
                <div>
                  <div className="kz-mono kz-text-mute" style={{ fontSize: 10.5, letterSpacing: 0.4 }}>
                    {r.monthly}
                  </div>
                  <h1 className="kz-serif" style={{ fontSize: 30, lineHeight: 1.15, margin: '6px 0 0', color: 'var(--ink)' }}>
                    {monthStart} ~ {monthEnd}
                  </h1>
                </div>
                <div className="flex items-center gap-2">
                  {exportPath && (
                    <span className="kz-badge kz-badge--success">{r.exported}</span>
                  )}
                  <button onClick={handleExport} className="kz-btn">
                    <Download size={13} />
                    {r.export_md}
                  </button>
                </div>
              </div>
              <div className="flex-1 overflow-y-auto px-10 py-8" style={{ display: 'flex', flexDirection: 'column' }}>
                <div className="kz-prose" style={{ maxWidth: 780 }}>
                <Section title={r.summary}>
                  <p>{monthlyResult.summary}</p>
                </Section>
                <Section title={(r as any).highlights_month}>
                  {monthlyResult.highlights.length === 0 ? <Empty /> : (
                    <ul>
                      {monthlyResult.highlights.map((h, i) => (
                        <li key={`mhl-${h.slice(0, 20)}-${i}`}>
                          <span className="kz-text-accent" style={{ marginRight: 6 }}>*</span>{h}
                        </li>
                      ))}
                    </ul>
                  )}
                </Section>
                <Section title={r.todos}>
                  {monthlyResult.todos_summary.length === 0 ? <Empty /> : (
                    <ul style={{ listStyle: 'none', padding: 0 }}>
                      {monthlyResult.todos_summary.map((todo, i) => (
                        <li key={`mtodo-${todo.content.slice(0, 20)}-${i}`} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0' }}>
                          <span style={{
                            width: 14, height: 14, borderRadius: 4,
                            border: '1.4px solid var(--line-strong)',
                            background: todo.status === 'completed' ? 'var(--c-success)' : 'transparent',
                            flexShrink: 0,
                          }} />
                          <span style={{ color: 'var(--ink)' }}>
                            {todo.content}
                            {todo.person && <span className="kz-serif-italic kz-text-mute" style={{ marginLeft: 8, fontSize: 11.5 }}>@{todo.person}</span>}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </Section>
                <Section title={r.decisions}>
                  {monthlyResult.decisions.length === 0 ? <Empty /> : (
                    <ul style={{ listStyle: 'none', padding: 0 }}>
                      {monthlyResult.decisions.map((d, i) => (
                        <li key={`mdec-${d.slice(0, 20)}-${i}`}>
                          <blockquote style={{
                            margin: '12px 0', padding: '12px 16px',
                            borderLeft: '3px solid var(--c-accent)',
                            background: 'var(--c-accent-bg)',
                            borderRadius: '0 8px 8px 0',
                          }}>
                            <div className="kz-serif-italic" style={{ fontSize: 14.5, color: 'var(--ink)' }}>
                              "{d}"
                            </div>
                          </blockquote>
                        </li>
                      ))}
                    </ul>
                  )}
                </Section>
                <Section title={(r as any).next_month}>
                  {monthlyResult.next_month_focus.length === 0 ? <Empty /> : (
                    <ul>
                      {monthlyResult.next_month_focus.map((f, i) => (
                        <li key={`mnw-${f.slice(0, 20)}-${i}`}>
                          <span style={{ color: 'var(--c-info)', marginRight: 6 }}>{'→'}</span>{f}
                        </li>
                      ))}
                    </ul>
                  )}
                </Section>
                </div>
                <div style={{ flex: 1, minHeight: 24 }} />
              </div>
            </div>
          )}

          {/* Empty state when no report selected and not generating */}
          {viewMode === 'detail' && !selected && !(mode === 'weekly' && weeklyResult) && !(mode === 'monthly' && monthlyResult) && (
            <div className="flex-1 flex items-center justify-center">
              <div className="kz-empty">
                <div className="kz-empty__icon">
                  <FileText size={20} />
                </div>
                <div>
                  <div className="kz-empty__title">{r.no_history}</div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="kz-section-title" style={{ marginTop: 20 }}>
        <span>{title}</span>
      </h3>
      {children}
    </div>
  );
}

function Empty() {
  return <div className="kz-serif-italic kz-text-faint" style={{ fontSize: 12 }}>--</div>;
}
