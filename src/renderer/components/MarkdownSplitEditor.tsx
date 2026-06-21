import { useState, useRef, useCallback, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface MarkdownSplitEditorProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  readOnly?: boolean;
  className?: string;
  minHeight?: string;
  /** 'split' = side-by-side (default), 'preview' = read-first, click to edit */
  mode?: 'split' | 'preview';
  /** Extra class name applied to the prose container (e.g. 'soul-prose' for agent styling) */
  proseClassName?: string;
}

// Lenient pre-processing for user-friendly markdown:
// 1. `##3.` → `## 3.`  (heading hash without space after)
// 2. `>quote` → `> quote`
// 3. `-item` / `*item` at line start (followed by non-list char) → add space
function normalizeMarkdown(src: string): string {
  return src
    .replace(/^(#{1,6})(?=\S)/gm, '$1 ')
    .replace(/^>(?=\S)/gm, '> ');
}

// Single source of truth — editorial markdown styles defined in src/index.css .kz-prose
const PROSE_CLASSES = 'kz-prose';

export default function MarkdownSplitEditor({
  value, onChange, placeholder, readOnly, className, minHeight = '400px', mode = 'split',
  proseClassName,
}: MarkdownSplitEditorProps) {
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [editing, setEditing] = useState(false);

  // Tab key inserts 2 spaces
  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const ta = e.currentTarget;
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      const newVal = value.substring(0, start) + '  ' + value.substring(end);
      onChange(newVal);
      requestAnimationFrame(() => {
        ta.selectionStart = ta.selectionEnd = start + 2;
      });
    }
    if (e.key === 'Escape') {
      setEditing(false);
    }
  }, [value, onChange]);

  // Sync scroll proportionally (split mode only)
  const handleEditorScroll = useCallback(() => {
    if (!editorRef.current || !previewRef.current) return;
    const ed = editorRef.current;
    const pv = previewRef.current;
    const ratio = ed.scrollTop / (ed.scrollHeight - ed.clientHeight || 1);
    pv.scrollTop = ratio * (pv.scrollHeight - pv.clientHeight);
  }, []);

  // Focus textarea when entering edit mode
  useEffect(() => {
    if (editing && editorRef.current) {
      editorRef.current.focus();
    }
  }, [editing]);

  // Click outside to exit edit mode (preview mode)
  useEffect(() => {
    if (mode !== 'preview' || !editing) return;
    const handleClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setEditing(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [mode, editing]);

  const proseExtra = proseClassName || '';

  // ── Preview (read-first) mode ──
  if (mode === 'preview') {
    return (
      <div ref={containerRef} className={`flex flex-col overflow-hidden ${className || ''}`}
        style={{ minHeight: className?.includes('flex-1') ? undefined : minHeight }}>
        {editing && !readOnly ? (
          <div className="flex-1 flex flex-col editor-crossfade-enter">
            <textarea
              ref={editorRef}
              value={value}
              onChange={(e) => onChange(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={placeholder}
              className="flex-1 p-6 resize-none outline-none kz-mono"
              style={{
                fontSize: 13,
                lineHeight: 1.8,
                color: 'var(--ink)',
                background: 'var(--bg-elev)',
                borderLeft: '2px solid var(--line)',
              }}
              spellCheck={false}
            />
          </div>
        ) : (
          <div
            onClick={() => { if (!readOnly) setEditing(true); }}
            className={`group relative flex-1 p-6 overflow-y-auto editor-crossfade-enter ${PROSE_CLASSES} ${proseExtra} ${
              readOnly ? '' : 'cursor-text transition-colors'
            }`}
            style={{ maxWidth: 'none' }}
          >
            {value ? (
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{normalizeMarkdown(value)}</ReactMarkdown>
            ) : (
              <p className="kz-serif-italic kz-text-faint" style={{ fontSize: 13.5 }}>{placeholder || 'Nothing to preview'}</p>
            )}
            {!readOnly && (
              <span
                className="kz-mono opacity-0 group-hover:opacity-100 transition-opacity duration-150 pointer-events-none select-none"
                style={{ position: 'absolute', bottom: 12, right: 16, fontSize: 9.5, letterSpacing: '0.16em', textTransform: 'uppercase', color: 'var(--ink-faint)' }}
              >
                click to edit
              </span>
            )}
          </div>
        )}
      </div>
    );
  }

  // ── Split mode (editor | preview side-by-side) ──
  return (
    <div className={`flex rounded-xl overflow-hidden ${className || ''}`}
      style={{ minHeight: className?.includes('h-full') ? undefined : minHeight, border: '1px solid var(--line)' }}>
      {/* Editor side */}
      <div className="flex-1 flex flex-col" style={{ borderRight: '1px solid var(--line-soft)' }}>
        <div
          className="px-3 py-1.5 kz-serif-italic kz-text-mute"
          style={{ fontSize: 11.5, borderBottom: '1px solid var(--line-soft)', background: 'var(--bg-elev)' }}
        >
          编辑 · Markdown
        </div>
        <textarea
          ref={editorRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          onScroll={handleEditorScroll}
          readOnly={readOnly}
          placeholder={placeholder}
          className="flex-1 p-4 resize-none outline-none kz-mono"
          style={{ fontSize: 13, lineHeight: 1.8, color: 'var(--ink)', background: 'var(--bg-card)' }}
          spellCheck={false}
        />
      </div>
      {/* Preview side */}
      <div className="flex-1 flex flex-col">
        <div
          className="px-3 py-1.5 kz-serif-italic kz-text-mute"
          style={{ fontSize: 11.5, borderBottom: '1px solid var(--line-soft)', background: 'var(--bg-elev)' }}
        >
          预览
        </div>
        <div ref={previewRef}
          className={`flex-1 p-4 overflow-y-auto ${PROSE_CLASSES} ${proseExtra}`}
          style={{ maxWidth: 'none', background: 'var(--bg)' }}>
          {value ? (
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{normalizeMarkdown(value)}</ReactMarkdown>
          ) : (
            <p className="kz-serif-italic kz-text-faint" style={{ fontSize: 13.5 }}>{placeholder || 'Nothing to preview'}</p>
          )}
        </div>
      </div>
    </div>
  );
}
