import type { ReactNode } from 'react';

interface FieldRowProps {
  label: string;
  hint?: string;
  children: ReactNode;
}

export default function FieldRow({ label, hint, children }: FieldRowProps) {
  return (
    <div className="flex items-center justify-between py-3 border-b border-neutral-100 last:border-0 gap-4">
      <div className="flex-shrink-0">
        <div className="text-sm font-mono text-neutral-700">{label}</div>
        {hint && <div className="text-[11px] font-mono text-neutral-400 mt-0.5">{hint}</div>}
      </div>
      <div className="flex items-center gap-2 flex-1 min-w-0 justify-end">{children}</div>
    </div>
  );
}
