import React from 'react';
import { Upload } from 'lucide-react';
import { Translations } from '../../i18n';

interface DropZoneProps {
  dragOver: boolean;
  r: Translations['rec'];
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: () => void;
  onDrop: (e: React.DragEvent) => void;
  onBrowse: () => void;
}

export default function DropZone({
  dragOver,
  r,
  onDragOver,
  onDragLeave,
  onDrop,
  onBrowse,
}: DropZoneProps) {
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={r.drop_title}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onClick={onBrowse}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onBrowse(); } }}
      style={{
        border: '1.5px dashed ' + (dragOver ? 'var(--c-accent)' : 'var(--line-strong)'),
        background: dragOver ? 'var(--c-accent-bg)' : 'var(--bg-card)',
        borderRadius: 12,
        padding: '32px 24px',
        display: 'flex',
        alignItems: 'center',
        gap: 20,
        cursor: 'pointer',
        transition: 'border-color 0.18s, background 0.18s',
        marginBottom: 28,
      }}
    >
      <div
        style={{
          width: 56,
          height: 56,
          borderRadius: '50%',
          background: 'var(--bg-elev)',
          border: '1px solid var(--line)',
          display: 'grid',
          placeItems: 'center',
          color: 'var(--ink-soft)',
          flexShrink: 0,
        }}
      >
        <Upload size={20} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="kz-serif" style={{ fontSize: 18, color: 'var(--ink)' }}>
          {(r as any).drop_headline || r.drop_title}
        </div>
        <div className="kz-mono kz-text-mute" style={{ fontSize: 11, marginTop: 8, letterSpacing: 0.4 }}>
          {r.drop_formats}
        </div>
      </div>
      <button
        type="button"
        className="kz-btn kz-btn--accent"
        onClick={(e) => { e.stopPropagation(); onBrowse(); }}
      >
        <Upload size={13} />
        {(r as any).drop_cta || r.drop_title}
      </button>
    </div>
  );
}
