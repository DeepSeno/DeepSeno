import { useEffect } from 'react';
import { X } from 'lucide-react';
import { useI18n } from '../i18n';

interface ShortcutPanelProps {
  isOpen: boolean;
  onClose: () => void;
}

export function ShortcutPanel({ isOpen, onClose }: ShortcutPanelProps) {
  const { t } = useI18n();

  // Close on Escape
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const isMac = navigator.platform.includes('Mac');
  const mod = isMac ? '⌘' : 'Ctrl';

  const groups = [
    {
      title: t.shortcuts.global,
      items: [
        { keys: `${mod}+K`, label: t.shortcuts.search },
        { keys: `${mod}+/`, label: t.shortcuts.shortcuts_panel },
        { keys: `${mod}+,`, label: t.menu.settings },
      ],
    },
    {
      title: t.shortcuts.navigation,
      items: [
        { keys: `${mod}+1`, label: t.menu.dashboard },
        { keys: `${mod}+2`, label: t.menu.sources },
        { keys: `${mod}+3`, label: t.menu.library },
        { keys: `${mod}+4`, label: t.menu.assistant },
      ],
    },
  ];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center kz-anim-in"
      style={{ background: 'oklch(0.3 0.02 60 / 0.35)' }}
      onClick={onClose}
    >
      <div
        className="kz-paper w-[440px] max-h-[520px] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4" style={{ borderBottom: '1px solid var(--line-soft)' }}>
          <span className="kz-serif" style={{ fontSize: '17px' }}>{t.shortcuts.title}</span>
          <button onClick={onClose} className="kz-btn kz-btn--ghost kz-btn--sm" aria-label="Close">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="p-5 space-y-5">
          {groups.map((group) => (
            <div key={group.title}>
              <p className="kz-serif-italic kz-text-mute mb-2" style={{ fontSize: '11.5px' }}>
                {group.title}
              </p>
              <div>
                {group.items.map((item) => (
                  <div
                    key={item.keys}
                    className="kz-row-hover flex items-center justify-between px-2 py-1.5 rounded"
                  >
                    <span className="kz-text-soft" style={{ fontSize: '12px' }}>{item.label}</span>
                    <kbd className="head__kbd">{item.keys}</kbd>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
