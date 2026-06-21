import { useState, useEffect } from 'react';
import { Image as ImageIcon, FileText, Lightbulb, X, ChevronLeft, ChevronRight } from 'lucide-react';
import type { ExtractedItem } from '../types';
import { ITEM_TYPE_CONFIG } from '../types';
import type { Message } from '../types';

interface ImageRendererProps {
  messages: Message[];
  extractedItems: ExtractedItem[];
  imageUrl: string | null;
  recordingId?: number;
  tr: Record<string, any>;
  lang: string;
}

function tone(cls: string): string {
  if (/emerald|green/.test(cls)) return 'success';
  if (/red|rose/.test(cls)) return 'danger';
  if (/amber|yellow/.test(cls)) return 'warn';
  if (/blue|sky|cyan/.test(cls)) return 'info';
  if (/violet|purple|fuchsia/.test(cls)) return 'violet';
  return 'mute';
}

export default function ImageRenderer({
  messages,
  extractedItems,
  imageUrl,
  recordingId,
  tr,
}: ImageRendererProps) {
  const [zoomed, setZoomed] = useState(false);
  const [imageCount, setImageCount] = useState(1);
  const [currentIndex, setCurrentIndex] = useState(0);

  useEffect(() => {
    if (!recordingId) return;
    let cancelled = false;
    const detectCount = async () => {
      let count = 0;
      for (let i = 0; i < 50; i++) {
        try {
          const resp = await fetch(`media://image/${recordingId}/${i}`, { method: 'HEAD' });
          if (resp.ok) {
            count = i + 1;
          } else {
            break;
          }
        } catch {
          break;
        }
      }
      if (!cancelled) {
        setImageCount(Math.max(count, 1));
      }
    };
    detectCount();
    return () => { cancelled = true; };
  }, [recordingId]);

  const currentImageUrl = recordingId && imageCount > 1
    ? `media://image/${recordingId}/${currentIndex}`
    : imageUrl;

  const aiDescription = messages[0] || null;
  const ocrText = messages[1] || null;
  const hasContent = messages.length > 0 || extractedItems.length > 0;

  return (
    <div style={{ maxWidth: 760, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 22 }}>
      {/* Image preview */}
      <div className="kz-paper" style={{ overflow: 'hidden' }}>
        {currentImageUrl ? (
          <>
            <div style={{ position: 'relative' }}>
              <img
                src={currentImageUrl}
                alt=""
                style={{ width: '100%', objectFit: 'contain', maxHeight: '60vh', cursor: 'zoom-in', background: 'var(--bg-sunken)' }}
                onClick={() => setZoomed(true)}
              />
              {imageCount > 1 && (
                <>
                  <button
                    style={{
                      position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)',
                      background: 'oklch(0 0 0 / 0.5)', color: 'white', borderRadius: '50%', padding: 6,
                    }}
                    onClick={() => setCurrentIndex(i => Math.max(0, i - 1))}
                    disabled={currentIndex === 0}
                  >
                    <ChevronLeft size={20} />
                  </button>
                  <button
                    style={{
                      position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)',
                      background: 'oklch(0 0 0 / 0.5)', color: 'white', borderRadius: '50%', padding: 6,
                    }}
                    onClick={() => setCurrentIndex(i => Math.min(imageCount - 1, i + 1))}
                    disabled={currentIndex === imageCount - 1}
                  >
                    <ChevronRight size={20} />
                  </button>
                  <div
                    className="kz-mono"
                    style={{ position: 'absolute', bottom: 8, right: 8, background: 'oklch(0 0 0 / 0.6)', color: 'white', fontSize: 11, padding: '2px 8px', borderRadius: 4 }}
                  >
                    {currentIndex + 1} / {imageCount}
                  </div>
                </>
              )}
            </div>
            {imageCount > 1 && (
              <div style={{ display: 'flex', gap: 4, padding: 8, background: 'var(--bg-elev)', overflowX: 'auto' }}>
                {Array.from({ length: imageCount }, (_, i) => (
                  <img
                    key={i}
                    src={`media://image/${recordingId}/${i}`}
                    alt=""
                    onClick={() => setCurrentIndex(i)}
                    style={{
                      height: 56, width: 56, objectFit: 'cover', borderRadius: 4, cursor: 'pointer',
                      boxShadow: i === currentIndex ? '0 0 0 2px var(--c-accent)' : '0 0 0 1px var(--line)',
                      transition: 'box-shadow 0.14s',
                    }}
                  />
                ))}
              </div>
            )}
            {zoomed && (
              <div
                onClick={() => setZoomed(false)}
                style={{
                  position: 'fixed', inset: 0, zIndex: 50,
                  background: 'oklch(0 0 0 / 0.85)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'zoom-out',
                }}
              >
                <button
                  onClick={() => setZoomed(false)}
                  style={{ position: 'absolute', top: 16, right: 16, color: 'rgba(255,255,255,0.8)' }}
                >
                  <X size={24} />
                </button>
                <img
                  src={currentImageUrl}
                  alt=""
                  style={{ maxWidth: '90vw', maxHeight: '90vh', objectFit: 'contain' }}
                />
              </div>
            )}
          </>
        ) : (
          <div className="kz-empty">
            <div className="kz-empty__icon"><ImageIcon size={20} /></div>
            <div><div className="kz-empty__title">{tr.no_image}</div></div>
          </div>
        )}
      </div>

      {/* AI Description */}
      {aiDescription && (
        <div className="kz-paper" style={{ padding: 18 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
            <Lightbulb size={14} className="kz-text-accent" />
            <span className="kz-serif" style={{ fontSize: 14, color: 'var(--ink)' }}>{tr.ai_analysis}</span>
          </div>
          <p style={{ fontSize: 13.5, lineHeight: 1.75, color: 'var(--ink)', whiteSpace: 'pre-wrap', margin: 0 }}>
            {aiDescription.clean || aiDescription.raw}
          </p>
        </div>
      )}

      {/* OCR */}
      {ocrText && (
        <div className="kz-paper" style={{ padding: 18 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
            <FileText size={14} className="kz-text-soft" />
            <span className="kz-serif" style={{ fontSize: 14, color: 'var(--ink)' }}>{tr.ocr_text}</span>
          </div>
          <div className="kz-code" style={{ fontSize: 12 }}>
            {ocrText.clean || ocrText.raw}
          </div>
        </div>
      )}

      {/* Key Information */}
      {extractedItems.length > 0 && (
        <div className="kz-paper" style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <span className="kz-serif" style={{ fontSize: 14, color: 'var(--ink)' }}>{tr.key_info}</span>
          {extractedItems.map((item, i) => {
            const config = ITEM_TYPE_CONFIG[item.type];
            const Icon = config?.icon;
            const t = tone(config?.color || '');
            return (
              <div
                key={i}
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 10,
                  padding: '9px 12px',
                  borderRadius: 8,
                  background: 'var(--bg-card)',
                  border: '1px solid var(--line-soft)',
                  fontSize: 13,
                }}
              >
                {Icon && <Icon size={13} className={`kz-text-${t === 'mute' ? 'soft' : 'accent'}`} style={{ marginTop: 2, flexShrink: 0 }} />}
                <div style={{ flex: 1, minWidth: 0, color: 'var(--ink)' }}>
                  <span>{item.content}</span>
                  {item.deadline && (
                    <span className="kz-mono kz-text-mute" style={{ marginLeft: 8, fontSize: 11 }}>
                      ({tr.due_label}: {item.deadline})
                    </span>
                  )}
                </div>
                <span className={`kz-badge kz-badge--${t}`}>{item.type}</span>
              </div>
            );
          })}
        </div>
      )}

      {!hasContent && (
        <div className="kz-empty">
          <div className="kz-empty__icon"><ImageIcon size={20} /></div>
          <div><div className="kz-empty__title">{tr.no_analysis}</div></div>
        </div>
      )}
    </div>
  );
}
