import { useState, useMemo } from 'react';
import { Plus, Pencil, Trash2 } from 'lucide-react';
import { Translations } from '../../i18n';
import { Session, UnifiedSession, relativeTime, groupUnifiedSessions } from './types';

interface SessionSidebarProps {
  unifiedSessions: UnifiedSession[];
  activeSessionId: number | null;
  activeSessionType: 'local' | 'channel';
  editingSessionId: number | null;
  editTitle: string;
  deleteConfirmId: number | null;
  isLoading: boolean;
  lang: string;
  a: Translations['asst'];
  t: Translations;
  onNewSession: () => void;
  onSelectUnifiedSession: (session: UnifiedSession) => void;
  onStartRename: (session: Session) => void;
  onEditTitleChange: (title: string) => void;
  onFinishRename: () => void;
  onCancelRename: () => void;
  onDeleteRequest: (id: number) => void;
  onDeleteConfirm: (id: number) => void;
  onDeleteCancel: () => void;
}

export default function SessionSidebar({
  unifiedSessions,
  activeSessionId,
  activeSessionType,
  editingSessionId,
  editTitle,
  deleteConfirmId,
  isLoading,
  lang,
  a,
  t,
  onNewSession,
  onSelectUnifiedSession,
  onStartRename,
  onEditTitleChange,
  onFinishRename,
  onCancelRename,
  onDeleteRequest,
  onDeleteConfirm,
  onDeleteCancel,
}: SessionSidebarProps) {
  // Filter chips: 'all' | 'local' | <channelId>
  const [filter, setFilter] = useState<string>('all');

  // Discover available channel categories from current sessions, preserving
  // order of first appearance so the chip row is stable across renders.
  const channelCategories = useMemo(() => {
    const seen = new Map<string, string>();
    for (const s of unifiedSessions) {
      if (s.type === 'channel' && s.channelId && !seen.has(s.channelId)) {
        seen.set(s.channelId, s.channelLabel || s.channelId);
      }
    }
    return Array.from(seen, ([id, label]) => ({ id, label }));
  }, [unifiedSessions]);

  // Hide the chip row entirely when there is nothing to filter against — a
  // user with only local sessions does not benefit from a single "All" chip.
  const showFilter = channelCategories.length > 0;

  // If the active filter no longer matches any visible category (e.g. last
  // session of that channel was deleted), fall back to 'all'.
  const effectiveFilter = filter !== 'all' && filter !== 'local' && !channelCategories.find(c => c.id === filter)
    ? 'all' : filter;

  const visibleSessions = useMemo(() => {
    if (effectiveFilter === 'all') return unifiedSessions;
    if (effectiveFilter === 'local') return unifiedSessions.filter(s => s.type === 'local');
    return unifiedSessions.filter(s => s.type === 'channel' && s.channelId === effectiveFilter);
  }, [unifiedSessions, effectiveFilter]);

  const grouped = groupUnifiedSessions(visibleSessions);

  function renderSession(session: UnifiedSession) {
    const isActive = session.id === activeSessionId && session.type === activeSessionType;
    const isEditing = editingSessionId === session.id && session.type === 'local';
    const isDeleting = deleteConfirmId === session.id && session.type === 'local';
    const isChannel = session.type === 'channel';

    return (
      <div
        key={`${session.type}-${session.id}`}
        onClick={() => { if (!isLoading && !isEditing) onSelectUnifiedSession(session); }}
        className={`group px-3 py-2.5 ${isActive ? 'kz-row-selected' : 'kz-row-hover'}`}
        style={{ borderRadius: 8 }}
      >
        <div className="flex items-center justify-between gap-2">
          {isEditing ? (
            <input
              autoFocus
              value={editTitle}
              onChange={(e) => onEditTitleChange(e.target.value)}
              onBlur={onFinishRename}
              onKeyDown={(e) => { if (e.key === 'Enter') onFinishRename(); if (e.key === 'Escape') onCancelRename(); }}
              className="kz-input flex-1"
              style={{ height: 28, padding: '0 8px', fontSize: 12 }}
              onClick={(e) => e.stopPropagation()}
            />
          ) : (
            <div className="flex items-center gap-1.5 flex-1 min-w-0">
              {isChannel && session.channelLabel && (
                <span
                  className="kz-mono kz-text-mute flex-shrink-0"
                  style={{ fontSize: 10, letterSpacing: '0.06em' }}
                >
                  {session.channelLabel}
                </span>
              )}
              <span
                className={`truncate ${isActive ? 'kz-text-ink' : 'kz-text-soft'}`}
                style={{ fontSize: 13 }}
              >
                {session.title}
              </span>
            </div>
          )}
          {!isEditing && !isDeleting && !isChannel && (
            <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
              <button
                onClick={(e) => { e.stopPropagation(); onStartRename({ id: session.id, title: session.title, created_at: '', updated_at: session.updatedAt }); }}
                className="kz-btn kz-btn--ghost kz-btn--sm"
                style={{ height: 22, padding: '0 6px' }}
                title={a.rename}
              >
                <Pencil size={11} />
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); onDeleteRequest(session.id); }}
                className="kz-btn kz-btn--ghost kz-btn--sm"
                style={{ height: 22, padding: '0 6px', color: 'var(--ink-mute)' }}
              >
                <Trash2 size={11} />
              </button>
            </div>
          )}
        </div>
        {isDeleting && (
          <div className="mt-1.5" onClick={(e) => e.stopPropagation()}>
            <div className="kz-mono mb-1" style={{ fontSize: 11, color: 'var(--c-danger)' }}>{a.delete_session}</div>
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => onDeleteConfirm(session.id)}
                className="kz-btn kz-btn--danger kz-btn--sm"
              >
                {t.common.confirm}
              </button>
              <button
                onClick={() => onDeleteCancel()}
                className="kz-btn kz-btn--sm"
              >
                {t.common.cancel}
              </button>
            </div>
          </div>
        )}
        {!isDeleting && (
          <div className="kz-mono kz-text-faint mt-1" style={{ fontSize: 10.5 }}>
            {relativeTime(session.updatedAt, a, lang === 'zh' ? 'zh-CN' : 'en-US')}
          </div>
        )}
      </div>
    );
  }

  function renderGroup(label: string, items: UnifiedSession[]) {
    if (items.length === 0) return null;
    return (
      <div className="mb-2">
        <div
          className="kz-serif-italic kz-text-mute px-3 py-1.5"
          style={{ fontSize: 11.5 }}
        >
          {label}
        </div>
        {items.map(renderSession)}
      </div>
    );
  }

  return (
    <div
      className="w-[280px] flex-shrink-0 flex flex-col kz-card-soft"
      style={{ borderRadius: 0, borderTop: 0, borderBottom: 0, borderLeft: 0 }}
    >
      <div className="px-3 py-2.5" style={{ borderBottom: '1px solid var(--line-soft)' }}>
        <button
          onClick={onNewSession}
          disabled={isLoading}
          className="kz-btn kz-btn--primary kz-btn--sm w-full justify-center"
        >
          <Plus size={12} />
          {a.new_chat}
        </button>
      </div>
      {showFilter && (
        <div
          className="px-3 py-2 no-scrollbar"
          style={{ borderBottom: '1px solid var(--line-soft)', display: 'flex', gap: 4, overflowX: 'auto' }}
        >
          {[
            { id: 'all', label: a.filter_all || 'All' },
            { id: 'local', label: a.filter_local || 'Local' },
            ...channelCategories,
          ].map((cat) => (
            <button
              key={cat.id}
              onClick={() => setFilter(cat.id)}
              className={`kz-chip ${effectiveFilter === cat.id ? 'kz-chip--on' : 'kz-chip--outline'}`}
              style={{ flexShrink: 0 }}
            >
              {cat.label}
            </button>
          ))}
        </div>
      )}
      <div className="flex-1 overflow-y-auto py-2 scroll">
        {unifiedSessions.length === 0 ? (
          <div className="kz-empty" style={{ padding: '24px 16px' }}>
            <div className="kz-empty__sub">{a.no_sessions}</div>
          </div>
        ) : (
          <>
            {renderGroup(a.today_group, grouped.today)}
            {renderGroup(a.this_week_group, grouped.week)}
            {renderGroup(a.earlier_group, grouped.earlier)}
          </>
        )}
      </div>
    </div>
  );
}
