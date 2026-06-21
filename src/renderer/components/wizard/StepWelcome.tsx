import { Mic, MessageSquare, ListTodo, Sparkles, Shield } from 'lucide-react';
import { useI18n } from '../../i18n';

const ICONS = [Mic, MessageSquare, ListTodo, Sparkles];

interface Props {
  onNext: () => void;
}

export default function StepWelcome({ onNext }: Props) {
  const { t } = useI18n();
  const w = t.wizard;

  return (
    <div className="flex flex-col items-center justify-center flex-1 px-12 py-8">
      <div className="kz-serif" style={{ fontSize: '32px', letterSpacing: '-0.02em', color: 'var(--ink)' }}>{w.title}</div>
      <div className="kz-mono kz-text-mute mt-2" style={{ fontSize: '11px', letterSpacing: '0.16em', textTransform: 'uppercase' }}>{w.subtitle}</div>
      <div className="kz-serif-italic mt-6 mb-8" style={{ fontSize: '15px', color: 'var(--ink-soft)' }}>{w.tagline}</div>

      <div className="space-y-3 w-full max-w-sm mb-8">
        {w.features.map((feat, i) => {
          const Icon = ICONS[i] || Mic;
          return (
            <div key={i} className="flex items-center gap-3 kz-text-soft" style={{ fontSize: '13px' }}>
              <Icon size={14} className="kz-text-mute flex-shrink-0" />
              <span>{feat}</span>
            </div>
          );
        })}
      </div>

      <div className="flex items-center gap-2 kz-text-mute mb-8" style={{ fontSize: '11.5px' }}>
        <Shield size={12} />
        <span>{w.privacy}</span>
      </div>

      <button
        onClick={onNext}
        className="kz-btn kz-btn--primary kz-btn--lg"
      >
        {w.start} →
      </button>
    </div>
  );
}
