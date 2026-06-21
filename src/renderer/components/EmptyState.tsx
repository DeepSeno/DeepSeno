import type { LucideIcon } from 'lucide-react';

interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  description?: string;
  action?: {
    label: string;
    onClick: () => void;
  };
}

export default function EmptyState({ icon: Icon, title, description, action }: EmptyStateProps) {
  return (
    <div className="kz-empty">
      <div className="kz-empty__icon">
        <Icon size={22} strokeWidth={1.25} />
      </div>
      <div>
        <div className="kz-empty__title">{title}</div>
        {description && <div className="kz-empty__sub">{description}</div>}
      </div>
      {action && (
        <div className="kz-empty__actions">
          <button onClick={action.onClick} className="kz-btn kz-btn--sm">
            {action.label}
          </button>
        </div>
      )}
    </div>
  );
}
