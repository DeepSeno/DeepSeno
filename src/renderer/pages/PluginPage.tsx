import { useState, useRef, useEffect } from 'react';
import { Send, Square, RotateCcw } from 'lucide-react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useParams, useNavigate } from 'react-router-dom';
import { useI18n } from '../i18n';
import { useApi } from '../hooks/useApi';

interface ChatMessage {
  id: string;
  role: 'system' | 'user' | 'assistant';
  content: string;
  streaming?: boolean;
}

function nextMsgId() { return Date.now().toString(36) + Math.random().toString(36); }

interface PluginInfo {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  hasInstructions: boolean;
  hasMCP: boolean;
  page?: { icon?: string; menuLabel?: string; welcomeMessage?: string };
}

export default function PluginPage() {
  const { pluginId } = useParams<{ pluginId: string }>();
  const { t } = useI18n();
  const api = useApi();
  const navigate = useNavigate();
  const sp = t.skill_page;

  const [plugin, setPlugin] = useState<PluginInfo | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!pluginId) return;
    api.pluginGetAll().then((plugins) => {
      const found = plugins.find((p) => p.id === pluginId);
      if (!found) {
        setNotFound(true);
        return;
      }
      setPlugin(found);
      const welcome = found.page?.welcomeMessage || `${found.description}`;
      setMessages([{ id: '0', role: 'system', content: welcome }]);
    });
  }, [pluginId]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  async function handleSend() {
    if (!input.trim() || !pluginId || isLoading) return;
    const query = input.trim();
    setInput('');

    const userMsg: ChatMessage = { id: nextMsgId(), role: 'user', content: query };
    const assistantMsg: ChatMessage = { id: nextMsgId(), role: 'assistant', content: '', streaming: true };
    setMessages((prev) => [...prev, userMsg, assistantMsg]);
    setIsLoading(true);

    try {
      const result = await api.agentChatWithPlugin(pluginId, query);
      const content = result.success ? (result.text || '') : `${result.error || 'Unknown error'}`;
      setMessages((prev) => {
        const updated = [...prev];
        const lastIdx = updated.length - 1;
        if (updated[lastIdx]?.streaming) {
          updated[lastIdx] = { ...updated[lastIdx], content, streaming: false };
        }
        return updated;
      });
    } catch (err) {
      setMessages((prev) => {
        const updated = [...prev];
        const lastIdx = updated.length - 1;
        if (updated[lastIdx]?.streaming) {
          updated[lastIdx] = { ...updated[lastIdx], content: String(err), streaming: false };
        }
        return updated;
      });
    } finally {
      setIsLoading(false);
    }
  }

  function handleClear() {
    if (!plugin) return;
    const welcome = plugin.page?.welcomeMessage || `${plugin.description}`;
    setMessages([{ id: '0', role: 'system', content: welcome }]);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  if (notFound) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3">
        <div className="kz-empty">
          <div className="kz-empty__title">{sp.not_found}</div>
        </div>
        <button
          onClick={() => navigate('/plugins')}
          className="kz-btn kz-btn--sm kz-btn--ghost"
        >
          {t.menu.skills}
        </button>
      </div>
    );
  }

  if (!plugin) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="kz-mono kz-text-mute" style={{ fontSize: 13 }}>{t.common.loading}</div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full -m-8">
      {/* Header */}
      <div className="flex-shrink-0" style={{ padding: '18px 24px', borderBottom: '1px solid var(--line-soft)' }}>
        <h1 className="kz-serif kz-text-ink" style={{ fontSize: 22 }}>{plugin.page?.menuLabel || plugin.name}</h1>
        <p className="kz-serif-italic kz-text-mute mt-0.5" style={{ fontSize: 12 }}>{plugin.description}</p>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
        {messages.map((msg) => {
          if (msg.role === 'system') {
            return (
              <div key={msg.id} className="text-center py-6">
                <p className="kz-serif-italic kz-text-mute" style={{ fontSize: 13.5 }}>{msg.content}</p>
              </div>
            );
          }
          if (msg.role === 'user') {
            return (
              <div key={msg.id} className="flex justify-end">
                <div
                  className="max-w-[70%] leading-relaxed"
                  style={{
                    padding: '10px 14px',
                    borderRadius: 14,
                    borderBottomRightRadius: 4,
                    background: 'var(--c-accent)',
                    color: 'var(--c-accent-ink)',
                    fontSize: 13.5,
                  }}
                >
                  {msg.content}
                </div>
              </div>
            );
          }
          // assistant
          return (
            <div key={msg.id} className="flex gap-2.5">
              <div
                className="flex items-center justify-center flex-shrink-0 mt-1"
                style={{
                  width: 22,
                  height: 22,
                  borderRadius: '50%',
                  background: 'var(--bg-elev)',
                  border: '1px solid var(--line)',
                }}
              >
                <span className="kz-mono kz-text-soft" style={{ fontSize: 10 }}>AI</span>
              </div>
              <div className="flex-1 min-w-0">
                {msg.streaming && !msg.content ? (
                  <div className="kz-mono kz-text-mute animate-pulse" style={{ fontSize: 13 }}>{sp.thinking}</div>
                ) : (
                  <div className="kz-prose">
                    <Markdown remarkPlugins={[remarkGfm]}>{msg.content}</Markdown>
                  </div>
                )}
              </div>
            </div>
          );
        })}
        <div ref={messagesEndRef} />
      </div>

      {/* Input area */}
      <div className="flex-shrink-0" style={{ padding: '12px 24px', borderTop: '1px solid var(--line-soft)' }}>
        <div className="flex items-end gap-2">
          <button
            onClick={handleClear}
            className="kz-btn kz-btn--ghost kz-btn--sm flex-shrink-0"
            title={sp.clear}
          >
            <RotateCcw size={16} />
          </button>
          <div className="flex-1 relative">
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={sp.placeholder}
              rows={1}
              className="w-full kz-text-ink resize-none"
              style={{
                background: 'var(--bg-card)',
                border: '1px solid var(--line)',
                borderRadius: 10,
                padding: '10px 14px',
                fontSize: 13,
                outline: 'none',
                minHeight: 40,
                maxHeight: 120,
              }}
            />
          </div>
          <button
            onClick={isLoading ? undefined : handleSend}
            disabled={!input.trim() && !isLoading}
            className={`kz-btn flex-shrink-0 ${
              isLoading
                ? 'kz-btn--danger'
                : input.trim()
                  ? 'kz-btn--primary'
                  : 'kz-btn--ghost'
            }`}
            style={{ opacity: !input.trim() && !isLoading ? 0.4 : 1 }}
          >
            {isLoading ? <Square size={16} /> : <Send size={16} />}
          </button>
        </div>
      </div>
    </div>
  );
}
