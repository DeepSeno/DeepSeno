import type { ExtractedItem } from './types';
import { ITEM_TYPE_CONFIG } from './types';

interface ExtractedPanelProps {
  items: ExtractedItem[];
  tr: Record<string, any>;
}

function badgeToneFromClass(cls: string): string {
  if (/emerald|green/.test(cls)) return 'success';
  if (/red|rose/.test(cls)) return 'danger';
  if (/amber|yellow/.test(cls)) return 'warn';
  if (/blue|sky|cyan/.test(cls)) return 'info';
  if (/violet|purple|fuchsia/.test(cls)) return 'violet';
  return 'mute';
}

export default function ExtractedPanel({ items, tr }: ExtractedPanelProps) {
  if (items.length === 0) return null;

  return (
    <div style={{ marginTop: 18, paddingTop: 18, borderTop: '1px dashed var(--line)' }}>
      <div className="kz-serif-italic kz-text-mute" style={{ fontSize: 12, marginBottom: 12 }}>
        {tr.extracted_info}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {items.map((item, i) => {
          const cfg = ITEM_TYPE_CONFIG[item.type] || ITEM_TYPE_CONFIG.decision;
          const Icon = cfg.icon;
          const tone = badgeToneFromClass(cfg.color);
          const label = (tr as Record<string, any>)[item.type] || item.type;
          return (
            <div
              key={i}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '9px 12px',
                borderRadius: 8,
                background: 'var(--bg-card)',
                border: '1px solid var(--line-soft)',
              }}
            >
              <Icon size={12} className="kz-text-soft" />
              <span className="kz-mono" style={{ fontSize: 12.5, color: 'var(--ink)', flex: 1 }}>{item.content}</span>
              {item.deadline && <span className="kz-mono kz-text-mute" style={{ fontSize: 10.5 }}>{item.deadline}</span>}
              <span className={`kz-badge kz-badge--${tone}`}>{label}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
