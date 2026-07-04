import React from 'react';
import { FileText } from 'lucide-react';
import { useI18n } from '../../i18n';
import { MeetingNotes } from '../../hooks/useApi';

interface MeetingNotesItem {
  recordingId: number;
  fileName: string;
  date: string;
  notes: MeetingNotes;
}

interface RecentMeetingsProps {
  meetingNotesList: MeetingNotesItem[];
  onNavigate: (path: string) => void;
}

export const RecentMeetings = React.memo(function RecentMeetings({
  meetingNotesList,
  onNavigate,
}: RecentMeetingsProps) {
  const { t } = useI18n();
  const d = t.dash;
  const items = Array.isArray(meetingNotesList) ? meetingNotesList : [];

  return (
    <div className="kz-paper" style={{ overflow: 'hidden' }}>
      <div
        style={{
          padding: '12px 18px',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'baseline',
        }}
      >
        <h3 className="kz-section-title" style={{ margin: 0 }}>
          <FileText size={12} />
          <span>{d.recent_notes}</span>
          <span className="kz-section-title__count">{items.length}</span>
        </h3>
        <button
          onClick={() => onNavigate('/library')}
          className="kz-btn kz-btn--ghost kz-btn--sm kz-text-soft"
        >
          {d.view_all_link} &rarr;
        </button>
      </div>
      {items.slice(0, 5).map((item, idx) => {
        const participants = Array.isArray(item.notes.participants) ? item.notes.participants : [];
        const decisions = Array.isArray(item.notes.decisions) ? item.notes.decisions : [];
        const actionItems = Array.isArray(item.notes.actionItems) ? item.notes.actionItems : [];
        const title = item.notes.title || item.fileName;
        const discussionSummary = item.notes.discussionSummary || (item.notes as any).summary || '';

        return (
          <div
            key={item.recordingId}
            onClick={() => onNavigate(`/library?recording=${item.recordingId}`)}
            className="kz-row-hover kz-anim-in"
            style={{
              padding: '14px 18px',
              borderTop: '1px solid var(--line-soft)',
              cursor: 'pointer',
              animationDelay: `${idx * 30}ms`,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 4 }}>
              <span className="kz-mono kz-text-mute" style={{ fontSize: 11 }}>
                {item.date}
              </span>
              <span
                className="kz-serif"
                style={{ fontSize: 14.5, color: 'var(--ink)', flex: 1, minWidth: 0 }}
              >
                <span style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {title}
                </span>
              </span>
            </div>
            <div
              className="kz-text-soft"
              style={{
                fontSize: 12.5,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                display: '-webkit-box',
                WebkitLineClamp: 1,
                WebkitBoxOrient: 'vertical',
                marginBottom: 6,
              }}
            >
              {discussionSummary}
            </div>
            <div
              className="kz-mono kz-text-faint"
              style={{ display: 'flex', gap: 12, fontSize: 11 }}
            >
              <span>
                {participants.length} {d.speakers_unit}
              </span>
              {decisions.length > 0 && (
                <span>
                  {decisions.length} {d.decisions_count}
                </span>
              )}
              {actionItems.length > 0 && (
                <span>
                  {actionItems.length} {d.actions_count}
                </span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
});
