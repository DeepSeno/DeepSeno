interface StatusBadgeProps {
  status: 'ok' | 'error' | 'warning' | 'neutral' | 'checking';
  label: string;
}

const STATUS_STYLES = {
  ok: 'bg-emerald-50 border-emerald-200 text-emerald-700',
  error: 'bg-red-50 border-red-200 text-red-700',
  warning: 'bg-amber-50 border-amber-200 text-amber-700',
  neutral: 'bg-neutral-50 border-neutral-200 text-neutral-500',
  checking: 'bg-blue-50 border-blue-200 text-blue-700',
} as const;

export default function StatusBadge({ status, label }: StatusBadgeProps) {
  return (
    <span className={`text-[11px] font-mono px-2 py-0.5 rounded-lg border ${STATUS_STYLES[status]}`}>
      {label}
    </span>
  );
}
