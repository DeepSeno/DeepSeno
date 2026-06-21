import { useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

interface CollapsibleCardProps {
  title: string;
  icon?: LucideIcon;
  defaultOpen?: boolean;
  badge?: ReactNode;
  children: ReactNode;
}

export default function CollapsibleCard({ title, icon: Icon, defaultOpen = true, badge, children }: CollapsibleCardProps) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="rounded-xl shadow-sm overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full px-6 py-3 border-b border-neutral-100 bg-neutral-50 flex justify-between items-center cursor-pointer hover:bg-neutral-50 transition-colors"
      >
        <span className="flex items-center gap-2 text-xs text-neutral-500 uppercase">
          {Icon && <Icon size={14} />}
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          {title}
        </span>
        {badge}
      </button>
      {open && <div className="px-6 py-4">{children}</div>}
    </div>
  );
}
