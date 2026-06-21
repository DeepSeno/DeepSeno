import React, { RefObject, useState, useRef, useEffect } from 'react';
import { Search, Loader2, Mic, Users, FileText, Image, Trash2, Pencil, Tag } from 'lucide-react';
import type { Conversation, SearchResult, ContentCategory } from './types';

interface DateGroup {
  label: string;
  convs: Conversation[];
}

interface ConversationListProps {
  searchInputRef: RefObject<HTMLInputElement | null>;
  searchQuery: string;
  onSearchChange: (query: string) => void;
  isSearching: boolean;
  showSearchResults: boolean;
  searchResults: SearchResult[];
  onSearchResultClick: (result: SearchResult) => void;
  conversations: Conversation[];
  selectedConv: number;
  liveSelected: boolean;
  liveStatus: 'idle' | 'recording' | 'post_processing';
  liveSegments: { index: number; text: string; start: number; end: number }[];
  onSelectConversation: (idx: number) => void;
  onSelectLive: () => void;
  dateGroups: DateGroup[];
  tr: Record<string, any>;
  lang: string;
  className?: string;
  categoryFilter: string;
  onCategoryChange: (cat: string) => void;
  categoryCounts: Record<string, number>;
  onDeleteRecording?: (recordingId: number) => void;
  onRenameRecording?: (recordingId: number, newTitle: string) => void;
  onChangeCategory?: (recordingId: number, category: string | null) => void;
}

const CATEGORY_KEYS = ['all', 'note', 'meeting', 'document', 'media'] as const;
const CATEGORY_LABELS: Record<string, string> = { all: 'cat_all', note: 'cat_note', meeting: 'cat_meeting', document: 'cat_document', media: 'cat_media' };

const ASSIGNABLE_CATEGORY_KEYS = ['note', 'meeting', 'document', 'media'] as const;

/** Format-aware badge */
function CategoryBadge({ category, mediaType, tr }: { category: ContentCategory; lang: string; mediaType?: string; tr: Record<string, any> }) {
  const FORMAT_BADGE: Record<string, { trKey: string; fallback: string; tone: string }> = {
    pdf:   { trKey: '',              fallback: 'PDF',   tone: 'danger' },
    docx:  { trKey: '',              fallback: 'DOCX',  tone: 'info' },
    ppt:   { trKey: '',              fallback: 'PPT',   tone: 'warn' },
    text:  { trKey: '',              fallback: 'TXT',   tone: 'mute' },
    image: { trKey: 'badge_image',   fallback: 'Image', tone: 'accent' },
    video: { trKey: 'badge_video',   fallback: 'Video', tone: 'violet' },
  };

  const fmt = mediaType ? FORMAT_BADGE[mediaType] : null;
  if (fmt) {
    const label = fmt.trKey ? (tr[fmt.trKey] || fmt.fallback) : fmt.fallback;
    return <span className={`kz-badge kz-badge--${fmt.tone}`}>{label}</span>;
  }

  const config: Record<ContentCategory, { trKey: string; fallback: string; tone: string }> = {
    note:     { trKey: 'badge_note',     fallback: 'Note',  tone: 'success' },
    meeting:  { trKey: 'badge_meet',     fallback: 'Meet',  tone: 'info' },
    document: { trKey: 'badge_document', fallback: 'Doc',   tone: 'violet' },
    media:    { trKey: 'badge_media',    fallback: 'Media', tone: 'accent' },
  };
  const c = config[category];
  if (!c) return null;
  return <span className={`kz-badge kz-badge--${c.tone}`}>{tr[c.trKey] || c.fallback}</span>;
}

/** Icon for category tabs */
function CatIcon({ cat }: { cat: string }) {
  const size = 11;
  switch (cat) {
    case 'note': return <Mic size={size} />;
    case 'meeting': return <Users size={size} />;
    case 'document': return <FileText size={size} />;
    case 'media': return <Image size={size} />;
    default: return null;
  }
}

/** Inline title editor */
function InlineEdit({ value, onSave, onCancel }: { value: string; onSave: (v: string) => void; onCancel: () => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState(value);
  useEffect(() => { inputRef.current?.select(); }, []);
  return (
    <input
      ref={inputRef}
      className="kz-input"
      style={{ height: 24, padding: '0 6px', fontSize: 12.5, width: '100%' }}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && text.trim()) { e.preventDefault(); onSave(text.trim()); }
        if (e.key === 'Escape') onCancel();
      }}
      onBlur={() => { if (text.trim() && text.trim() !== value) onSave(text.trim()); else onCancel(); }}
      onClick={(e) => e.stopPropagation()}
      autoFocus
    />
  );
}

const ConversationList = React.memo(function ConversationList({
  searchInputRef, searchQuery, onSearchChange, isSearching,
  showSearchResults, searchResults, onSearchResultClick,
  conversations, selectedConv, liveSelected, liveStatus, liveSegments,
  onSelectConversation, onSelectLive, dateGroups,
  tr, lang, className,
  categoryFilter, onCategoryChange, categoryCounts,
  onDeleteRecording, onRenameRecording, onChangeCategory,
}: ConversationListProps) {
  const [deleteConfirmId, setDeleteConfirmId] = useState<number | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [categoryMenuId, setCategoryMenuId] = useState<number | null>(null);

  return (
    <div
      className={`flex flex-col flex-shrink-0 ${className || ''}`}
      style={{ width: 280, borderRight: '1px solid var(--line)', background: 'var(--bg)', minHeight: 0 }}
    >
      {/* Search + Category tabs */}
      <div style={{ padding: '12px 12px 8px', borderBottom: '1px solid var(--line-soft)', display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div className="kz-search-wrap" style={{ height: 30 }}>
          <Search size={12} className="kz-text-mute" />
          <input
            ref={searchInputRef}
            placeholder={tr.search}
            aria-label={tr.search}
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            style={{ fontSize: 12 }}
          />
          {isSearching && <Loader2 size={12} className="animate-spin kz-text-mute" />}
        </div>

        {/* Category filter */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {CATEGORY_KEYS.map((key) => {
            const active = categoryFilter === key;
            const count = categoryCounts[key] || 0;
            const disabled = count === 0 && key !== 'all';
            return (
              <button
                key={key}
                onClick={() => onCategoryChange(key)}
                disabled={disabled}
                className={`kz-chip ${active ? 'kz-chip--on' : 'kz-chip--outline'}`}
                style={{
                  padding: '3px 8px',
                  fontSize: 11,
                  opacity: disabled ? 0.4 : 1,
                  cursor: disabled ? 'default' : 'pointer',
                }}
              >
                {key !== 'all' && <CatIcon cat={key} />}
                {tr[CATEGORY_LABELS[key]] || key}
                {count > 0 && <span className="kz-chip__count">{count}</span>}
              </button>
            );
          })}
        </div>
      </div>

      {/* Content list */}
      <div className="scroll" style={{ flex: 1, overflowY: 'auto' }}>
        {showSearchResults ? (
          <>
            <div style={{ padding: '8px 14px', background: 'var(--bg-elev)', borderBottom: '1px solid var(--line-soft)' }}>
              <span className="kz-mono kz-text-mute" style={{ fontSize: 10.5, letterSpacing: '0.16em', textTransform: 'uppercase' }}>
                {searchResults.length} {tr.results}
              </span>
            </div>
            {searchResults.length === 0 && !isSearching && (
              <div className="kz-text-mute" style={{ padding: '32px 16px', textAlign: 'center', fontSize: 12 }}>{tr.no_results}</div>
            )}
            {searchResults.map((result) => (
              <button
                key={result.id}
                onClick={() => onSearchResultClick(result)}
                className="kz-row-hover"
                style={{
                  width: '100%',
                  textAlign: 'left',
                  padding: '10px 14px',
                  borderBottom: '1px solid var(--line-soft)',
                  cursor: 'pointer',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 4 }}>
                  <span className="kz-mono kz-text-soft" style={{ fontSize: 11, fontWeight: 600 }}>{result.speakerName}</span>
                  <span className="kz-mono kz-text-mute" style={{ fontSize: 10.5 }}>{result.time}</span>
                </div>
                <div className="kz-text-soft" style={{ fontSize: 12, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{result.text}</div>
                <div className="kz-text-faint" style={{ fontSize: 10.5, marginTop: 4 }}>{result.recordingName}</div>
              </button>
            ))}
          </>
        ) : (
          <>
            {/* Live recording entry */}
            {liveStatus !== 'idle' && (
              <button
                onClick={onSelectLive}
                className={liveSelected ? 'kz-row-selected kz-row-selected--live' : 'kz-row-hover'}
                style={{
                  width: '100%',
                  textAlign: 'left',
                  padding: '10px 14px',
                  borderBottom: '1px solid var(--line-soft)',
                  cursor: 'pointer',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span className="kz-sdot kz-sdot--danger kz-live-dot" />
                  <span className="kz-mono" style={{ fontSize: 13, color: 'var(--c-danger)', fontWeight: liveSelected ? 600 : 400 }}>
                    {tr.live_recording}
                  </span>
                </div>
                <div style={{ display: 'flex', gap: 10, marginTop: 4 }} className="kz-mono kz-text-mute">
                  <span style={{ fontSize: 10.5 }}>{liveSegments.length} {tr.segments_unit}</span>
                  {liveStatus === 'post_processing' && <span style={{ fontSize: 10.5 }}>{tr.live_post_processing}</span>}
                </div>
              </button>
            )}

            {dateGroups.length === 0 && liveStatus === 'idle' && (
              <div className="kz-text-mute" style={{ padding: '32px 16px', textAlign: 'center', fontSize: 12 }}>
                {tr.no_conversations}
              </div>
            )}

            {dateGroups.map((group, gi) => (
              <div key={gi}>
                <div className="kz-serif-italic kz-text-mute" style={{ padding: '10px 14px 4px', fontSize: 11.5, position: 'sticky', top: 0, background: 'var(--bg)', zIndex: 1 }}>
                  {group.label}
                </div>
                {group.convs.map((conv) => {
                  const globalIdx = conversations.indexOf(conv);
                  const isSelected = selectedConv === globalIdx && !liveSelected;
                  const isConfirming = deleteConfirmId === conv.recordingId;
                  const isEditing = editingId === conv.recordingId;
                  const isCategoryMenu = categoryMenuId === conv.recordingId;
                  return (
                    <div
                      key={conv.id}
                      onClick={() => { if (!isEditing) onSelectConversation(globalIdx); }}
                      className={`group ${isSelected ? 'kz-row-selected' : 'kz-row-hover'}`}
                      style={{
                        padding: '9px 14px',
                        borderBottom: '1px solid var(--line-soft)',
                        cursor: 'pointer',
                      }}
                    >
                      {/* Line 1: title + date */}
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                        {isEditing ? (
                          <InlineEdit
                            value={conv.title}
                            onSave={(v) => { onRenameRecording?.(conv.recordingId, v); setEditingId(null); }}
                            onCancel={() => setEditingId(null)}
                          />
                        ) : (
                          <span
                            style={{
                              fontSize: 13,
                              color: isSelected ? 'var(--ink)' : 'var(--ink-soft)',
                              fontWeight: isSelected ? 500 : 400,
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                              minWidth: 0,
                            }}
                            onDoubleClick={(e) => { if (onRenameRecording) { e.stopPropagation(); setEditingId(conv.recordingId); } }}
                            title={conv.title}
                          >
                            {conv.title}
                          </span>
                        )}
                        {!isEditing && (
                          <span className="kz-mono kz-text-mute" style={{ fontSize: 10.5, flexShrink: 0 }}>
                            {conv.time || conv.actualDate}
                          </span>
                        )}
                      </div>
                      {/* Line 2: meta + badge + actions */}
                      {isConfirming ? (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6 }} onClick={(e) => e.stopPropagation()}>
                          <span className="kz-mono" style={{ fontSize: 10, color: 'var(--c-danger)' }}>{tr.confirm_delete}</span>
                          <button
                            onClick={() => { onDeleteRecording!(conv.recordingId); setDeleteConfirmId(null); }}
                            className="kz-btn kz-btn--sm"
                            style={{ background: 'var(--c-danger)', color: 'var(--bg)', borderColor: 'var(--c-danger)', height: 22, padding: '0 7px', fontSize: 10 }}
                          >
                            {tr.confirm_yes}
                          </button>
                          <button
                            onClick={() => setDeleteConfirmId(null)}
                            className="kz-btn kz-btn--sm"
                            style={{ height: 22, padding: '0 7px', fontSize: 10 }}
                          >
                            {tr.confirm_no}
                          </button>
                        </div>
                      ) : (
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 4, position: 'relative' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }} className="kz-mono kz-text-mute">
                            {conv.duration && <span style={{ fontSize: 10.5 }}>{conv.duration}</span>}
                            {conv.category === 'meeting' && conv.speakers > 0 && <span style={{ fontSize: 10.5 }}>{conv.speakers} {tr.speakers_unit}</span>}
                            {conv.category === 'document' && conv.pageCount != null && conv.pageCount > 0 && (
                              <span style={{ fontSize: 10.5 }}>{conv.pageCount}{tr.pages_unit}</span>
                            )}
                            {conv.category === 'document' && conv.wordCount != null && conv.wordCount > 0 && (
                              <span style={{ fontSize: 10.5 }}>{conv.wordCount}{tr.words_unit}</span>
                            )}
                            <CategoryBadge category={conv.category} lang={lang} mediaType={conv.mediaType} tr={tr} />
                          </div>
                          {/* Action buttons — hover */}
                          <div className="hidden group-hover:flex" style={{ alignItems: 'center', gap: 2, flexShrink: 0 }} onClick={(e) => e.stopPropagation()}>
                            {onRenameRecording && (
                              <button
                                onClick={() => setEditingId(conv.recordingId)}
                                className="kz-btn kz-btn--ghost"
                                style={{ height: 20, padding: '0 4px' }}
                                title={tr.rename_action}
                              >
                                <Pencil size={10} className="kz-text-mute" />
                              </button>
                            )}
                            {onChangeCategory && (
                              <button
                                onClick={() => setCategoryMenuId(isCategoryMenu ? null : conv.recordingId)}
                                className="kz-btn kz-btn--ghost"
                                style={{ height: 20, padding: '0 4px' }}
                                title={tr.categorize_action}
                              >
                                <Tag size={10} className="kz-text-mute" />
                              </button>
                            )}
                            {onDeleteRecording && (
                              <button
                                onClick={() => setDeleteConfirmId(conv.recordingId)}
                                className="kz-btn kz-btn--ghost"
                                style={{ height: 20, padding: '0 4px' }}
                                title={tr.delete_action}
                              >
                                <Trash2 size={10} className="kz-text-mute" />
                              </button>
                            )}
                          </div>
                          {/* Category dropdown */}
                          {isCategoryMenu && (
                            <div
                              className="kz-paper"
                              style={{ position: 'absolute', right: 0, top: 22, zIndex: 10, padding: '4px 0', minWidth: 108 }}
                              onClick={(e) => e.stopPropagation()}
                            >
                              {ASSIGNABLE_CATEGORY_KEYS.map((key) => (
                                <button
                                  key={key}
                                  onClick={() => { onChangeCategory!(conv.recordingId, key); setCategoryMenuId(null); }}
                                  className="kz-row-hover"
                                  style={{
                                    width: '100%',
                                    textAlign: 'left',
                                    padding: '6px 12px',
                                    fontSize: 11.5,
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: 6,
                                    color: conv.category === key ? 'var(--ink)' : 'var(--ink-soft)',
                                    fontWeight: conv.category === key ? 600 : 400,
                                  }}
                                >
                                  <CatIcon cat={key} />
                                  {tr[CATEGORY_LABELS[key]] || key}
                                </button>
                              ))}
                              <div style={{ borderTop: '1px solid var(--line-soft)', marginTop: 4, paddingTop: 4 }}>
                                <button
                                  onClick={() => { onChangeCategory!(conv.recordingId, null); setCategoryMenuId(null); }}
                                  className="kz-row-hover kz-text-mute"
                                  style={{ width: '100%', textAlign: 'left', padding: '6px 12px', fontSize: 11.5 }}
                                >
                                  {tr.category_auto}
                                </button>
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
});

export default ConversationList;
