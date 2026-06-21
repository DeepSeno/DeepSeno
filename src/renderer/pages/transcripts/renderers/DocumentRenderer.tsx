import { useState, useRef, useCallback } from 'react';
import { Star, ZoomIn, ZoomOut, FileText } from 'lucide-react';
import type { Message } from '../types';

interface DocumentRendererProps {
  messages: Message[];
  textMode: 'raw' | 'clean';
  highlightedSegment: number | null;
  onToggleBookmark: (segmentId: number) => void;
  extractedElement: React.ReactNode | null;
  tr: Record<string, any>;
  mediaType?: string;
  recordingId?: number;
  pageCount?: number;
  lang?: string;
}

export default function DocumentRenderer({
  messages,
  textMode,
  highlightedSegment,
  onToggleBookmark,
  extractedElement,
  tr,
  mediaType,
  recordingId,
  pageCount,
}: DocumentRendererProps) {
  const [zoom, setZoom] = useState(100);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  const handleZoomIn = useCallback(() => setZoom(z => Math.min(200, z + 25)), []);
  const handleZoomOut = useCallback(() => setZoom(z => Math.max(50, z - 25)), []);
  const handleZoomReset = useCallback(() => setZoom(100), []);

  // PDF
  if (mediaType === 'pdf' && recordingId) {
    const pdfUrl = `media://document/${recordingId}#toolbar=0&navpanes=0&view=FitH`;

    return (
      <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: 'var(--bg-sunken)' }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '8px 14px',
            background: 'var(--bg-card)',
            borderBottom: '1px solid var(--line-soft)',
            flexShrink: 0,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <FileText size={13} className="kz-text-mute" />
            <span className="kz-mono kz-text-soft" style={{ fontSize: 11 }}>{tr.pdf_label}</span>
            {pageCount && pageCount > 0 && (
              <span className="kz-mono kz-text-mute" style={{ fontSize: 11 }}>
                · {pageCount} {tr.pages_unit}
              </span>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
            <button onClick={handleZoomOut} className="kz-btn kz-btn--ghost kz-btn--sm" title={tr.zoom_out} style={{ padding: '0 5px' }}>
              <ZoomOut size={13} />
            </button>
            <button onClick={handleZoomReset} className="kz-btn kz-btn--ghost kz-btn--sm" style={{ minWidth: 44, padding: '0 6px', fontFamily: 'var(--mono)' }}>
              {zoom}%
            </button>
            <button onClick={handleZoomIn} className="kz-btn kz-btn--ghost kz-btn--sm" title={tr.zoom_in} style={{ padding: '0 5px' }}>
              <ZoomIn size={13} />
            </button>
          </div>
        </div>
        <iframe ref={iframeRef} src={pdfUrl} style={{ flex: 1, border: 0, width: '100%' }} />
      </div>
    );
  }

  // DOCX / TXT
  return (
    <div className="kz-prose" style={{ maxWidth: 760, margin: '0 auto' }}>
      {messages.map((msg, index) => {
        const text = textMode === 'clean' ? msg.clean : msg.raw;
        const isHighlighted = highlightedSegment === msg.segmentId;

        return (
          <div
            key={msg.segmentId}
            id={`segment-${msg.segmentId}`}
            className="group"
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 16,
              padding: '10px 6px',
              borderBottom: '1px solid var(--line-soft)',
              background: isHighlighted ? 'var(--c-accent-bg)' : 'transparent',
              boxShadow: isHighlighted ? 'inset 3px 0 0 var(--c-accent)' : 'none',
              transition: 'background 0.15s',
            }}
          >
            <span
              className="kz-mono kz-text-faint"
              style={{ fontSize: 10.5, userSelect: 'none', flexShrink: 0, paddingTop: 2, width: 30, textAlign: 'right' }}
            >
              {index + 1}
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <p style={{ fontSize: 14, color: 'var(--ink)', lineHeight: 1.75, margin: 0, whiteSpace: 'pre-wrap' }}>
                {text}
              </p>
            </div>
            <button
              onClick={() => onToggleBookmark(msg.segmentId)}
              className={`transition-opacity ${msg.bookmarked ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}
              style={{ background: 'transparent', border: 0, cursor: 'pointer', flexShrink: 0, paddingTop: 2 }}
              title={msg.bookmarked ? tr.bookmarked : tr.bookmark}
            >
              <Star
                size={12}
                fill={msg.bookmarked ? 'var(--c-warn)' : 'none'}
                style={{ color: msg.bookmarked ? 'var(--c-warn)' : 'var(--ink-faint)' }}
              />
            </button>
          </div>
        );
      })}
      {extractedElement}
    </div>
  );
}
