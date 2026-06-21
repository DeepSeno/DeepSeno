import { forwardRef } from 'react';
import { Code2, ExternalLink, Copy, Check, ChevronDown, ChevronUp, Pencil, Trash2 } from 'lucide-react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Translations } from '../../i18n';
import { ChatMessage, Source, SOURCES_PREVIEW_COUNT } from './types';

interface ChatMessagesProps {
  messages: ChatMessage[];
  isLoading: boolean;
  hasConversation: boolean;
  streamStatus: string;
  elapsed: number;
  copiedIdx: string | null;
  expandedSources: Set<string>;
  a: Translations['asst'];
  onCopy: (text: string, msgId: string) => void;
  onToggleSourceExpand: (msgId: string) => void;
  onSourceClick: (src: Source) => void;
  onStarterClick: (query: string) => void;
  onDeleteMessage?: (msgId: string) => void;
  onEditMessage?: (msgId: string) => void;
}

const ChatMessages = forwardRef<HTMLDivElement, ChatMessagesProps>(function ChatMessages(
  {
    messages,
    isLoading,
    hasConversation,
    streamStatus,
    elapsed,
    copiedIdx,
    expandedSources,
    a,
    onCopy,
    onToggleSourceExpand,
    onSourceClick,
    onStarterClick,
    onDeleteMessage,
    onEditMessage,
  },
  ref
) {
  return (
    <div className="flex-1 overflow-y-auto scroll p-6" role="log" aria-live="polite">
      <div className="max-w-3xl mx-auto space-y-5">
        {messages.map((msg) => {
          if (msg.role === 'system') {
            return (
              <div key={msg.id} className="flex items-start gap-3">
                <div
                  className="w-5 h-5 flex items-center justify-center flex-shrink-0 mt-0.5"
                  style={{ background: 'var(--c-accent)', color: 'var(--c-accent-ink)', borderRadius: 4 }}
                >
                  <Code2 size={10} />
                </div>
                <div
                  className="kz-card-soft kz-serif-italic kz-text-mute px-4 py-3 max-w-[80%]"
                  style={{ fontSize: 13 }}
                >
                  {msg.content}
                </div>
              </div>
            );
          }
          if (msg.role === 'user') {
            const canDelete = !!msg.dbId && !msg.streaming;
            return (
              <div key={msg.id} className="flex justify-end group/msg">
                <div className="flex items-center gap-1.5 max-w-[80%]">
                  {/* Hover actions — left of the user bubble */}
                  <div className="flex items-center gap-0.5 opacity-0 group-hover/msg:opacity-100 transition-opacity">
                    <button
                      onClick={() => onCopy(msg.content, msg.id)}
                      className="kz-btn kz-btn--ghost kz-btn--sm"
                      style={{ height: 22, padding: '0 6px' }}
                      title={a.copy}
                    >
                      {copiedIdx === msg.id ? <Check size={11} style={{ color: 'var(--c-success)' }} /> : <Copy size={11} />}
                    </button>
                    {onEditMessage && (
                      <button
                        onClick={() => onEditMessage(msg.id)}
                        className="kz-btn kz-btn--ghost kz-btn--sm"
                        style={{ height: 22, padding: '0 6px' }}
                        title="Edit"
                      >
                        <Pencil size={11} />
                      </button>
                    )}
                    {onDeleteMessage && canDelete && (
                      <button
                        onClick={() => onDeleteMessage(msg.id)}
                        className="kz-btn kz-btn--ghost kz-btn--sm"
                        style={{ height: 22, padding: '0 6px', color: 'var(--c-danger)' }}
                        title="Delete"
                      >
                        <Trash2 size={11} />
                      </button>
                    )}
                  </div>
                  <div
                    className="kz-card min-w-0 select-text cursor-text whitespace-pre-wrap break-words"
                    style={{
                      background: 'var(--c-accent)',
                      color: 'var(--c-accent-ink)',
                      border: '1px solid var(--c-accent)',
                      padding: '10px 14px',
                      borderRadius: '16px 16px 4px 16px',
                      fontSize: 13.5,
                    }}
                  >
                    {msg.content}
                  </div>
                </div>
              </div>
            );
          }
          // assistant
          const isExpanded = expandedSources.has(msg.id);
          const sourcesToShow = msg.sources
            ? isExpanded ? msg.sources : msg.sources.slice(0, SOURCES_PREVIEW_COUNT)
            : [];
          const hasMoreSources = (msg.sources?.length || 0) > SOURCES_PREVIEW_COUNT;

          const canDeleteAsst = !!msg.dbId && !msg.streaming;
          return (
            <div key={msg.id} className="flex items-start gap-3 group/msg">
              <span
                className="flex-shrink-0 grid place-items-center"
                style={{
                  width: 22, height: 22, borderRadius: '50%',
                  background: 'var(--c-accent)', color: 'var(--bg)', marginTop: 2,
                }}
              >
                <span className="kz-serif-italic" style={{ fontSize: 12 }}>K</span>
              </span>
              <div className="max-w-[80%] flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1.5">
                  <span className="kz-serif kz-text-soft" style={{ fontSize: 13 }}>DeepSeno</span>
                  {!msg.streaming && msg.content && (
                    <button
                      onClick={() => onCopy(msg.content, msg.id)}
                      className="kz-btn kz-btn--ghost kz-btn--sm ml-auto"
                      style={{ height: 22, padding: '0 8px', fontSize: 11 }}
                      title={a.copy}
                    >
                      {copiedIdx === msg.id ? (
                        <><Check size={10} style={{ color: 'var(--c-success)' }} /><span style={{ color: 'var(--c-success)' }}>{a.copied}</span></>
                      ) : (
                        <><Copy size={10} /><span>{a.copy}</span></>
                      )}
                    </button>
                  )}
                  {onDeleteMessage && canDeleteAsst && (
                    <button
                      onClick={() => onDeleteMessage(msg.id)}
                      className="kz-btn kz-btn--ghost kz-btn--sm opacity-0 group-hover/msg:opacity-100"
                      style={{ height: 22, padding: '0 6px', color: 'var(--c-danger)', marginLeft: msg.content ? 0 : 'auto' }}
                      title="Delete"
                    >
                      <Trash2 size={10} />
                    </button>
                  )}
                </div>
                <div
                  className="kz-paper select-text cursor-text"
                  style={{ padding: '14px 18px' }}
                >
                  {msg.streaming && !msg.content ? (
                    <div className="flex flex-col gap-1.5">
                      <div className="flex items-center gap-3">
                        <span className="animate-pulse kz-text-mute">
                          {streamStatus === 'searching' ? a.status_searching
                            : streamStatus === 'generating' ? a.status_generating
                            : a.thinking}
                        </span>
                        {elapsed > 0 && (
                          <span className="kz-mono kz-text-faint tabular-nums" style={{ fontSize: 11 }}>{elapsed}s</span>
                        )}
                      </div>
                      <div className="flex items-center gap-1.5">
                        <span
                          className={`kz-sdot ${streamStatus === 'searching' || streamStatus === 'generating' ? 'kz-sdot--accent' : 'kz-sdot--mute'}`}
                        />
                        <span
                          className={`kz-sdot ${streamStatus === 'generating' ? 'kz-sdot--accent' : 'kz-sdot--mute'}`}
                        />
                        <span className="kz-sdot kz-sdot--mute" />
                      </div>
                    </div>
                  ) : (
                    <div className="kz-prose" style={{ maxWidth: 'none', fontSize: 13.5 }}>
                      <Markdown remarkPlugins={[remarkGfm]}>{msg.content}</Markdown>
                      {msg.streaming && (
                        <span
                          className="inline-block ml-0.5 animate-pulse align-text-bottom"
                          style={{ width: 6, height: 16, background: 'var(--ink)' }}
                        ></span>
                      )}
                    </div>
                  )}
                </div>
                {msg.sources && msg.sources.length > 0 && (
                  <div className="kz-card-soft mt-3 overflow-hidden">
                    <div
                      className="px-3 py-2 flex justify-between items-center"
                      style={{ borderBottom: '1px solid var(--line-soft)' }}
                    >
                      <span className="kz-serif-italic kz-text-soft" style={{ fontSize: 12 }}>{a.sources}</span>
                      <span className="kz-mono kz-text-mute" style={{ fontSize: 10.5 }}>
                        {msg.sources.length} {a.source_count}
                      </span>
                    </div>
                    {sourcesToShow.map((src, si) => (
                      <div
                        key={si}
                        onClick={() => onSourceClick(src)}
                        className="kz-row-hover px-3 py-2.5 group/src flex items-center gap-3"
                        style={{ borderTop: si ? '1px solid var(--line-soft)' : 0 }}
                      >
                        <span className="kz-mono kz-text-faint w-16 flex-shrink-0" style={{ fontSize: 10.5 }}>{src.id}</span>
                        <span className="kz-mono kz-text-mute w-12 flex-shrink-0" style={{ fontSize: 10.5 }}>{src.time}</span>
                        <span className="kz-mono kz-text-soft w-14 flex-shrink-0" style={{ fontSize: 11 }}>{src.speaker}</span>
                        <span className="kz-text-mute flex-1 truncate group-hover/src:kz-text-ink" style={{ fontSize: 12.5 }}>
                          {src.text}
                        </span>
                        <ExternalLink size={11} className="kz-text-faint flex-shrink-0" />
                      </div>
                    ))}
                    {hasMoreSources && (
                      <button
                        onClick={() => onToggleSourceExpand(msg.id)}
                        className="kz-row-hover w-full px-3 py-2 flex items-center justify-center gap-1.5 kz-mono kz-text-mute"
                        style={{ borderTop: '1px solid var(--line-soft)', fontSize: 11 }}
                      >
                        {isExpanded ? (
                          <><ChevronUp size={10} />{a.collapse_sources}</>
                        ) : (
                          <><ChevronDown size={10} />{a.show_all_sources} ({msg.sources.length - SOURCES_PREVIEW_COUNT})</>
                        )}
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>
          );
        })}
        {!hasConversation && !isLoading && (
          <div className="flex items-center justify-center mt-8">
            <div className="max-w-lg w-full px-6">
              <p className="kz-serif-italic kz-text-mute mb-4" style={{ fontSize: 13 }}>{a.starter_title}</p>
              <div className="grid grid-cols-2 gap-2">
                {a.starters.map((q, i) => (
                  <button key={i} onClick={() => onStarterClick(q)}
                    className="kz-card kz-row-hover text-left px-3 py-2.5 kz-text-soft"
                    style={{ fontSize: 12 }}>
                    {q}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
        <div ref={ref} />
      </div>
    </div>
  );
});

export default ChatMessages;
