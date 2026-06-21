import { Copy, Download, FileText, PanelRightClose, MessageCircle, Mic, Users } from 'lucide-react';
import type { Conversation, Message, LiveSegment, ContentCategory } from './types';

interface TranscriptHeaderProps {
  liveSelected: boolean;
  liveStatus: 'idle' | 'recording' | 'post_processing';
  liveSegments: LiveSegment[];
  conversations: Conversation[];
  selectedConv: number;
  messages: Message[];
  onCopyText: () => void;
  onExport: () => void;
  onToggleTranscript?: () => void;
  showTranscript?: boolean;
  /** When provided, renders the inline 原始/优化 toggle in the header row. */
  textMode?: 'raw' | 'clean';
  onTextModeChange?: (m: 'raw' | 'clean') => void;
  tr: Record<string, any>;
  t: Record<string, any>;
  lang: string;
}

const CAT_CONFIG: Record<ContentCategory, { icon: typeof Mic; tone: string }> = {
  note:     { icon: Mic,      tone: 'success' },
  meeting:  { icon: Users,    tone: 'info' },
  document: { icon: FileText, tone: 'violet' },
  media:    { icon: FileText, tone: 'accent' },
};

export default function TranscriptHeader({
  liveSelected, liveStatus, liveSegments,
  conversations, selectedConv, messages,
  onCopyText, onExport, onToggleTranscript, showTranscript,
  textMode, onTextModeChange,
  tr, t,
}: TranscriptHeaderProps) {
  const conv = conversations[selectedConv];
  const cat = conv?.category;
  const catCfg = cat ? CAT_CONFIG[cat] : null;
  const CatIcon = catCfg?.icon;

  return (
    <div
      style={{
        padding: '14px 20px',
        borderBottom: '1px solid var(--line-soft)',
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        background: 'var(--bg-card)',
        flexShrink: 0,
        minHeight: 56,
      }}
    >
      {/* Left: title + meta */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0, flex: 1 }}>
        {liveSelected ? (
          <>
            <div className="kz-live-avatar" style={{ width: 32, height: 32, borderRadius: '50%', display: 'grid', placeItems: 'center', flexShrink: 0 }}>
              <span className="kz-sdot kz-sdot--danger kz-live-dot" />
            </div>
            <div style={{ minWidth: 0 }}>
              <div className="kz-serif" style={{ fontSize: 16, color: 'var(--c-danger)' }}>{tr.live_recording}</div>
              <div className="kz-mono kz-text-mute" style={{ fontSize: 10.5, marginTop: 2 }}>
                {liveSegments.length} {tr.segments_unit}
                {liveStatus === 'post_processing' && ` · ${tr.live_post_processing}`}
              </div>
            </div>
          </>
        ) : conv ? (
          <>
            {catCfg && CatIcon && (
              <div
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: '50%',
                  background: 'var(--c-accent)',
                  color: 'var(--c-accent-ink)',
                  display: 'grid',
                  placeItems: 'center',
                  flexShrink: 0,
                }}
              >
                <CatIcon size={14} />
              </div>
            )}
            <div style={{ minWidth: 0 }}>
              <div className="kz-serif" style={{ fontSize: 17, color: 'var(--ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{conv.title}</div>
              <div className="kz-mono kz-text-mute" style={{ fontSize: 10.5, marginTop: 2 }}>
                {conv.time}
                {conv.duration && <> · {conv.duration}</>}
                {conv.speakers > 0 && <> · {conv.speakers} {tr.speakers_unit}</>}
              </div>
            </div>
          </>
        ) : null}
      </div>

      {/* Right: 优化/原始 toggle + actions — compact, harmonised 24px row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
        {textMode && onTextModeChange && !liveSelected && conv && (
          <div className="kz-tabs" style={{ padding: 2, gap: 2, borderRadius: 7 }}>
            <button
              onClick={() => onTextModeChange('clean')}
              className={textMode === 'clean' ? 'is-on' : ''}
              style={{ padding: '4px 10px', fontSize: 10, borderRadius: 5 }}
            >
              {tr.clean}
            </button>
            <button
              onClick={() => onTextModeChange('raw')}
              className={textMode === 'raw' ? 'is-on' : ''}
              style={{ padding: '4px 10px', fontSize: 10, borderRadius: 5 }}
            >
              {tr.raw}
            </button>
          </div>
        )}
        {onToggleTranscript && !liveSelected && conv && (
          <button
            onClick={onToggleTranscript}
            className="kz-btn kz-btn--sm"
            title={showTranscript ? tr.hide_qa : tr.show_qa}
            aria-label={showTranscript ? tr.hide_qa : tr.show_qa}
            style={{ width: 28, height: 28, padding: 0, borderRadius: 6, gap: 0, display: 'grid', placeItems: 'center' }}
          >
            {showTranscript ? <PanelRightClose size={13} /> : <MessageCircle size={13} />}
          </button>
        )}
        <button
          onClick={onCopyText}
          disabled={messages.length === 0}
          className="kz-btn kz-btn--sm"
          title={tr.copy_text}
          aria-label={tr.copy_text}
          style={{ width: 28, height: 28, padding: 0, borderRadius: 6, gap: 0, display: 'grid', placeItems: 'center' }}
        >
          <Copy size={13} />
        </button>
        <button
          onClick={onExport}
          disabled={!conv}
          className="kz-btn kz-btn--sm"
          title={t.export_btn}
          aria-label={t.export_btn}
          style={{ width: 28, height: 28, padding: 0, borderRadius: 6, gap: 0, display: 'grid', placeItems: 'center' }}
        >
          <Download size={13} />
        </button>
      </div>
    </div>
  );
}
