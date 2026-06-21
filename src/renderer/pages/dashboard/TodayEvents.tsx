import React, { useState, useMemo } from 'react';
import {
  Mic,
  Video,
  FileText,
  File,
  Image as ImageIcon,
  Loader2,
  Clock,
  ChevronDown,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useI18n } from '../../i18n';
import { SessionCard } from './SessionCard';
import { deriveRecordingTitle } from '../../utils/recordingTitle';
import type { CuratedDay, RecordingRow, SessionRow } from '../../hooks/useApi';

interface TodayEventsProps {
  curated: CuratedDay | null;
  fallbackDate?: string | null;
  queueCount: number;
  onNavigate: (path: string) => void;
}

const MEDIA_ICON: Record<string, LucideIcon> = {
  audio: Mic,
  video: Video,
  pdf: FileText,
  docx: FileText,
  text: File,
  image: ImageIcon,
};

function MediaIcon({ mediaType }: { mediaType?: string | null }) {
  const Icon = MEDIA_ICON[mediaType || 'audio'] || Mic;
  return <Icon size={13} className="kz-text-mute shrink-0" />;
}

function fmtMinutes(sec: number): string {
  const m = Math.floor(sec / 60);
  if (m >= 1) return `${m}min`;
  return `${Math.round(sec)}s`;
}

function StandaloneRow({
  item,
  lang,
  onNavigate,
}: {
  item: RecordingRow;
  lang: string;
  onNavigate: (p: string) => void;
}) {
  const time = item.recorded_at
    ? new Date(item.recorded_at).toLocaleTimeString(
        lang === 'zh' ? 'zh-CN' : 'en-US',
        { hour: '2-digit', minute: '2-digit' },
      )
    : '—';
  const isAV = item.media_type === 'audio' || item.media_type === 'video';
  return (
    <button
      onClick={() => onNavigate(`/library?recording=${item.id}`)}
      className="kz-row-hover"
      style={{
        width: '100%',
        padding: '12px 18px',
        textAlign: 'left',
        display: 'flex',
        alignItems: 'flex-start',
        gap: 14,
        background: 'transparent',
        border: 0,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0, paddingTop: 2 }}>
        <span
          style={{
            width: 2,
            alignSelf: 'stretch',
            background: 'var(--line)',
            borderRadius: 999,
          }}
        />
        <span
          className="kz-mono kz-text-mute"
          style={{ fontSize: 11.5, width: 42, fontVariantNumeric: 'tabular-nums' }}
        >
          {time}
        </span>
        <MediaIcon mediaType={item.media_type} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          className="kz-serif"
          style={{
            fontSize: 14,
            color: 'var(--ink)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            letterSpacing: '-0.005em',
          }}
        >
          {deriveRecordingTitle(item)}
        </div>
        {isAV && item.duration_seconds ? (
          <div
            className="kz-mono kz-text-faint"
            style={{ marginTop: 4, display: 'flex', alignItems: 'center', gap: 12, fontSize: 11 }}
          >
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <Clock size={10} />
              {fmtMinutes(item.duration_seconds)}
            </span>
          </div>
        ) : null}
      </div>
    </button>
  );
}

type MixedRow =
  | { kind: 'session'; sortKey: string; session: SessionRow; members: RecordingRow[] }
  | { kind: 'standalone'; sortKey: string; item: RecordingRow };

export const TodayEvents = React.memo(function TodayEvents({
  curated,
  fallbackDate,
  queueCount,
  onNavigate,
}: TodayEventsProps) {
  const { t, lang } = useI18n();
  const d = t.dash;
  const [briefsExpanded, setBriefsExpanded] = useState(false);

  const mainItems: MixedRow[] = useMemo(() => {
    if (!curated) return [];
    const mixed: MixedRow[] = [
      ...curated.sessions.map((s) => ({
        kind: 'session' as const,
        sortKey: s.session.started_at || '',
        session: s.session,
        members: s.members,
      })),
      ...curated.standalones.map((it) => ({
        kind: 'standalone' as const,
        sortKey: it.recorded_at || '',
        item: it,
      })),
    ];
    mixed.sort((a, b) => b.sortKey.localeCompare(a.sortKey));
    return mixed;
  }, [curated]);

  const hasMain = mainItems.length > 0;
  const briefs = curated?.briefs ?? [];
  const hasBriefs = briefs.length > 0;
  const briefsTotalSec = briefs.reduce((s, b) => s + (b.duration_seconds || 0), 0);

  return (
    <div className="kz-paper" style={{ overflow: 'hidden' }}>
      {/* Header */}
      <div
        style={{
          padding: '12px 18px',
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          gap: 14,
        }}
      >
        <h3 className="kz-section-title" style={{ margin: 0, minWidth: 0 }}>
          <span>{fallbackDate ? d.recent_events : d.today_events}</span>
          {(hasMain || hasBriefs) && (
            <span className="kz-section-title__count">
              {fallbackDate || `${mainItems.length} ${d.items_unit}`}
            </span>
          )}
        </h3>
        {queueCount > 0 && (
          <button
            onClick={() => onNavigate('/sources')}
            className="kz-badge kz-badge--warn"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}
          >
            <Loader2 size={11} className="animate-spin" />
            {queueCount} {d.queue_status}
          </button>
        )}
      </div>

      {/* Empty state — true zero */}
      {!hasMain && !hasBriefs && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 10,
            padding: '24px 16px',
            borderTop: '1px solid var(--line-soft)',
          }}
        >
          <Mic size={14} className="kz-text-faint" />
          <span className="kz-serif-italic kz-text-mute" style={{ fontSize: 13 }}>
            {d.no_today_events}
          </span>
        </div>
      )}

      {/* Main events: sessions + standalones */}
      {hasMain && (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {mainItems.map((m, i) => (
            <li
              key={m.kind === 'session' ? `s-${m.session.id}` : `r-${m.item.id}`}
              className="kz-anim-in"
              style={{
                borderTop: '1px solid var(--line-soft)',
                animationDelay: `${i * 28}ms`,
              }}
            >
              {m.kind === 'session' ? (
                <SessionCard session={m.session} members={m.members} onNavigate={onNavigate} />
              ) : (
                <StandaloneRow item={m.item} lang={lang} onNavigate={onNavigate} />
              )}
            </li>
          ))}
        </ul>
      )}

      {/* Brief tail — collapsed by default */}
      {hasBriefs && (
        <div style={{ borderTop: '1px solid var(--line-soft)' }}>
          <button
            onClick={() => setBriefsExpanded((x) => !x)}
            className="kz-row-hover"
            style={{
              width: '100%',
              padding: '10px 18px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              background: 'transparent',
              border: 0,
              color: 'var(--ink-soft)',
            }}
          >
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
              <ChevronDown
                size={12}
                style={{
                  transition: 'transform 0.18s',
                  transform: briefsExpanded ? 'rotate(180deg)' : 'none',
                }}
              />
              <span className="kz-serif-italic" style={{ fontSize: 13 }}>
                {briefs.length} {d.brief_notes_label}
              </span>
            </span>
            <span className="kz-mono kz-text-faint" style={{ fontSize: 11 }}>
              {fmtMinutes(briefsTotalSec)} {d.brief_notes_total}
            </span>
          </button>
          {briefsExpanded && (
            <ul
              style={{
                listStyle: 'none',
                margin: 0,
                padding: 0,
                background: 'var(--bg-elev)',
                borderTop: '1px solid var(--line-soft)',
              }}
            >
              {briefs.map((b, i) => (
                <li
                  key={b.id}
                  style={{ borderTop: i ? '1px solid var(--line-soft)' : 0 }}
                >
                  <StandaloneRow item={b} lang={lang} onNavigate={onNavigate} />
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
});
