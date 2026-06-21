import React, { useMemo, useState, useRef, useCallback, useEffect, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { CalendarDays, ChevronLeft, ChevronRight, Mic, Sparkles, FileText } from 'lucide-react';
import { useI18n } from '../../i18n';
import { useApi, CuratedDay } from '../../hooks/useApi';
import { toLocalDateStr } from './types';

interface ActivityStripProps {
  calendarActivity: { date: string; count: number }[];
  todayStr: string;
  onNavigate: (path: string) => void;
}

// Build the cells for a given month: leading blanks for the first week,
// every day of the month, then trailing blanks to round out the final week.
function buildMonthCells(year: number, month: number /* 0-indexed */, firstDayOfWeek: 0 | 1) {
  const firstOfMonth = new Date(year, month, 1);
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const startWeekday = firstOfMonth.getDay(); // 0=Sun..6=Sat
  const leading = (startWeekday - firstDayOfWeek + 7) % 7;
  const cells: (Date | null)[] = [];
  for (let i = 0; i < leading; i++) cells.push(null);
  for (let day = 1; day <= daysInMonth; day++) cells.push(new Date(year, month, day));
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}

// ─── DayTooltip — portal-mounted, anchored to the right of the cursor ───
interface DayTooltipProps {
  dateStr: string;
  cursor: { x: number; y: number };
  data: CuratedDay | undefined;
  lang: 'zh' | 'en';
  todayStr: string;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  onItemClick: (recordingId: number) => void;
  onDayClick: (dateStr: string) => void;
}

// ── Pure layout helper: place tooltip relative to cursor + viewport ──
// Preference order (per user spec — keep on the right whenever possible):
//   1. Right of cursor with gap.
//   2. Left of cursor with gap.
//   3. Clamp to whichever edge maximises space.
// Vertical: try cursor.y - 12; clamp inside [MARGIN, innerHeight - height - MARGIN].
const TOOLTIP_WIDTH = 280;
const TOOLTIP_GAP = 14;
const VP_MARGIN = 8;
function computeTooltipPos(cursor: { x: number; y: number }, width: number, height: number) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let left: number;
  if (cursor.x + TOOLTIP_GAP + width <= vw - VP_MARGIN) {
    left = cursor.x + TOOLTIP_GAP;                       // ① right of cursor
  } else if (cursor.x - TOOLTIP_GAP - width >= VP_MARGIN) {
    left = cursor.x - TOOLTIP_GAP - width;               // ② left of cursor
  } else {                                               // ③ neither side fits cleanly
    left = cursor.x > vw / 2 ? VP_MARGIN : vw - width - VP_MARGIN;
  }
  let top = cursor.y - 12;
  if (top + height > vh - VP_MARGIN) top = vh - height - VP_MARGIN;
  if (top < VP_MARGIN) top = VP_MARGIN;
  return { top, left };
}

function DayTooltip({ dateStr, cursor, data, lang, todayStr, onMouseEnter, onMouseLeave, onItemClick, onDayClick }: DayTooltipProps) {
  // Format heading: "5月 18日" or "May 18"
  const dt = useMemo(() => new Date(`${dateStr}T00:00:00`), [dateStr]);
  const isToday = dateStr === todayStr;
  const heading = useMemo(() => {
    if (lang === 'zh') {
      return `${dt.getMonth() + 1} 月 ${dt.getDate()} 日`;
    }
    return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }, [dt, lang]);
  const weekday = dt.toLocaleDateString(lang === 'zh' ? 'zh-CN' : 'en-US', { weekday: 'short' });

  // Position: initial estimate, then re-measure actual size after render.
  const tooltipRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState(() => computeTooltipPos(cursor, TOOLTIP_WIDTH, 200));
  useLayoutEffect(() => {
    const el = tooltipRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const next = computeTooltipPos(cursor, rect.width || TOOLTIP_WIDTH, rect.height || 200);
    setPos((prev) => {
      if (Math.abs(prev.top - next.top) < 0.5 && Math.abs(prev.left - next.left) < 0.5) return prev;
      return next;
    });
  });

  // Total event count + meaningful items to surface
  const sessions = data?.sessions ?? [];
  const standalones = data?.standalones ?? [];
  const briefs = data?.briefs ?? [];
  const totalItems = sessions.length + standalones.length + briefs.length;

  // Build a flat list of "highlights" for the body. Sessions first (richer), then standalones.
  type Item = { kind: 'session' | 'standalone' | 'brief'; key: string; title: string; meta: string; importance: number; recordingId: number };
  const items: Item[] = [];
  for (const s of sessions) {
    const t = s.session.topic || (lang === 'zh' ? '未命名会话' : 'Untitled session');
    const time = s.session.started_at
      ? new Date(s.session.started_at).toLocaleTimeString(lang === 'zh' ? 'zh-CN' : 'en-US', { hour: '2-digit', minute: '2-digit' })
      : '';
    items.push({
      kind: 'session',
      key: `s-${s.session.id}`,
      title: t,
      meta: `${s.members.length} ${lang === 'zh' ? '条录音' : 'recordings'}${time ? ' · ' + time : ''}`,
      importance: s.session.importance_score || 0,
      recordingId: s.members[0]?.id ?? 0, // open first member of the session
    });
  }
  for (const r of standalones) {
    const title = r.custom_title || r.auto_title || r.file_name.replace(/\.[^.]+$/, '') || (lang === 'zh' ? '录音' : 'Recording');
    const time = r.recorded_at
      ? new Date(r.recorded_at).toLocaleTimeString(lang === 'zh' ? 'zh-CN' : 'en-US', { hour: '2-digit', minute: '2-digit' })
      : '';
    items.push({
      kind: 'standalone',
      key: `r-${r.id}`,
      title,
      meta: time,
      importance: r.importance_score || 0,
      recordingId: r.id,
    });
  }
  // Sort by importance desc, then keep at most 5
  items.sort((a, b) => b.importance - a.importance);
  const visible = items.slice(0, 5);
  const extra = items.length - visible.length;

  const loading = data === undefined;

  return createPortal(
    <div
      ref={tooltipRef}
      className="kz-paper kz-anim-in"
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      style={{
        position: 'fixed',
        top: pos.top,
        left: pos.left,
        width: TOOLTIP_WIDTH,
        zIndex: 1000,
        padding: 14,
        boxShadow: '0 10px 32px oklch(0 0 0 / 0.35), 0 2px 8px oklch(0 0 0 / 0.2)',
      }}
    >
      {/* Header: serif date + weekday + today badge */}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 10 }}>
        <span className="kz-serif" style={{ fontSize: 17, color: 'var(--ink)', letterSpacing: '-0.01em' }}>{heading}</span>
        <span className="kz-mono kz-text-mute" style={{ fontSize: 10.5, letterSpacing: '0.06em' }}>{weekday}</span>
        {isToday && (
          <span
            className="kz-mono"
            style={{
              marginLeft: 'auto', fontSize: 10, padding: '1px 6px', borderRadius: 4,
              background: 'var(--c-accent-bg)', color: 'var(--c-accent)', letterSpacing: '0.06em',
            }}
          >
            {lang === 'zh' ? '今天' : 'TODAY'}
          </span>
        )}
      </div>

      {/* Body */}
      {loading ? (
        <div className="kz-text-mute kz-serif-italic" style={{ fontSize: 12, padding: '6px 0' }}>
          {lang === 'zh' ? '加载中…' : 'Loading…'}
        </div>
      ) : totalItems === 0 ? (
        <div className="kz-text-mute kz-serif-italic" style={{ fontSize: 12, padding: '6px 0' }}>
          {lang === 'zh' ? '当天没有可显示的内容。' : 'Nothing to surface for this day.'}
        </div>
      ) : (
        <>
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
            {visible.map((it) => {
              const Icon = it.kind === 'session' ? Sparkles : it.kind === 'standalone' ? Mic : FileText;
              const iconColor = it.kind === 'session' ? 'var(--c-accent)' : it.kind === 'standalone' ? 'var(--c-info)' : 'var(--ink-mute)';
              return (
                <li key={it.key}>
                  <button
                    onClick={() => it.recordingId && onItemClick(it.recordingId)}
                    disabled={!it.recordingId}
                    style={{
                      width: '100%',
                      display: 'flex', gap: 8, alignItems: 'flex-start',
                      padding: '6px 6px',
                      borderRadius: 6,
                      background: 'transparent',
                      border: 0,
                      cursor: it.recordingId ? 'pointer' : 'default',
                      textAlign: 'left',
                      fontFamily: 'inherit',
                      transition: 'background 0.12s',
                    }}
                    onMouseEnter={(e) => { if (it.recordingId) e.currentTarget.style.background = 'var(--bg-elev)'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                  >
                    <Icon size={11} style={{ color: iconColor, marginTop: 3, flexShrink: 0 }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div
                        style={{
                          fontSize: 12.5, color: 'var(--ink)', lineHeight: 1.4,
                          overflow: 'hidden', textOverflow: 'ellipsis', display: '-webkit-box',
                          WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
                        }}
                      >
                        {it.title}
                      </div>
                      {it.meta && (
                        <div className="kz-mono kz-text-mute" style={{ fontSize: 10, marginTop: 2, letterSpacing: '0.02em' }}>
                          {it.meta}
                        </div>
                      )}
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
          {extra > 0 && (
            <div className="kz-mono kz-text-faint" style={{ fontSize: 10.5, marginTop: 8, letterSpacing: '0.04em', paddingLeft: 6 }}>
              {(lang === 'zh' ? '还有 {n} 项…' : '+{n} more…').replace('{n}', String(extra))}
            </div>
          )}
          {briefs.length > 0 && (
            <div className="kz-text-faint kz-serif-italic" style={{ fontSize: 11, marginTop: 6, paddingLeft: 6 }}>
              {(lang === 'zh' ? '· {n} 条短记' : '· {n} brief notes').replace('{n}', String(briefs.length))}
            </div>
          )}
          {/* Footer: open the full day in Library */}
          <div style={{ marginTop: 10, paddingTop: 8, borderTop: '1px solid var(--line-soft)' }}>
            <button
              onClick={() => onDayClick(dateStr)}
              className="kz-mono"
              style={{
                background: 'transparent', border: 0, padding: 0, cursor: 'pointer',
                color: 'var(--ink-mute)', fontSize: 10.5, transition: 'color 0.12s',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--c-accent)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--ink-mute)'; }}
            >
              {lang === 'zh' ? '查看当天全部 →' : 'Open day in Library →'}
            </button>
          </div>
        </>
      )}
    </div>,
    document.body
  );
}

export const ActivityStrip = React.memo(function ActivityStrip({
  calendarActivity,
  todayStr,
  onNavigate,
}: ActivityStripProps) {
  const { t, lang } = useI18n();
  const api = useApi();
  const d = t.dash;
  const today = useMemo(() => new Date(), []);
  const [offset, setOffset] = useState(0);

  const anchor = useMemo(() => {
    return new Date(today.getFullYear(), today.getMonth() + offset, 1);
  }, [today, offset]);

  const firstDayOfWeek: 0 | 1 = lang === 'zh' ? 0 : 1;

  const cells = useMemo(
    () => buildMonthCells(anchor.getFullYear(), anchor.getMonth(), firstDayOfWeek),
    [anchor, firstDayOfWeek]
  );

  const activityMap = useMemo(
    () => new Map(calendarActivity.map((r) => [r.date, r.count])),
    [calendarActivity]
  );

  const max = useMemo(() => {
    let m = 0;
    for (const c of cells) {
      if (!c) continue;
      m = Math.max(m, activityMap.get(toLocalDateStr(c)) || 0);
    }
    return m || 1;
  }, [cells, activityMap]);

  const weekdayLabels = useMemo(() => {
    const base = new Date(2024, 5, 2); // 2024-06-02 is a Sunday
    const labels: string[] = [];
    for (let i = 0; i < 7; i++) {
      const dt = new Date(base);
      dt.setDate(base.getDate() + ((firstDayOfWeek + i) % 7));
      labels.push(dt.toLocaleDateString(lang === 'zh' ? 'zh-CN' : 'en-US', { weekday: 'short' }));
    }
    return labels;
  }, [firstDayOfWeek, lang]);

  const monthTitle = useMemo(() => {
    if (lang === 'zh') return `${anchor.getFullYear()} 年 ${anchor.getMonth() + 1} 月`;
    return anchor.toLocaleDateString('en-US', { year: 'numeric', month: 'long' });
  }, [anchor, lang]);

  // ─── Tooltip state ────────────────────────────────────────
  const [hoverDate, setHoverDate] = useState<string | null>(null);
  const [hoverCursor, setHoverCursor] = useState<{ x: number; y: number } | null>(null);
  const [dayCache, setDayCache] = useState<Map<string, CuratedDay>>(() => new Map());
  // Track the most recent mouse position via ref so we can show the tooltip
  // exactly where the cursor is when the hover delay fires, without paying
  // for a re-render on every mousemove.
  const lastCursorRef = useRef<{ x: number; y: number } | null>(null);
  const hoverTimerRef = useRef<number | null>(null);
  const closeTimerRef = useRef<number | null>(null);

  // Pre-load the day data lazily on first hover; cache for the session
  const ensureDayLoaded = useCallback((dateStr: string) => {
    if (dayCache.has(dateStr)) return;
    api.getTodayCuratedItems(dateStr)
      .then((c) => setDayCache((m) => {
        if (m.has(dateStr)) return m; // race guard
        const next = new Map(m); next.set(dateStr, c); return next;
      }))
      .catch(() => {});
  }, [api, dayCache]);

  const handleMouseEnter = useCallback((e: React.MouseEvent, dateStr: string) => {
    lastCursorRef.current = { x: e.clientX, y: e.clientY };
    if (closeTimerRef.current) { window.clearTimeout(closeTimerRef.current); closeTimerRef.current = null; }
    if (hoverTimerRef.current) window.clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = window.setTimeout(() => {
      const pos = lastCursorRef.current;
      if (!pos) return;
      setHoverCursor(pos);
      setHoverDate(dateStr);
      ensureDayLoaded(dateStr);
    }, 200);
  }, [ensureDayLoaded]);

  // Cheap: only updates a ref, no re-render. Keeps the tooltip-anchor in sync
  // with the cursor right up to the moment the 200ms delay fires.
  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    lastCursorRef.current = { x: e.clientX, y: e.clientY };
  }, []);

  const handleMouseLeave = useCallback(() => {
    if (hoverTimerRef.current) { window.clearTimeout(hoverTimerRef.current); hoverTimerRef.current = null; }
    // Grace period long enough for the cursor to bridge the gap (14px) into
    // the tooltip itself. The tooltip's own onMouseEnter will cancel this if
    // the user lands inside it. 180ms is comfortable but not sluggish.
    if (closeTimerRef.current) window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = window.setTimeout(() => {
      setHoverDate(null);
      setHoverCursor(null);
    }, 180);
  }, []);

  // Tooltip-hover bridging: keep open while the cursor is inside it.
  const handleTooltipEnter = useCallback(() => {
    if (closeTimerRef.current) { window.clearTimeout(closeTimerRef.current); closeTimerRef.current = null; }
  }, []);
  const handleTooltipLeave = useCallback(() => {
    if (closeTimerRef.current) window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = window.setTimeout(() => {
      setHoverDate(null);
      setHoverCursor(null);
    }, 120);
  }, []);

  // Click-through actions
  const handleItemClick = useCallback((recordingId: number) => {
    onNavigate(`/library?recording=${recordingId}`);
    setHoverDate(null);
    setHoverCursor(null);
  }, [onNavigate]);
  const handleDayClick = useCallback((dateStr: string) => {
    onNavigate(`/library?date=${dateStr}`);
    setHoverDate(null);
    setHoverCursor(null);
  }, [onNavigate]);

  // Cleanup timers on unmount
  useEffect(() => () => {
    if (hoverTimerRef.current) window.clearTimeout(hoverTimerRef.current);
    if (closeTimerRef.current) window.clearTimeout(closeTimerRef.current);
  }, []);

  return (
    <div className="kz-paper" style={{ padding: 18, display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <h3 className="kz-section-title" style={{ marginBottom: 14, gap: 10 }}>
        <CalendarDays size={13} />
        <span>{d.activity_14d}</span>
        <span className="kz-mono kz-text-faint" style={{ marginLeft: 8, fontSize: 11, fontStyle: 'normal' }}>
          {monthTitle}
        </span>
        <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 4 }}>
          <button
            className="kz-btn kz-btn--ghost kz-btn--sm"
            onClick={() => setOffset((o) => o - 1)}
            title={lang === 'zh' ? '上个月' : 'Previous month'}
            style={{ padding: '0 8px', height: 24 }}
          >
            <ChevronLeft size={13} />
          </button>
          {offset !== 0 && (
            <button
              className="kz-btn kz-btn--ghost kz-btn--sm"
              onClick={() => setOffset(0)}
              title={lang === 'zh' ? '回到本月' : 'Back to today'}
              style={{ padding: '0 10px', height: 24, fontSize: 11 }}
            >
              {lang === 'zh' ? '今天' : 'Today'}
            </button>
          )}
          <button
            className="kz-btn kz-btn--ghost kz-btn--sm"
            onClick={() => setOffset((o) => o + 1)}
            title={lang === 'zh' ? '下个月' : 'Next month'}
            style={{ padding: '0 8px', height: 24 }}
          >
            <ChevronRight size={13} />
          </button>
        </span>
      </h3>

      {/* Weekday header */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(7, minmax(0, 1fr))',
          gap: 6,
          marginBottom: 6,
        }}
      >
        {weekdayLabels.map((wd) => (
          <div
            key={wd}
            className="kz-mono"
            style={{
              fontSize: 10,
              letterSpacing: '0.08em',
              color: 'var(--ink-mute)',
              textAlign: 'center',
              textTransform: 'uppercase',
            }}
          >
            {wd}
          </div>
        ))}
      </div>

      {/* Month grid — borderless cells, bg-tint for activity */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(7, minmax(0, 1fr))',
          gridAutoRows: '1fr',
          gap: 6,
          flex: 1,
          minHeight: 0,
        }}
      >
        {cells.map((cell, i) => {
          if (!cell) {
            return <div key={`pad-${i}`} style={{ minHeight: 56 }} />;
          }
          const dateStr = toLocalDateStr(cell);
          const isToday = dateStr === todayStr;
          const count = activityMap.get(dateStr) || 0;
          const hasData = count > 0;
          const fill = hasData ? 0.22 + 0.78 * (count / max) : 0;
          const fillPct = Math.round(fill * 18);
          const bg = isToday
            ? 'var(--c-accent)'
            : hasData
              ? `color-mix(in oklch, var(--c-accent) ${fillPct}%, transparent)`
              : 'transparent';
          const dayColor = isToday
            ? 'var(--c-accent-ink)'
            : 'var(--ink-soft)';
          const countColor = isToday
            ? 'var(--c-accent-ink)'
            : hasData
              ? 'var(--c-accent)'
              : 'var(--ink-faint)';
          return (
            <button
              key={dateStr}
              disabled={!hasData}
              onClick={() => hasData && onNavigate(`/library?date=${dateStr}`)}
              onMouseEnter={(e) => hasData && handleMouseEnter(e, dateStr)}
              onMouseMove={hasData ? handleMouseMove : undefined}
              onMouseLeave={() => hasData && handleMouseLeave()}
              style={{
                minHeight: 56,
                borderRadius: 8,
                padding: '6px 7px 8px',
                textAlign: 'left',
                background: bg,
                border: 0,
                cursor: hasData ? 'pointer' : 'default',
                transition: 'background 0.14s, box-shadow 0.14s',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'stretch',
                gap: 2,
                fontFamily: 'inherit',
                outline: 'none',
              }}
              onFocus={(e) => {
                if (hasData) e.currentTarget.style.boxShadow = '0 0 0 2px color-mix(in oklch, var(--c-accent) 35%, transparent) inset';
              }}
              onBlur={(e) => { e.currentTarget.style.boxShadow = 'none'; }}
              onMouseOver={(e) => {
                if (hasData && !isToday) {
                  e.currentTarget.style.background = `color-mix(in oklch, var(--c-accent) ${Math.min(28, fillPct + 8)}%, transparent)`;
                }
              }}
              onMouseOut={(e) => {
                if (hasData && !isToday) {
                  e.currentTarget.style.background = bg;
                }
              }}
            >
              <span
                className="kz-mono"
                style={{
                  fontSize: 10.5,
                  letterSpacing: '0.04em',
                  color: dayColor,
                  lineHeight: 1,
                }}
              >
                {cell.getDate()}
              </span>
              {hasData && (
                <span
                  className="kz-num-display"
                  style={{
                    fontSize: 16,
                    marginTop: 'auto',
                    color: countColor,
                    lineHeight: 1,
                    alignSelf: 'flex-end',
                  }}
                >
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Tooltip */}
      {hoverDate && hoverCursor && (
        <DayTooltip
          dateStr={hoverDate}
          cursor={hoverCursor}
          data={dayCache.get(hoverDate)}
          lang={lang as 'zh' | 'en'}
          todayStr={todayStr}
          onMouseEnter={handleTooltipEnter}
          onMouseLeave={handleTooltipLeave}
          onItemClick={handleItemClick}
          onDayClick={handleDayClick}
        />
      )}
    </div>
  );
});
