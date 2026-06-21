import { useI18n } from '../i18n';

interface InlineConfirmProps {
  onConfirm: () => void;
  onCancel: () => void;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
}

export default function InlineConfirm({ onConfirm, onCancel, message, confirmLabel, cancelLabel, destructive = true }: InlineConfirmProps) {
  const { t } = useI18n();
  return (
    <span className="inline-flex items-center gap-1.5">
      {message && <span className="kz-text-soft" style={{ fontSize: '11.5px' }}>{message}</span>}
      <button
        onClick={(e) => { e.stopPropagation(); onConfirm(); }}
        className={`kz-btn kz-btn--sm ${destructive ? 'kz-btn--danger' : 'kz-btn--primary'}`}
      >
        {confirmLabel || t.common.confirm}
      </button>
      <button
        onClick={(e) => { e.stopPropagation(); onCancel(); }}
        className="kz-btn kz-btn--sm"
      >
        {cancelLabel || t.common.cancel}
      </button>
    </span>
  );
}
