import { useRef, useEffect, useState, useCallback } from 'react';
import { Star, Pencil, Check, X } from 'lucide-react';
import { ProGate } from '../../../components/ProGate';
import type { Message } from '../types';

interface ConversationRendererProps {
  messages: Message[];
  textMode: 'raw' | 'clean';
  highlightedSegment: number | null;
  currentTime: number;
  isPlaying: boolean;
  onBubbleClick: (startTime: number) => void;
  onToggleBookmark: (segmentId: number) => void;
  onEditSegment?: (segmentId: number, newText: string) => void;
  extractedElement: React.ReactNode | null;
  tr: Record<string, any>;
  t: Record<string, any>;
}

function sentimentTone(sentiment: string): string {
  if (sentiment === 'positive') return 'success';
  if (sentiment === 'negative') return 'danger';
  if (sentiment === 'angry') return 'danger';
  if (sentiment === 'happy' || sentiment === 'joy') return 'success';
  if (sentiment === 'sad') return 'info';
  if (sentiment === 'surprised') return 'accent';
  return 'mute';
}

export default function ConversationRenderer({
  messages,
  textMode,
  highlightedSegment,
  currentTime,
  isPlaying,
  onBubbleClick,
  onToggleBookmark,
  onEditSegment,
  extractedElement,
  tr,
  t,
}: ConversationRendererProps) {
  const activeRef = useRef<HTMLDivElement>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editText, setEditText] = useState('');
  const [savingId, setSavingId] = useState<number | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (isPlaying && activeRef.current) {
      activeRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [currentTime, isPlaying]);

  useEffect(() => {
    if (editingId !== null && textareaRef.current) {
      textareaRef.current.focus();
      const len = textareaRef.current.value.length;
      textareaRef.current.setSelectionRange(len, len);
    }
  }, [editingId]);

  const startEditing = useCallback((msg: Message, e: React.MouseEvent) => {
    e.stopPropagation();
    const text = textMode === 'clean' ? msg.clean : msg.raw;
    setEditText(text);
    setEditingId(msg.segmentId);
  }, [textMode]);

  const cancelEditing = useCallback(() => {
    setEditingId(null);
    setEditText('');
  }, []);

  const saveEdit = useCallback((segmentId: number) => {
    if (!onEditSegment) return;
    const trimmed = editText.trim();
    onEditSegment(segmentId, trimmed);
    setSavingId(segmentId);
    setEditingId(null);
    setEditText('');
    setTimeout(() => setSavingId(null), 800);
  }, [editText, onEditSegment]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent, segmentId: number) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      cancelEditing();
    } else if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      saveEdit(segmentId);
    }
  }, [cancelEditing, saveEdit]);

  return (
    <div className="kz-prose" style={{ maxWidth: 760 }}>
      {messages.map((msg, idx) => {
        const nextStart = idx < messages.length - 1 ? messages[idx + 1].startTime : (msg.endTime || msg.startTime + 30);
        const effectiveEnd = msg.endTime > msg.startTime ? msg.endTime : nextStart;
        const isActive = currentTime >= msg.startTime && currentTime < effectiveEnd;
        const isPast = currentTime >= effectiveEnd;
        const segDuration = effectiveEnd - msg.startTime;
        const segProgress = isActive && segDuration > 0
          ? Math.min(1, (currentTime - msg.startTime) / segDuration)
          : 0;

        const text = textMode === 'clean' ? msg.clean : msg.raw;
        const isEditing = editingId === msg.segmentId;
        const isSaving = savingId === msg.segmentId;
        const isHighlighted = highlightedSegment === msg.segmentId;

        return (
          <div
            key={msg.segmentId}
            ref={isActive ? activeRef : undefined}
            id={`segment-${msg.segmentId}`}
            className="group kz-anim-in"
            style={{
              cursor: 'pointer',
              padding: '10px 12px',
              borderRadius: 8,
              marginBottom: 4,
              background: isActive
                ? 'var(--bg-elev)'
                : isHighlighted
                  ? 'var(--c-accent-bg)'
                  : 'transparent',
              boxShadow: isHighlighted ? 'inset 3px 0 0 var(--c-accent)' : 'none',
              transition: 'background 0.15s',
              animationDelay: `${Math.min(idx, 8) * 30}ms`,
            }}
            onMouseEnter={(e) => { if (!isActive && !isHighlighted) (e.currentTarget as HTMLElement).style.background = 'var(--bg-elev)'; }}
            onMouseLeave={(e) => { if (!isActive && !isHighlighted) (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
            onClick={() => !isEditing && onBubbleClick(msg.startTime)}
          >
            {/* Meta line */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <span
                className="kz-mono"
                style={{ fontSize: 10.5, color: isActive ? 'var(--ink-soft)' : 'var(--ink-mute)', fontWeight: 500 }}
              >
                {msg.speaker}
              </span>
              <span
                className="kz-mono"
                style={{ fontSize: 10.5, color: isActive ? 'var(--ink-mute)' : 'var(--ink-faint)' }}
                title={msg.wallClockTime || undefined}
              >
                {msg.time}
              </span>
              {msg.sentiment && (
                <ProGate feature="emotion_analysis" fallback={null}>
                  <span className={`kz-badge kz-badge--${sentimentTone(msg.sentiment)}`}>
                    {(t.sentiment as Record<string, string>)[msg.sentiment] || msg.sentiment}
                  </span>
                </ProGate>
              )}
              {isSaving && (
                <span className="kz-mono kz-text-mute" style={{ fontSize: 10, marginLeft: 'auto', marginRight: 4, animation: 'kz-fade-up 0.6s ease-in-out infinite alternate' }}>
                  {tr.saving}
                </span>
              )}
              {onEditSegment && !isEditing && !isSaving && (
                <button
                  onClick={(e) => startEditing(msg, e)}
                  className="opacity-0 group-hover:opacity-100 transition-opacity"
                  style={{ marginLeft: isSaving ? 0 : 'auto', background: 'transparent', border: 0, cursor: 'pointer' }}
                  title={tr.edit || 'Edit'}
                >
                  <Pencil size={11} className="kz-text-faint" />
                </button>
              )}
              <button
                onClick={(e) => { e.stopPropagation(); onToggleBookmark(msg.segmentId); }}
                className={`transition-opacity ${msg.bookmarked ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}
                style={{
                  marginLeft: !onEditSegment && !isSaving ? 'auto' : 0,
                  background: 'transparent',
                  border: 0,
                  cursor: 'pointer',
                }}
                title={msg.bookmarked ? tr.bookmarked : tr.bookmark}
              >
                <Star
                  size={11}
                  fill={msg.bookmarked ? 'var(--c-warn)' : 'none'}
                  style={{ color: msg.bookmarked ? 'var(--c-warn)' : 'var(--ink-faint)' }}
                />
              </button>
            </div>

            {/* Text content */}
            {isEditing ? (
              <div onClick={(e) => e.stopPropagation()}>
                <textarea
                  ref={textareaRef}
                  value={editText}
                  onChange={(e) => setEditText(e.target.value)}
                  onKeyDown={(e) => handleKeyDown(e, msg.segmentId)}
                  onBlur={() => {
                    setTimeout(() => {
                      if (editingId === msg.segmentId) saveEdit(msg.segmentId);
                    }, 150);
                  }}
                  className="kz-input"
                  style={{
                    width: '100%',
                    minHeight: 60,
                    height: 'auto',
                    padding: '8px 10px',
                    resize: 'vertical',
                    fontSize: 13,
                    lineHeight: 1.7,
                    fontFamily: 'var(--sans)',
                  }}
                  rows={Math.max(2, text.split('\n').length)}
                />
                <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 6 }}>
                  <button
                    onMouseDown={(e) => { e.preventDefault(); saveEdit(msg.segmentId); }}
                    className="kz-btn kz-btn--sm"
                  >
                    <Check size={10} /> {tr.save_btn}
                  </button>
                  <button
                    onMouseDown={(e) => { e.preventDefault(); cancelEditing(); }}
                    className="kz-btn kz-btn--ghost kz-btn--sm"
                  >
                    <X size={10} /> {tr.esc_btn}
                  </button>
                  <span className="kz-mono kz-text-faint" style={{ marginLeft: 'auto', fontSize: 10 }}>
                    {tr.edit_hint}
                  </span>
                </div>
              </div>
            ) : (
              <p
                style={{
                  fontSize: 14,
                  lineHeight: 1.75,
                  margin: 0,
                  color: isActive ? 'var(--ink)' : isPast ? 'var(--ink-soft)' : 'var(--ink)',
                  transition: 'color 0.15s',
                  fontFamily: 'var(--sans)',
                }}
              >
                {text}
              </p>
            )}

            {/* Inline progress bar */}
            {isActive && isPlaying && (
              <div style={{ marginTop: 6, height: 2, background: 'var(--line-soft)', borderRadius: 999, overflow: 'hidden' }}>
                <div
                  style={{
                    height: '100%',
                    background: 'var(--c-accent)',
                    width: `${segProgress * 100}%`,
                    borderRadius: 999,
                    transition: 'width 0.2s linear',
                  }}
                />
              </div>
            )}
          </div>
        );
      })}

      {extractedElement}
    </div>
  );
}
