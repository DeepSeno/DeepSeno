import { Trash2, X, Mic, Video, FileText, File, Image, MessageCircle, Inbox, History, ExternalLink } from 'lucide-react';
import { Translations } from '../../i18n';
import type { HistoryItem, TextNoteItem } from './types';
import { SCENE_BADGE, MEDIA_TYPE_BADGE } from './types';

function badgeToneFromClass(cls: string): string {
  if (/emerald|green/.test(cls)) return 'success';
  if (/red|rose/.test(cls)) return 'danger';
  if (/amber|yellow/.test(cls)) return 'warn';
  if (/blue|sky|cyan/.test(cls)) return 'info';
  if (/violet|purple|fuchsia/.test(cls)) return 'violet';
  return 'mute';
}

function SceneBadge({ scene }: { scene: string }) {
  const info = SCENE_BADGE[scene] || SCENE_BADGE.dictation;
  return <span className={`kz-badge kz-badge--${badgeToneFromClass(info.className)}`}>{info.label}</span>;
}

function MediaTypeBadge({ mediaType, lang }: { mediaType: string; lang: string }) {
  const info = MEDIA_TYPE_BADGE[mediaType] || MEDIA_TYPE_BADGE.audio;
  return (
    <span className={`kz-badge kz-badge--${badgeToneFromClass(info.className)}`}>
      {lang === 'zh' ? info.zhLabel : info.label}
    </span>
  );
}

function MediaTypeIcon({ mediaType }: { mediaType: string }) {
  const iconClass = 'kz-text-faint';
  switch (mediaType) {
    case 'video': return <Video size={13} className={iconClass} />;
    case 'pdf':
    case 'docx': return <FileText size={13} className={iconClass} />;
    case 'text': return <File size={13} className={iconClass} />;
    case 'image': return <Image size={13} className={iconClass} />;
    default: return <Mic size={13} className={iconClass} />;
  }
}

export function canOpenHistoryItem(item: Pick<HistoryItem, 'status'>): boolean {
  return item.status === 'done';
}

export function getHistoryStatusLabel(item: Pick<HistoryItem, 'status'>, r: Translations['rec']): string {
  if (item.status === 'done') return r.status_success;
  if (item.status === 'cancelled') return r.status_cancelled;
  if (item.status === 'interrupted') return (r as any).status_interrupted || 'Interrupted';
  if (item.status === 'error') return r.status_error;
  return r.status_active;
}

function getHistoryStatusBadgeClass(status: string): string {
  if (status === 'done') return 'kz-badge--success';
  if (status === 'cancelled' || status === 'interrupted') return 'kz-badge--warn';
  if (status === 'error') return 'kz-badge--danger';
  return 'kz-badge--info';
}

interface FilterDef {
  key: string;
  label: string;
  count?: number;
}

interface HistorySectionProps {
  filteredHistory: HistoryItem[];
  filteredNotes: TextNoteItem[];
  filter: string;
  filters: FilterDef[];
  deleteConfirmId: number | null;
  selectedNote: TextNoteItem | null;
  lang: string;
  r: Translations['rec'];
  t: Translations;
  onFilterChange: (key: string) => void;
  onRecordingClick: (recordingId: number) => void;
  onReprocess: (recordingId: number, name: string) => void;
  onDeleteRequest: (recordingId: number) => void;
  onDeleteConfirm: (recordingId: number) => void;
  onDeleteCancel: () => void;
  onNoteClick: (note: TextNoteItem) => void;
  onNoteClose: () => void;
}

export default function HistorySection({
  filteredHistory,
  filteredNotes,
  filter,
  filters,
  deleteConfirmId,
  selectedNote,
  lang,
  r,
  t,
  onFilterChange,
  onRecordingClick,
  onReprocess,
  onDeleteRequest,
  onDeleteConfirm,
  onDeleteCancel,
  onNoteClick,
  onNoteClose,
}: HistorySectionProps) {
  const totalCount = filteredHistory.length + filteredNotes.length;

  return (
    <>
      <section style={{ marginBottom: 28 }}>
        <h3 className="kz-section-title">
          <span>{r.history}</span>
          <span className="kz-section-title__count">{totalCount}</span>
          <span style={{ marginLeft: 'auto', display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {filters.map((f) => (
              <button
                key={f.key}
                onClick={() => onFilterChange(f.key)}
                className={`kz-chip ${filter === f.key ? 'kz-chip--on' : 'kz-chip--outline'}`}
              >
                {f.label}
                {typeof f.count === 'number' && (
                  <span className="kz-chip__count">{f.count}</span>
                )}
              </button>
            ))}
          </span>
        </h3>

        <div className="kz-paper" style={{ overflow: 'hidden' }}>
          {totalCount === 0 ? (
            <div className="kz-empty">
              <div className="kz-empty__icon"><Inbox size={20} /></div>
              <div>
                <div className="kz-empty__title">{r.no_history}</div>
              </div>
            </div>
          ) : (
            <>
              {/* Recording rows first */}
              {filteredHistory.map((item, i) => {
                const canOpen = canOpenHistoryItem(item);
                return (
                  <div
                    key={item.recordingId}
                    onClick={() => { if (canOpen) onRecordingClick(item.recordingId); }}
                    className={`${canOpen ? 'kz-row-hover' : ''} kz-anim-in group`}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '100px 1fr auto auto',
                      gap: 16,
                      alignItems: 'center',
                      padding: '14px 20px',
                      borderTop: i ? '1px solid var(--line-soft)' : 0,
                      animationDelay: `${Math.min(i, 8) * 24}ms`,
                    }}
                  >
                  <span className="kz-mono kz-text-mute" style={{ fontSize: 10.5, letterSpacing: 0.08, whiteSpace: 'nowrap' }}>{item.id}</span>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                      <MediaTypeIcon mediaType={item.mediaType} />
                      <span
                        className="kz-mono"
                        style={{ fontSize: 12.5, color: 'var(--ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}
                        title={item.name}
                      >
                        {item.name}
                      </span>
                      {item.mediaType === 'audio' ? (
                        <SceneBadge scene={item.scene} />
                      ) : (
                        <MediaTypeBadge mediaType={item.mediaType} lang={lang} />
                      )}
                      <span className="kz-mono kz-text-faint" style={{ fontSize: 10.5 }}>{item.date}</span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6 }}>
                      {item.duration && (
                        <span className="kz-text-mute" style={{ fontSize: 11 }}>{r.duration} {item.duration}</span>
                      )}
                      {item.pageCount != null && item.pageCount > 0 && (
                        <span className="kz-text-mute" style={{ fontSize: 11 }}>· {r.pages_count(item.pageCount)}</span>
                      )}
                      {item.wordCount != null && item.wordCount > 0 && (
                        <span className="kz-text-mute" style={{ fontSize: 11 }}>· {r.words_count(item.wordCount)}</span>
                      )}
                      {item.speakers > 0 && <span className="kz-text-mute" style={{ fontSize: 11 }}>· {r.speakers_found} {item.speakers}</span>}
                      {item.extracted > 0 && <span className="kz-text-mute" style={{ fontSize: 11 }}>· {r.items_extracted} {item.extracted}</span>}
                      {item.tags.slice(0, 3).map((tag) => (
                        <span
                          key={tag}
                          className="kz-badge kz-badge--accent"
                          style={{ fontFamily: 'var(--mono)', fontSize: 10 }}
                        >
                          {tag}
                        </span>
                      ))}
                    </div>
                  </div>
                  <span
                    className={`kz-badge ${getHistoryStatusBadgeClass(item.status)} kz-badge--dot`}
                  >
                    {getHistoryStatusLabel(item, r)}
                  </span>
                  {/* Action buttons — icon-only ghost (matches design: reprocess + open + delete) */}
                  <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
                    {deleteConfirmId === item.recordingId ? (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                        <button
                          onClick={(e) => { e.stopPropagation(); onDeleteConfirm(item.recordingId); }}
                          className="kz-btn kz-btn--sm"
                          style={{ background: 'var(--c-danger)', color: 'var(--bg)', borderColor: 'var(--c-danger)' }}
                        >
                          {t.common.confirm}
                        </button>
                        <button
                          onClick={(e) => { e.stopPropagation(); onDeleteCancel(); }}
                          className="kz-btn kz-btn--sm"
                        >
                          {t.settings.clear_db_cancel}
                        </button>
                      </div>
                    ) : (
                      <>
                        <button
                          onClick={(e) => { e.stopPropagation(); onReprocess(item.recordingId, item.name); }}
                          className="kz-btn kz-btn--ghost kz-btn--sm"
                          title={r.reprocess}
                          style={{ padding: '0 6px' }}
                        >
                          <History size={13} />
                        </button>
                        {canOpen && (
                          <button
                            onClick={(e) => { e.stopPropagation(); onRecordingClick(item.recordingId); }}
                            className="kz-btn kz-btn--ghost kz-btn--sm"
                            title={r.view}
                            style={{ padding: '0 6px' }}
                          >
                            <ExternalLink size={13} />
                          </button>
                        )}
                        <button
                          onClick={(e) => { e.stopPropagation(); onDeleteRequest(item.recordingId); }}
                          className="kz-btn kz-btn--ghost kz-btn--sm"
                          title={t.common.delete}
                          style={{ padding: '0 6px', color: 'var(--c-danger)' }}
                        >
                          <Trash2 size={13} />
                        </button>
                      </>
                    )}
                  </div>
                  </div>
                );
              })}
              {/* Text Note rows */}
              {filteredNotes.map((note) => (
                <div
                  key={note.noteId}
                  onClick={() => onNoteClick(note)}
                  className="kz-row-hover kz-anim-in"
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '100px 1fr auto',
                    gap: 16,
                    alignItems: 'center',
                    padding: '14px 20px',
                    borderTop: '1px solid var(--line-soft)',
                  }}
                >
                  <span className="kz-mono kz-text-mute" style={{ fontSize: 10.5, letterSpacing: 0.08 }}>{note.id}</span>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                      <MessageCircle size={13} className="kz-text-faint" />
                      <span className="kz-mono" style={{ fontSize: 12.5, color: 'var(--ink)' }}>{note.content}</span>
                      <span className="kz-mono kz-text-faint" style={{ fontSize: 10.5 }}>{note.date}</span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
                      <span className="kz-badge kz-badge--info">
                        {note.channelId === 'feishu' ? r.channel_feishu : note.channelId === 'mobile' ? r.channel_mobile : note.channelId}
                      </span>
                      <span className="kz-mono kz-text-mute" style={{ fontSize: 11 }}>{r.text_note}</span>
                    </div>
                  </div>
                  <span className="kz-badge kz-badge--violet">NOTE</span>
                </div>
              ))}
            </>
          )}
        </div>
      </section>

      {/* Text Note Detail Modal */}
      {selectedNote && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center"
          style={{ background: 'oklch(0 0 0 / 0.36)' }}
          onClick={onNoteClose}
        >
          <div
            className="kz-paper"
            style={{ width: '100%', maxWidth: 520, margin: '0 16px', overflow: 'hidden' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 20px', borderBottom: '1px solid var(--line)' }}>
              <span className="kz-serif" style={{ fontSize: 15 }}>
                {r.text_note} — <span className="kz-mono kz-text-mute" style={{ fontSize: 11 }}>{selectedNote.id}</span>
              </span>
              <button
                onClick={onNoteClose}
                className="kz-btn kz-btn--ghost kz-btn--sm"
                style={{ padding: '0 6px' }}
              >
                <X size={14} />
              </button>
            </div>
            <div style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div>
                <div className="kz-mono kz-text-faint" style={{ fontSize: 10.5, letterSpacing: 0.1, textTransform: 'uppercase', marginBottom: 6 }}>
                  {r.you_sent}
                </div>
                <p className="kz-mono" style={{ fontSize: 13, color: 'var(--ink)', whiteSpace: 'pre-wrap', lineHeight: 1.7, margin: 0 }}>
                  {selectedNote.fullContent}
                </p>
              </div>
              {selectedNote.agentReply && (
                <div>
                  <div className="kz-mono kz-text-faint" style={{ fontSize: 10.5, letterSpacing: 0.1, textTransform: 'uppercase', marginBottom: 6 }}>
                    {r.ai_reply}
                  </div>
                  <p className="kz-mono kz-text-soft" style={{ fontSize: 13, whiteSpace: 'pre-wrap', lineHeight: 1.7, margin: 0 }}>
                    {selectedNote.agentReply}
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
