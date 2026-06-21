import React, { useState } from 'react';
import {
  Layers,
  ChevronDown,
  Mic,
  Video,
  FileText,
  File,
  Image as ImageIcon,
  Clock,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useI18n } from '../../i18n';
import { deriveRecordingTitle } from '../../utils/recordingTitle';
import type { SessionRow, RecordingRow } from '../../hooks/useApi';

interface SessionCardProps {
  session: SessionRow;
  members: RecordingRow[];
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

function fmtMinutes(totalSec: number): string {
  const m = Math.floor(totalSec / 60);
  if (m >= 1) return `${m}min`;
  return `${Math.round(totalSec)}s`;
}

export const SessionCard = React.memo(function SessionCard({
  session,
  members,
  onNavigate,
}: SessionCardProps) {
  const { t, lang } = useI18n();
  const d = t.dash;
  const [expanded, setExpanded] = useState(false);

  const totalDur = members.reduce((s, m) => s + (m.duration_seconds || 0), 0);
  const startTime = members[0]?.recorded_at
    ? new Date(members[0].recorded_at).toLocaleTimeString(
        lang === 'zh' ? 'zh-CN' : 'en-US',
        { hour: '2-digit', minute: '2-digit' },
      )
    : '—';

  return (
    <div style={{ width: '100%' }}>
      <button
        onClick={() => setExpanded((x) => !x)}
        className="kz-row-hover"
        style={{
          width: '100%',
          padding: '14px 18px',
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
              background: 'var(--c-accent)',
              borderRadius: 999,
            }}
          />
          <span
            className="kz-mono kz-text-mute"
            style={{ fontSize: 11.5, width: 42, fontVariantNumeric: 'tabular-nums' }}
          >
            {startTime}
          </span>
          <Layers size={13} className="kz-text-accent shrink-0" />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            className="kz-serif"
            style={{
              fontSize: 14.5,
              color: 'var(--ink)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              letterSpacing: '-0.005em',
            }}
          >
            {session.topic || d.session_untitled}
          </div>
          <div
            className="kz-mono kz-text-mute"
            style={{ marginTop: 4, display: 'flex', alignItems: 'center', gap: 12, fontSize: 11 }}
          >
            <span>
              {members.length} {d.session_segments}
            </span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <Clock size={10} />
              {fmtMinutes(totalDur)}
            </span>
          </div>
          {session.summary && (
            <div
              className="kz-text-soft"
              style={{
                marginTop: 6,
                fontSize: 12.5,
                lineHeight: 1.55,
                display: '-webkit-box',
                WebkitLineClamp: 2,
                WebkitBoxOrient: 'vertical',
                overflow: 'hidden',
              }}
            >
              {session.summary}
            </div>
          )}
        </div>
        <ChevronDown
          size={14}
          className="kz-text-faint shrink-0"
          style={{
            marginTop: 4,
            transition: 'transform 0.18s',
            transform: expanded ? 'rotate(180deg)' : 'none',
          }}
        />
      </button>
      {expanded && (
        <ul
          style={{
            listStyle: 'none',
            margin: 0,
            padding: 0,
            borderTop: '1px solid var(--line-soft)',
            background: 'var(--bg-elev)',
          }}
        >
          {members.map((m, i) => {
            const Icon = MEDIA_ICON[m.media_type || 'audio'] || Mic;
            const time = m.recorded_at
              ? new Date(m.recorded_at).toLocaleTimeString(
                  lang === 'zh' ? 'zh-CN' : 'en-US',
                  { hour: '2-digit', minute: '2-digit' },
                )
              : '';
            return (
              <li
                key={m.id}
                style={{ borderTop: i ? '1px solid var(--line-soft)' : 0 }}
              >
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onNavigate(`/library?recording=${m.id}`);
                  }}
                  className="kz-row-hover"
                  style={{
                    width: '100%',
                    padding: '8px 18px',
                    textAlign: 'left',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                    background: 'transparent',
                    border: 0,
                  }}
                >
                  <span
                    className="kz-mono kz-text-faint"
                    style={{
                      fontSize: 10.5,
                      width: 42,
                      paddingLeft: 12,
                      fontVariantNumeric: 'tabular-nums',
                    }}
                  >
                    {time}
                  </span>
                  <Icon size={11} className="kz-text-mute shrink-0" />
                  <span
                    className="kz-text-soft"
                    style={{
                      flex: 1,
                      fontSize: 12,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {deriveRecordingTitle(m)}
                  </span>
                  {m.duration_seconds ? (
                    <span className="kz-mono kz-text-faint" style={{ fontSize: 10.5 }}>
                      {fmtMinutes(m.duration_seconds)}
                    </span>
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
});
