import { Zap, Square, FileText, Check, ArrowUp } from 'lucide-react';
import { Translations } from '../../i18n';

interface ChatInputProps {
  input: string;
  isLoading: boolean;
  agentMode: boolean;
  hasConversation: boolean;
  allCopied: boolean;
  showClearConfirm: boolean;
  a: Translations['asst'];
  t: Translations;
  onInputChange: (value: string) => void;
  onSend: (query?: string) => void;
  onStop: () => void;
  onToggleAgentMode: () => void;
  onCopyAllMd: () => void;
  onClearRequest: () => void;
  onClearConfirm: () => void;
  onClearCancel: () => void;
}

export default function ChatInput({
  input,
  isLoading,
  agentMode,
  hasConversation,
  allCopied,
  showClearConfirm,
  a,
  t,
  onInputChange,
  onSend,
  onStop,
  onToggleAgentMode,
  onCopyAllMd,
  onClearRequest,
  onClearConfirm,
  onClearCancel,
}: ChatInputProps) {
  return (
    <div
      className="px-8 py-4"
      style={{ borderTop: '1px solid var(--line-soft)', background: 'var(--bg-card)' }}
    >
      {/* Quick query chips */}
      <div className="flex gap-2 mb-2.5 flex-wrap">
        {a.example_queries.map((q, i) => (
          <button
            key={i}
            onClick={() => { onSend(q); }}
            disabled={isLoading}
            className={`kz-chip kz-chip--outline ${isLoading ? 'opacity-50 cursor-not-allowed' : ''}`}
          >
            {q}
          </button>
        ))}
      </div>

      {/* Composer */}
      <div
        className="kz-card"
        style={{ padding: '10px 12px' }}
      >
        <textarea
          rows={1}
          value={input}
          onChange={(e) => {
            onInputChange(e.target.value);
            // Auto-grow up to 4 rows
            const el = e.target;
            el.style.height = 'auto';
            const lineHeight = 20;
            const maxHeight = lineHeight * 4;
            el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
          }}
          className="w-full bg-transparent outline-none leading-5"
          style={{
            border: 0,
            resize: 'none',
            minHeight: 56,
            fontSize: 13.5,
            color: 'var(--ink)',
          }}
          placeholder={a.placeholder}
          disabled={isLoading}
          aria-label={a.placeholder}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && input.trim() && !isLoading) {
              e.preventDefault();
              onSend();
            }
          }}
        />
        {/* Toolbar */}
        <div className="flex items-center gap-2 mt-1.5">
          <button
            onClick={onToggleAgentMode}
            className={`kz-chip ${agentMode ? 'kz-chip--on' : 'kz-chip--outline'}`}
            title={agentMode ? 'Agent mode: uses MCP tools + Skills' : 'RAG mode: searches recordings'}
          >
            <Zap size={11} />
            {agentMode ? 'AGENT' : 'RAG'}
          </button>
          <div className="flex-1" />
          {hasConversation && (
            <button
              onClick={onCopyAllMd}
              disabled={isLoading}
              className={`kz-btn kz-btn--sm ${allCopied ? '' : ''}`}
              style={allCopied ? { color: 'var(--c-success)', borderColor: 'var(--c-success)' } : undefined}
            >
              {allCopied ? <><Check size={11} />{a.copy_all_done}</> : <><FileText size={11} />{a.copy_all}</>}
            </button>
          )}
          {showClearConfirm ? (
            <div className="flex items-center gap-1.5">
              <span className="kz-mono" style={{ fontSize: 11, color: 'var(--c-danger)' }}>{a.clear_confirm}</span>
              <button
                onClick={onClearConfirm}
                className="kz-btn kz-btn--sm"
                style={{ background: 'var(--c-danger)', color: 'var(--bg)', borderColor: 'var(--c-danger)' }}
              >
                {t.common.confirm}
              </button>
              <button
                onClick={onClearCancel}
                className="kz-btn kz-btn--sm"
              >
                {t.common.cancel}
              </button>
            </div>
          ) : (
            <button
              onClick={onClearRequest}
              disabled={isLoading}
              className={`kz-btn kz-btn--sm ${isLoading ? 'opacity-50 cursor-not-allowed' : ''}`}
            >
              {a.clear}
            </button>
          )}
          {isLoading ? (
            <button
              onClick={onStop}
              className="kz-btn kz-btn--sm"
              title={a.stop}
            >
              <Square size={10} className="kz-text-mute" />
              {a.stop}
            </button>
          ) : (
            <button
              onClick={() => onSend()}
              disabled={!input.trim()}
              className={`kz-btn kz-btn--sm kz-btn--primary ${!input.trim() ? 'opacity-40 cursor-not-allowed' : ''}`}
            >
              <ArrowUp size={11} />
              {a.send}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
