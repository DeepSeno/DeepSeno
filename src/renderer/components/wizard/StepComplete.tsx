import { CheckCircle2, ArrowRight } from 'lucide-react';
import { useI18n } from '../../i18n';

interface Props {
  onFinish: () => void;
}

export default function StepComplete({ onFinish }: Props) {
  const { t } = useI18n();
  const w = t.wizard;

  return (
    <div className="flex flex-col items-center justify-center flex-1 px-12 py-8">
      <div
        className="mb-5"
        style={{
          width: 60,
          height: 60,
          borderRadius: '50%',
          background: 'var(--c-success-bg)',
          border: '1px solid color-mix(in oklch, var(--c-success) 25%, transparent)',
          display: 'grid',
          placeItems: 'center',
          color: 'var(--c-success)',
        }}
      >
        <CheckCircle2 size={32} strokeWidth={1.5} />
      </div>
      <h2 className="kz-serif mb-2" style={{ fontSize: '28px', color: 'var(--ink)' }}>{w.complete_title}</h2>
      <p className="kz-serif-italic mb-8" style={{ fontSize: '13px', color: 'var(--ink-soft)' }}>{w.complete_desc}</p>

      <div className="space-y-3 w-full max-w-sm mb-8">
        {w.complete_steps.map((step, i) => (
          <div key={i} className="flex items-start gap-3 kz-text-soft" style={{ fontSize: '13px' }}>
            <span className="kz-mono kz-text-accent" style={{ fontSize: '11px', marginTop: 2 }}>{String(i + 1).padStart(2, '0')}</span>
            <span>{step}</span>
          </div>
        ))}
      </div>

      <div
        className="kz-card-soft kz-mono kz-text-soft max-w-sm mb-3"
        style={{ padding: '12px 16px', fontSize: '11.5px', lineHeight: 1.55 }}
      >
        {w.complete_tip}
      </div>

      <div
        className="kz-card-soft kz-mono kz-text-soft max-w-sm mb-8"
        style={{ padding: '12px 16px', fontSize: '11.5px', lineHeight: 1.55 }}
      >
        {w.bg_download_note}
      </div>

      <button
        onClick={onFinish}
        className="kz-btn kz-btn--accent kz-btn--lg"
      >
        {w.complete_start}
        <ArrowRight size={14} />
      </button>
    </div>
  );
}
