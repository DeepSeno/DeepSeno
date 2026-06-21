import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Play, Pause, Trash2, Plus, History,
  Pencil, AlertCircle, CheckCircle2, Loader2, Zap, Repeat, Timer,
  Terminal, Activity, CalendarClock, TriangleAlert,
} from 'lucide-react';
import { useApi, type ScheduledTaskRow, type TaskExecutionRow } from '../hooks/useApi';
import { useI18n } from '../i18n';
import SchedulerTaskModal from '../components/SchedulerTaskModal';

// ─── Constants ──────────────────────────────────────────
type FilterTab = 'all' | 'active' | 'paused';

const STATUS_CONFIG: Record<string, {
  sdot: string;          // kz-sdot--*
  badge: string;         // kz-badge--*
  accent: string;        // CSS var color for left accent bar
}> = {
  active:    { sdot: 'kz-sdot--success', badge: 'kz-badge--success', accent: 'var(--c-success)' },
  paused:    { sdot: 'kz-sdot--warn',    badge: 'kz-badge--warn',    accent: 'var(--c-warn)' },
  running:   { sdot: 'kz-sdot--info',    badge: 'kz-badge--info',    accent: 'var(--c-info)' },
  failed:    { sdot: 'kz-sdot--danger',  badge: 'kz-badge--danger',  accent: 'var(--c-danger)' },
  completed: { sdot: 'kz-sdot--mute',    badge: 'kz-badge--mute',    accent: 'var(--ink-faint)' },
};

const EXEC_STATUS_ICON: Record<string, { icon: typeof CheckCircle2; badge: string; iconColor: string }> = {
  success:  { icon: CheckCircle2, badge: 'kz-badge--success', iconColor: 'var(--c-success)' },
  failed:   { icon: AlertCircle,  badge: 'kz-badge--danger',  iconColor: 'var(--c-danger)' },
  running:  { icon: Loader2,      badge: 'kz-badge--info',    iconColor: 'var(--c-info)' },
  skipped:  { icon: AlertCircle,  badge: 'kz-badge--mute',    iconColor: 'var(--ink-mute)' },
};

// Predefined-action list is fetched at runtime from the backend registry
// (scheduler:listActions) — the single source of truth — so the renderer no
// longer hardcodes it and never drifts when actions are added/removed.
interface PredefinedAction { name: string; label_zh: string; label_en: string }

// ─── Helpers ────────────────────────────────────────────
function formatTime(dateStr: string | null, locale: string): string {
  if (!dateStr) return '--';
  try {
    return new Date(dateStr).toLocaleString(locale, {
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return dateStr;
  }
}

function truncate(str: string | null, max: number): string {
  if (!str) return '--';
  return str.length > max ? str.slice(0, max) + '...' : str;
}

/** Returns a human-readable relative time like "2h 15m" or "< 1m" */
function relativeCountdown(dateStr: string | null): string | null {
  if (!dateStr) return null;
  const diff = new Date(dateStr).getTime() - Date.now();
  if (diff < 0) return null;
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return '< 1m';
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  const remMins = mins % 60;
  if (hrs < 24) return remMins > 0 ? `${hrs}h ${remMins}m` : `${hrs}h`;
  const days = Math.floor(hrs / 24);
  const remHrs = hrs % 24;
  return remHrs > 0 ? `${days}d ${remHrs}h` : `${days}d`;
}

// ═════════════════════════════════════════════════════════
// Main Component
// ═════════════════════════════════════════════════════════
export default function Scheduler() {
  const api = useApi();
  const { t, lang } = useI18n();
  const sc = t.scheduler;

  const [tasks, setTasks] = useState<ScheduledTaskRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<FilterTab>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [expandedTaskId, setExpandedTaskId] = useState<number | null>(null);
  const [historyMap, setHistoryMap] = useState<Record<number, TaskExecutionRow[]>>({});
  const [historyLoading, setHistoryLoading] = useState<number | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<number | null>(null);
  const [_tick, setTick] = useState(0); // for countdown refresh

  // Modal state
  const [modalOpen, setModalOpen] = useState(false);
  const [editTask, setEditTask] = useState<ScheduledTaskRow | undefined>(undefined);

  // Predefined actions fetched from backend registry (single source of truth)
  const [predefinedActions, setPredefinedActions] = useState<PredefinedAction[]>([]);
  useEffect(() => {
    api.schedulerListActions().then(setPredefinedActions).catch(() => setPredefinedActions([]));
  }, [api]);

  const locale = lang === 'zh' ? 'zh-CN' : 'en-US';

  // Status label lookup
  const statusLabel = (status: string): string => {
    const map: Record<string, string> = {
      active: sc.status_active, paused: sc.status_paused,
      running: sc.status_active, failed: sc.status_error, completed: sc.status_done,
    };
    return map[status] || status;
  };

  const execStatusLabel = (status: string): string => {
    const map: Record<string, string> = {
      success: sc.exec_success, failed: sc.exec_failed,
      running: sc.exec_running, skipped: sc.exec_skipped,
    };
    return map[status] || status;
  };

  const scheduleTypeLabel = (type: string): string => {
    const map: Record<string, string> = {
      cron: sc.schedule_cron, interval: sc.schedule_interval, once: sc.schedule_once,
    };
    return map[type] || type;
  };

  const actionLabel = (action: string): string => {
    const found = predefinedActions.find((a) => a.name === action);
    if (found) return lang === 'zh' ? found.label_zh : found.label_en;
    return truncate(action, 40);
  };

  // ─── Load tasks ─────────────────────────────────────
  const loadTasks = useCallback(async () => {
    try {
      const list = await api.schedulerList();
      setTasks(list || []);
    } catch {
      setTasks([]);
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    loadTasks();
    const timer = setInterval(loadTasks, 5_000);
    return () => clearInterval(timer);
  }, [loadTasks]);

  // Tick every 30s to refresh countdowns
  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => clearInterval(timer);
  }, []);

  // ─── Actions ────────────────────────────────────────
  const handleRunNow = async (id: number) => {
    try { await api.schedulerRunNow(id); await loadTasks(); }
    catch (err) { console.error('[Scheduler] runNow failed:', err); }
  };

  const handlePause = async (id: number) => {
    try { await api.schedulerPause(id); await loadTasks(); }
    catch (err) { console.error('[Scheduler] pause failed:', err); }
  };

  const handleResume = async (id: number) => {
    try { await api.schedulerResume(id); await loadTasks(); }
    catch (err) { console.error('[Scheduler] resume failed:', err); }
  };

  const handleDeleteConfirm = async (id: number) => {
    try {
      await api.schedulerDelete(id);
      setTasks((prev) => prev.filter((t) => t.id !== id));
      if (expandedTaskId === id) setExpandedTaskId(null);
    } catch (err) {
      console.error('[Scheduler] delete failed:', err);
    } finally {
      setDeleteConfirmId(null);
    }
  };

  const handleEdit = (task: ScheduledTaskRow) => { setEditTask(task); setModalOpen(true); };
  const handleCreate = () => { setEditTask(undefined); setModalOpen(true); };

  // ─── Expand history ─────────────────────────────────
  const toggleHistory = async (taskId: number) => {
    if (expandedTaskId === taskId) { setExpandedTaskId(null); return; }
    setExpandedTaskId(taskId);
    if (!historyMap[taskId]) {
      setHistoryLoading(taskId);
      try {
        const history = await api.schedulerHistory(taskId);
        setHistoryMap((prev) => ({ ...prev, [taskId]: history || [] }));
      } catch {
        setHistoryMap((prev) => ({ ...prev, [taskId]: [] }));
      } finally {
        setHistoryLoading(null);
      }
    }
  };

  // ─── Filter & Search ───────────────────────────────
  const filtered = tasks.filter((t) => {
    if (filter === 'active' && t.status !== 'active' && t.status !== 'running') return false;
    if (filter === 'paused' && t.status !== 'paused') return false;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      return (
        t.name.toLowerCase().includes(q) ||
        (t.action || '').toLowerCase().includes(q) ||
        (t.schedule_display || '').toLowerCase().includes(q)
      );
    }
    return true;
  });

  // ─── Counts ─────────────────────────────────────────
  const activeCount = tasks.filter((t) => t.status === 'active' || t.status === 'running').length;
  const pausedCount = tasks.filter((t) => t.status === 'paused').length;
  const failedCount = tasks.filter((t) => t.status === 'failed').length;


  // Next upcoming task
  const nextUp = useMemo(() => {
    const upcoming = tasks
      .filter((t) => t.next_run_at && (t.status === 'active' || t.status === 'running'))
      .sort((a, b) => new Date(a.next_run_at!).getTime() - new Date(b.next_run_at!).getTime());
    return upcoming[0] || null;
  }, [tasks]);

  // ─── Render ─────────────────────────────────────────
  return (
    <div className="kz-page">
      {/* ── Page Header ──────────────────────────────── */}
      <div className="kz-ph">
        <div>
          <div className="kz-ph__title">{sc.title}</div>
          <div className="kz-ph__sub">{sc.desc}</div>
        </div>
      </div>

      {/* ── Stats Strip ─────────────────────────────────── */}
      <div className="grid grid-cols-4 gap-3 mb-5">
        {[
          { label: sc.task_count, value: tasks.length, icon: CalendarClock, sdot: 'kz-sdot--accent' },
          { label: sc.active_count, value: activeCount, icon: Activity, sdot: 'kz-sdot--success' },
          { label: sc.paused_count, value: pausedCount, icon: Pause, sdot: 'kz-sdot--warn' },
          { label: sc.error_count, value: failedCount, icon: TriangleAlert, sdot: 'kz-sdot--danger' },
        ].map((stat) => (
          <div key={stat.label} className="kz-paper px-5 py-4">
            <div className="flex items-center justify-between mb-2">
              <span className={`kz-sdot ${stat.sdot}`} />
              <stat.icon size={14} strokeWidth={1.4} className="kz-text-faint" />
            </div>
            <div className="kz-num-display text-3xl kz-text-ink tabular-nums">
              {loading ? <span className="kz-sk inline-block w-8 h-7" /> : stat.value}
            </div>
            <div className="kz-serif-italic text-[12px] kz-text-mute mt-1">
              {stat.label}
            </div>
          </div>
        ))}
      </div>

      {/* Next execution banner */}
      {nextUp && (
        <div className="kz-card px-4 py-2.5 mb-4 flex items-center gap-2">
          <span className="kz-sdot kz-sdot--success" />
          <span className="text-[11px] kz-mono kz-text-mute uppercase tracking-wider">
            {lang === 'zh' ? '下一个执行' : 'NEXT'}
          </span>
          <span className="text-[12px] kz-text-ink">{nextUp.name}</span>
          <span className="kz-text-faint">—</span>
          <span className="text-[11px] kz-mono kz-text-accent tabular-nums">
            {relativeCountdown(nextUp.next_run_at) || formatTime(nextUp.next_run_at, locale)}
          </span>
        </div>
      )}

      {/* ── Filter Bar ──────────────────────────────────── */}
      <div className="flex items-center justify-between gap-3 mb-4">
        <div className="flex items-center gap-2 flex-wrap">
          {([
            { key: 'all' as FilterTab, label: sc.filter_all, count: tasks.length },
            { key: 'active' as FilterTab, label: sc.filter_active, count: activeCount },
            { key: 'paused' as FilterTab, label: sc.filter_paused, count: pausedCount },
          ]).map((tab) => (
            <button
              key={tab.key}
              onClick={() => setFilter(tab.key)}
              className={`kz-chip ${filter === tab.key ? 'kz-chip--on' : 'kz-chip--outline'}`}
            >
              {tab.label}
              {tab.count > 0 && (
                <span className="kz-chip__count tabular-nums">{tab.count}</span>
              )}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2">
          <div className="kz-search-wrap w-56">
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={sc.search_placeholder}
            />
          </div>
          <button
            onClick={handleCreate}
            className="kz-btn kz-btn--primary kz-btn--sm"
          >
            <Plus size={13} strokeWidth={2} />
            {sc.new_task}
          </button>
        </div>
      </div>

      {/* ── Task List ───────────────────────────────────── */}
      <div>
        {loading ? (
          <div className="space-y-2">
            {[0, 1, 2].map((i) => (
              <div key={i} className="kz-card p-4" style={{ animationDelay: `${i * 80}ms` }}>
                <div className="flex gap-3">
                  <div className="kz-sk w-32 h-4" />
                  <div className="kz-sk w-16 h-4" />
                </div>
                <div className="kz-sk w-48 h-3 mt-3" />
                <div className="kz-sk w-64 h-3 mt-2" />
              </div>
            ))}
          </div>
        ) : filtered.length === 0 ? (
          /* ── Empty State ─────────────────────────────── */
          <div className="kz-empty">
            <div className="kz-empty__icon">
              <Terminal size={22} strokeWidth={1.2} />
            </div>
            <div>
              <div className="kz-empty__title">
                {tasks.length === 0 ? sc.no_tasks : sc.search_placeholder}
              </div>
              <div className="kz-empty__sub">
                {sc.no_tasks_hint}
              </div>
            </div>
            {tasks.length === 0 && (
              <div className="kz-empty__actions">
                <button
                  onClick={handleCreate}
                  className="kz-btn kz-btn--primary kz-btn--sm"
                >
                  <Plus size={14} />
                  {sc.new_task}
                </button>
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-2">
            {filtered.map((task, idx) => {
              const cfg = STATUS_CONFIG[task.status] || STATUS_CONFIG.active;
              const isExpanded = expandedTaskId === task.id;
              const history = historyMap[task.id];
              const isPredefined = predefinedActions.some((a) => a.name === task.action);
              const taskActionLabel = isPredefined ? actionLabel(task.action) : truncate(task.action, 40);
              const countdown = relativeCountdown(task.next_run_at);
              const isRunning = task.status === 'running';

              return (
                <div
                  key={task.id}
                  className="kz-card kz-anim-in overflow-hidden"
                  style={{
                    animationDelay: `${idx * 40}ms`,
                    boxShadow: `inset 3px 0 0 ${cfg.accent}`,
                  }}
                >
                  {/* ── Card Body ──────────────────────────── */}
                  <div className="px-4 py-3">
                    <div className="flex items-start gap-3">
                      {/* Left: info */}
                      <div className="flex-1 min-w-0">
                        {/* Row 1: Name + Status + Schedule type */}
                        <div className="flex items-center gap-2 mb-1.5">
                          <span className="kz-serif text-[15px] kz-text-ink truncate">
                            {task.name}
                          </span>
                          <span className={`kz-badge ${cfg.badge}`}>
                            {isRunning ? (
                              <Loader2 size={9} className="animate-spin" />
                            ) : (
                              <span className={`kz-sdot ${cfg.sdot}`} style={{ width: 5, height: 5 }} />
                            )}
                            {statusLabel(task.status)}
                          </span>
                          <span className="kz-badge kz-badge--mute">
                            {task.schedule_type === 'once' ? <Timer size={9} /> : <Repeat size={9} />}
                            {scheduleTypeLabel(task.schedule_type)}
                          </span>
                        </div>

                        {/* Row 2: Action + schedule expression + permission */}
                        <div className="flex items-center gap-2 text-[11px] kz-mono kz-text-mute mb-1.5">
                          <span className="kz-text-soft">{taskActionLabel}</span>
                          <span className="kz-text-faint">|</span>
                          <span>{task.schedule_display || task.schedule_expr || '--'}</span>
                          {task.permission_level === 'readwrite' && (
                            <>
                              <span className="kz-text-faint">|</span>
                              <span className="kz-badge kz-badge--warn">
                                {sc.permission_readwrite}
                              </span>
                            </>
                          )}
                        </div>

                        {/* Row 3: Last run / Next run / Stats */}
                        <div className="flex items-center gap-4 text-[11px] kz-mono">
                          <span className="kz-text-mute">
                            {sc.last_run}:{' '}
                            {task.last_run_at ? (
                              <span className="inline-flex items-center gap-1 kz-text-soft">
                                {formatTime(task.last_run_at, locale)}
                                {task.last_run_status === 'success' && <CheckCircle2 size={10} style={{ color: 'var(--c-success)' }} />}
                                {task.last_run_status === 'failed' && <AlertCircle size={10} style={{ color: 'var(--c-danger)' }} />}
                              </span>
                            ) : (
                              <span className="kz-text-faint">--</span>
                            )}
                          </span>
                          <span className="kz-text-mute">
                            {sc.next_run}:{' '}
                            {countdown ? (
                              <span className="kz-text-accent tabular-nums">{countdown}</span>
                            ) : (
                              <span className={task.next_run_at ? 'kz-text-soft' : 'kz-text-faint'}>
                                {formatTime(task.next_run_at, locale)}
                              </span>
                            )}
                          </span>
                          {task.run_count > 0 && (
                            <span className="kz-text-faint tabular-nums">
                              {task.run_count}x
                              {task.fail_count > 0 && (
                                <span style={{ color: 'var(--c-danger)' }} className="ml-1">({task.fail_count} err)</span>
                              )}
                            </span>
                          )}
                        </div>
                      </div>

                      {/* Right: action buttons */}
                      <div className="flex items-center gap-0.5 flex-shrink-0">
                        {task.status === 'paused' ? (
                          <ActionBtn icon={Play} title={sc.resume} onClick={() => handleResume(task.id)} />
                        ) : (
                          <ActionBtn icon={Pause} title={sc.pause} onClick={() => handlePause(task.id)} />
                        )}
                        <ActionBtn icon={Zap} title={sc.run_now} onClick={() => handleRunNow(task.id)} />
                        <ActionBtn icon={Pencil} title={sc.edit} onClick={() => handleEdit(task)} />

                        {deleteConfirmId === task.id ? (
                          <div className="flex items-center gap-1 ml-1">
                            <button
                              onClick={() => handleDeleteConfirm(task.id)}
                              className="kz-btn kz-btn--danger kz-btn--sm"
                            >
                              {t.common.confirm}
                            </button>
                            <button
                              onClick={() => setDeleteConfirmId(null)}
                              className="kz-btn kz-btn--sm"
                            >
                              {t.settings.clear_db_cancel}
                            </button>
                          </div>
                        ) : (
                          <ActionBtn icon={Trash2} title={sc.delete} onClick={() => setDeleteConfirmId(task.id)} />
                        )}

                        <ActionBtn
                          icon={History}
                          title={sc.history}
                          onClick={() => toggleHistory(task.id)}
                          active={isExpanded}
                        />
                      </div>
                    </div>
                  </div>

                  {/* ── History Panel ──────────────────────── */}
                  {isExpanded && (
                    <div style={{ borderTop: '1px solid var(--line-soft)', background: 'var(--bg-elev)' }}>
                      <div className="px-4 py-3">
                        <h3 className="kz-section-title mb-2">
                          <History size={11} className="kz-text-mute" />
                          <span>{sc.history}</span>
                        </h3>

                        {historyLoading === task.id ? (
                          <div className="flex items-center gap-2 py-4 justify-center">
                            <Loader2 size={12} className="animate-spin kz-text-mute" />
                            <span className="text-[11px] kz-mono kz-text-mute">{t.common.loading}</span>
                          </div>
                        ) : !history || history.length === 0 ? (
                          <div className="text-center py-4 text-[11px] kz-serif-italic kz-text-faint">
                            {sc.no_tasks}
                          </div>
                        ) : (
                          <div className="space-y-0">
                            {history.map((exec, i) => {
                              const execStyle = EXEC_STATUS_ICON[exec.status] || EXEC_STATUS_ICON.failed;
                              const ExecIcon = execStyle.icon;
                              return (
                                <div
                                  key={exec.id}
                                  className="flex items-start gap-3 py-2 first:pt-0"
                                  style={i > 0 ? { borderTop: '1px solid var(--line-soft)' } : undefined}
                                >
                                  {/* Timeline dot */}
                                  <div className="flex flex-col items-center pt-0.5">
                                    <div
                                      className="w-[18px] h-[18px] rounded-full flex items-center justify-center"
                                      style={{ background: 'var(--bg-card)', border: '1px solid var(--line)' }}
                                    >
                                      <ExecIcon
                                        size={11}
                                        style={{ color: execStyle.iconColor }}
                                        className={exec.status === 'running' ? 'animate-spin' : ''}
                                      />
                                    </div>
                                    {i < history.length - 1 && (
                                      <div className="w-px flex-1 mt-1" style={{ background: 'var(--line-soft)' }} />
                                    )}
                                  </div>

                                  {/* Content */}
                                  <div className="flex-1 min-w-0 pb-1">
                                    <div className="flex items-center gap-2 text-[11px] kz-mono">
                                      <span className={`kz-badge ${execStyle.badge}`}>
                                        {execStatusLabel(exec.status)}
                                      </span>
                                      <span className="kz-text-mute tabular-nums">
                                        {formatTime(exec.started_at, locale)}
                                      </span>
                                      {exec.finished_at && exec.started_at && (
                                        <span className="kz-text-faint tabular-nums">
                                          {Math.round((new Date(exec.finished_at).getTime() - new Date(exec.started_at).getTime()) / 1000)}s
                                        </span>
                                      )}
                                    </div>
                                    {exec.result_summary && (
                                      <div className="text-[11px] kz-mono kz-text-soft mt-0.5 truncate" title={exec.result_summary}>
                                        {truncate(exec.result_summary, 80)}
                                      </div>
                                    )}
                                    {exec.error_message && (
                                      <div className="text-[11px] kz-mono mt-0.5 truncate" style={{ color: 'var(--c-danger)' }} title={exec.error_message}>
                                        {truncate(exec.error_message, 80)}
                                      </div>
                                    )}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ── Modal ────────────────────────────────────────── */}
      <SchedulerTaskModal
        open={modalOpen}
        task={editTask}
        onClose={() => { setModalOpen(false); setEditTask(undefined); }}
        onSaved={() => loadTasks()}
      />
    </div>
  );
}

// ─── Small Components ─────────────────────────────────────
function ActionBtn({ icon: Icon, title, onClick, active }: {
  icon: typeof Play; title: string; onClick: () => void; active?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`kz-btn kz-btn--ghost kz-btn--sm ${active ? 'kz-text-ink' : 'kz-text-mute'}`}
      style={{ width: 28, padding: 0, justifyContent: 'center' }}
    >
      <Icon size={14} />
    </button>
  );
}
