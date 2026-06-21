import React, { useState, KeyboardEvent } from 'react';
import { Quote, ArrowRight } from 'lucide-react';
import { useI18n } from '../../i18n';

interface QuickAskProps {
  onSubmit: (query: string) => void;
}

export const QuickAsk = React.memo(function QuickAsk({ onSubmit }: QuickAskProps) {
  const { t } = useI18n();
  const d = t.dash;
  const [value, setValue] = useState('');

  const submit = () => {
    const q = value.trim();
    if (!q) return;
    onSubmit(q);
    setValue('');
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') submit();
  };

  return (
    <div
      className="kz-paper kz-anim-in"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '14px 16px',
        marginBottom: 22,
      }}
    >
      <Quote size={16} className="kz-text-accent shrink-0" />
      <input
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={d.ask_placeholder}
        className="kz-serif-italic"
        style={{
          flex: 1,
          border: 0,
          outline: 0,
          background: 'transparent',
          fontSize: 15,
          color: 'var(--ink)',
        }}
      />
      <button
        onClick={submit}
        disabled={!value.trim()}
        className="kz-btn kz-btn--primary kz-btn--sm"
        style={{ opacity: value.trim() ? 1 : 0.3, cursor: value.trim() ? 'pointer' : 'not-allowed' }}
      >
        {d.ask_btn} <ArrowRight size={11} />
      </button>
    </div>
  );
});
