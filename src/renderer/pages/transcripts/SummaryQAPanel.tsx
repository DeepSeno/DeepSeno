import { useState, useRef, useEffect, KeyboardEvent } from 'react';
import { Send, Sparkles, MessageCircle, Trash2, Copy, Check, Pencil } from 'lucide-react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { MeetingNotes } from '../../hooks/useApi';
import type { ExtractedItem } from './types';
import InlineConfirm from '../../components/InlineConfirm';
import { useScopedChat } from './useScopedChat';

interface SummaryQAPanelProps {
  recordingId: number | undefined;
  meetingNotes: MeetingNotes | null;
  extractedItems: ExtractedItem[];
  mediaType?: string;
  onRegenerateMeetingNotes?: () => void;
  onCopyMeetingNotesMarkdown?: () => void;
  isRegenerating?: boolean;
  tr: Record<string, any>;
  lang: string;
}

function getContentLabels(mediaType: string | undefined, lang: string, tr: Record<string, any>) {
  const isDoc = ['pdf', 'docx', 'text'].includes(mediaType || '');
  const isImage = mediaType === 'image';
  const isVideo = mediaType === 'video';
  const contentWord = isDoc ? tr.content_word_doc : isImage ? tr.content_word_image : isVideo ? tr.content_word_video : tr.content_word_recording;
  const emptyText = tr.ask_about(contentWord);
  const examples = isDoc
    ? [tr.qa_example_doc_1, tr.qa_example_doc_2, tr.qa_example_doc_3, tr.qa_example_doc_4].filter(Boolean)
    : isImage
      ? [tr.qa_example_image_1, tr.qa_example_image_2, tr.qa_example_image_3, tr.qa_example_image_4].filter(Boolean)
      : [tr.qa_example_1, tr.qa_example_2, tr.qa_example_3, tr.qa_example_4].filter(Boolean);
  return { emptyText, examples };
}

function friendlyStatus(status: string | undefined, _lang: string, tr?: Record<string, any>): string {
  if (!status || status === 'generating') return tr?.status_thinking || 'Thinking';
  if (status === 'searching') return tr?.status_searching_docs || 'Searching';
  if (status === 'embedding') return tr?.status_analyzing || 'Analyzing';
  return tr?.status_processing || 'Processing';
}

function ThinkingDots() {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
      {[0, 0.15, 0.3].map((d, i) => (
        <span
          key={i}
          style={{
            width: 4,
            height: 4,
            borderRadius: '50%',
            background: 'var(--ink-mute)',
            animation: 'kz-fade-up 0.8s ease-in-out infinite',
            animationDelay: `${d}s`,
          }}
        />
      ))}
    </span>
  );
}

function ThinkingIndicator({ status, lang, tr }: { status?: string; lang: string; tr?: Record<string, any> }) {
  const label = friendlyStatus(status, lang, tr);
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
      <div style={{ width: 24, height: 24, borderRadius: 8, background: 'var(--bg-elev)', display: 'grid', placeItems: 'center', flexShrink: 0 }}>
        <Sparkles size={12} className="kz-text-accent" />
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0' }}>
        <span className="kz-serif-italic kz-text-mute" style={{ fontSize: 12.5 }}>{label}</span>
        <ThinkingDots />
      </div>
    </div>
  );
}

// Map extracted-item type → semantic tone + display label
function getExtractedTone(type: string): 'warn' | 'info' | 'mute' | 'success' | 'violet' {
  const t = (type || '').toUpperCase();
  if (t === 'TODO' || t === 'TASK' || t === 'ACTION') return 'warn';
  if (t === 'DECISION') return 'info';
  if (t === 'TOPIC') return 'violet';
  if (t === 'FACT') return 'success';
  return 'mute';
}

export default function SummaryQAPanel({
  recordingId, extractedItems, mediaType, tr, lang,
}: SummaryQAPanelProps) {
  const {
    messages, isLoading, status, sendMessage, clearMessages, messagesEndRef,
    deleteMessage, editMessage, pendingEdit, consumePendingEdit,
  } = useScopedChat(recordingId);
  const [input, setInput] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [copiedAll, setCopiedAll] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const { emptyText, examples } = getContentLabels(mediaType, lang, tr);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  useEffect(() => {
    if (pendingEdit !== null) {
      const text = consumePendingEdit();
      if (text !== null) {
        setInput(text);
        inputRef.current?.focus();
      }
    }
  }, [pendingEdit, consumePendingEdit]);

  function handleCopyMessage(content: string, clientId: string) {
    window.api.clipboardWriteText(content).then(() => {
      setCopiedId(clientId);
      setTimeout(() => setCopiedId(null), 2000);
    });
  }

  function handleCopyAll() {
    const userLabel = tr.qa_user || 'User';
    const assistantLabel = 'DeepSeno';
    const text = messages
      .filter((m) => m.content)
      .map((m) => `**${m.role === 'user' ? userLabel : assistantLabel}:**\n\n${m.content}`)
      .join('\n\n---\n\n');
    if (!text) return;
    window.api.clipboardWriteText(text).then(() => {
      setCopiedAll(true);
      setTimeout(() => setCopiedAll(false), 2000);
    });
  }

  function handleSend() {
    if (!input.trim()) return;
    sendMessage(input.trim());
    setInput('');
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
  }

  const hasMessages = messages.length > 0 || isLoading;
  const hasHistory = messages.length > 0;

  return (
    <div className="flex-1 min-w-0 flex flex-col" style={{ background: 'var(--bg-card)', minHeight: 0, overflow: 'hidden' }}>
      {/* Section header with inline clear button (right-aligned when history exists) */}
      <div
        style={{
          padding: '14px 16px',
          borderBottom: '1px solid var(--line-soft)',
          display: 'flex',
          alignItems: 'center',
          flexShrink: 0,
          minHeight: 50,
        }}
      >
        <h3 className="kz-section-title" style={{ margin: 0, flex: 1 }}>
          <span>{tr.qa_panel_title || '针对本次提问'}</span>
        </h3>
        {hasHistory && (
          confirming ? (
            <InlineConfirm
              onConfirm={() => { setConfirming(false); clearMessages(); }}
              onCancel={() => setConfirming(false)}
              confirmLabel={tr.qa_clear_history || 'Clear'}
            />
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <button
                onClick={handleCopyAll}
                disabled={isLoading}
                title={tr.qa_copy_all || 'Copy all'}
                className="kz-btn kz-btn--sm kz-btn--ghost"
                style={{ height: 24, padding: '0 9px', fontSize: 10, borderRadius: 6, gap: 4, opacity: isLoading ? 0.3 : 1 }}
              >
                {copiedAll ? <Check size={11} className="kz-text-accent" /> : <Copy size={11} />}
                {copiedAll ? (tr.qa_copy_all_done || 'Copied') : (tr.qa_copy_all || 'Copy All')}
              </button>
              <button
                onClick={() => setConfirming(true)}
                disabled={isLoading}
                title={tr.qa_clear_history || 'Clear chat history'}
                className="kz-btn kz-btn--sm kz-btn--ghost"
                style={{ height: 24, padding: '0 9px', fontSize: 10, borderRadius: 6, gap: 4, opacity: isLoading ? 0.3 : 1 }}
              >
                <Trash2 size={11} />
                {tr.qa_clear_history || 'Clear'}
              </button>
            </div>
          )
        )}
      </div>

      {/* Chat area — no-scrollbar so chips/input share identical 16px symmetric padding (avoids scrollbar gutter eating right side) */}
      <div className="no-scrollbar" style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', minHeight: 0, minWidth: 0, padding: '16px 16px' }}>
        {!hasMessages ? (
          /* Empty state — structured: italic intro + chips + extracted items */
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <p className="kz-serif-italic kz-text-soft" style={{ fontSize: 13, lineHeight: 1.7, margin: 0 }}>
              “{emptyText}”
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, width: '100%' }}>
              {examples.map((example, i) => (
                <button
                  key={i}
                  onClick={() => sendMessage(example)}
                  style={{
                    width: '100%',
                    textAlign: 'left',
                    padding: '10px 12px',
                    border: 0,
                    borderRadius: 8,
                    background: 'var(--bg-elev)',
                    fontSize: 12.5,
                    color: 'var(--ink)',
                    fontFamily: 'inherit',
                    cursor: 'pointer',
                    whiteSpace: 'normal',
                    wordBreak: 'break-word',
                    overflowWrap: 'break-word',
                    transition: 'background 0.14s, color 0.14s',
                    boxSizing: 'border-box',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = 'color-mix(in oklch, var(--c-accent) 12%, var(--bg-elev))';
                    e.currentTarget.style.color = 'var(--c-accent)';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = 'var(--bg-elev)';
                    e.currentTarget.style.color = 'var(--ink)';
                  }}
                >
                  {example}
                </button>
              ))}
            </div>

            {/* Extracted items — surfaced as reference info even with no chat */}
            {extractedItems && extractedItems.length > 0 && (
              <div style={{ marginTop: 4 }}>
                <h3 className="kz-section-title" style={{ marginBottom: 10 }}>
                  <span>{tr.extracted_info || '抽取项'}</span>
                  <span className="kz-section-title__count">{extractedItems.length}</span>
                </h3>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {extractedItems.map((it, i) => {
                    const tone = getExtractedTone(it.type);
                    return (
                      <div
                        key={i}
                        style={{
                          padding: '9px 12px',
                          border: '1px solid var(--line-soft)',
                          borderRadius: 8,
                          background: 'var(--bg-card)',
                        }}
                      >
                        <div
                          className="kz-mono"
                          style={{
                            fontSize: 10,
                            color: `var(--c-${tone === 'mute' ? 'info' : tone})`,
                            letterSpacing: '0.1em',
                            marginBottom: 3,
                            textTransform: 'uppercase',
                          }}
                        >
                          {it.type}
                        </div>
                        <div style={{ fontSize: 12.5, color: 'var(--ink)', lineHeight: 1.55 }}>
                          {it.content}
                        </div>
                        {it.deadline && (
                          <div className="kz-mono kz-text-mute" style={{ fontSize: 10, marginTop: 4 }}>
                            {it.deadline}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        ) : (
          /* Message stream */
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
            {messages.map((msg) => {
              const canDelete = !!msg.dbId && !msg.streaming;
              const isUser = msg.role === 'user';
              return (
                <div
                  key={msg.clientId}
                  className="group/msg"
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'stretch',
                    gap: 4,
                    minWidth: 0,
                  }}
                >
                  {/* Bubble row — avatar left + content right (assistant), or bubble alone right-aligned (user) */}
                  <div
                    style={{
                      display: 'flex',
                      width: '100%',
                      minWidth: 0,
                      justifyContent: isUser ? 'flex-end' : 'flex-start',
                      alignItems: 'flex-start',
                      gap: isUser ? 0 : 10,
                    }}
                  >
                    {!isUser && (
                      <div style={{ width: 24, height: 24, borderRadius: 8, background: 'var(--bg-elev)', display: 'grid', placeItems: 'center', flexShrink: 0 }}>
                        <Sparkles size={12} className="kz-text-accent" />
                      </div>
                    )}
                    <div
                      style={
                        isUser
                          ? {
                              background: 'var(--c-accent)',
                              color: 'var(--c-accent-ink)',
                              maxWidth: '88%',
                              width: 'fit-content',
                              padding: '9px 13px',
                              borderRadius: 10,
                              fontSize: 13,
                              lineHeight: 1.6,
                              whiteSpace: 'pre-wrap',
                              overflowWrap: 'anywhere',
                              cursor: 'text',
                              userSelect: 'text',
                            }
                          : {
                              flex: '1 1 0',
                              width: 0,
                              minWidth: 0,
                              overflow: 'hidden',
                              contain: 'inline-size',
                              fontSize: 13,
                              lineHeight: 1.7,
                              color: 'var(--ink)',
                              cursor: 'text',
                              userSelect: 'text',
                            }
                      }
                    >
                      {msg.role === 'assistant' ? (
                        <div className="kz-prose kz-prose--chat" style={{ fontSize: 13, maxWidth: 'none' }}>
                          {msg.streaming && !msg.content ? (
                            <span className="kz-text-mute" style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                              {friendlyStatus(status, lang, tr)}
                              <ThinkingDots />
                            </span>
                          ) : (
                            <Markdown remarkPlugins={[remarkGfm]}>{msg.content}</Markdown>
                          )}
                        </div>
                      ) : (
                        msg.content
                      )}
                    </div>
                  </div>

                  {/* Hover actions row — sits below content, aligned to bubble content edge (assistant: indent past avatar) */}
                  {!msg.streaming && (isUser || msg.content) && (
                    <div
                      className="opacity-0 group-hover/msg:opacity-100 transition-opacity"
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 2,
                        justifyContent: isUser ? 'flex-end' : 'flex-start',
                        paddingLeft: isUser ? 0 : 34,
                      }}
                    >
                      <button
                        onClick={() => handleCopyMessage(msg.content, msg.clientId)}
                        className="kz-btn kz-btn--ghost"
                        style={{ padding: 4, height: 22 }}
                        title={tr.qa_copy || 'Copy'}
                      >
                        {copiedId === msg.clientId ? <Check size={11} className="kz-text-accent" /> : <Copy size={11} className="kz-text-mute" />}
                      </button>
                      {isUser && (
                        <button
                          onClick={() => editMessage(msg.clientId)}
                          className="kz-btn kz-btn--ghost"
                          style={{ padding: 4, height: 22 }}
                          title={tr.qa_edit || 'Edit'}
                        >
                          <Pencil size={11} className="kz-text-mute" />
                        </button>
                      )}
                      {canDelete && (
                        <button
                          onClick={() => deleteMessage(msg.clientId)}
                          className="kz-btn kz-btn--ghost"
                          style={{ padding: 4, height: 22, color: 'var(--c-danger)' }}
                          title={tr.qa_delete || 'Delete'}
                        >
                          <Trash2 size={11} />
                        </button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}

            {/* Typing indicator */}
            {isLoading && !messages.some(m => m.streaming) && (
              <ThinkingIndicator status={status || undefined} lang={lang} tr={tr} />
            )}

            <div ref={messagesEndRef} />
          </div>
        )}
      </div>

      {/* Input bar — same width / bg / corner radius as chips above for perfect alignment */}
      <div style={{ padding: '12px 16px', borderTop: '1px solid var(--line-soft)' }}>
        <div
          style={{
            width: '100%',
            boxSizing: 'border-box',
            height: 40,
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '0 6px 0 12px',
            background: 'var(--bg-elev)',
            borderRadius: 8,
          }}
        >
          <input
            ref={inputRef}
            type="text"
            size={1}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={tr.qa_placeholder || 'Ask a question...'}
            disabled={isLoading || !recordingId}
            style={{
              flex: '1 1 0',
              width: 0,
              minWidth: 0,
              height: '100%',
              padding: 0,
              border: 0,
              outline: 0,
              background: 'transparent',
              color: 'var(--ink)',
              fontFamily: 'inherit',
              fontSize: 13,
              lineHeight: 1,
            }}
          />
          <button
            onClick={handleSend}
            disabled={isLoading || !input.trim() || !recordingId}
            className="kz-btn kz-btn--primary"
            style={{ width: 28, height: 28, padding: 0, borderRadius: 6, display: 'grid', placeItems: 'center', flexShrink: 0 }}
            title={tr.qa_send || 'Send'}
            aria-label={tr.qa_send || 'Send'}
          >
            <Send size={12} />
          </button>
        </div>
      </div>
    </div>
  );
}
