import { useState, useEffect, useCallback, useRef } from 'react';
import { Brain, ArrowRight } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useI18n } from '../i18n';
import { useApi } from '../hooks/useApi';
import type { AppSettings } from '../hooks/useApi';
import MarkdownSplitEditor from '../components/MarkdownSplitEditor';

type SubTab = 'soul' | 'rules';

export default function SoulPage() {
  const { t } = useI18n();
  const api = useApi();
  const navigate = useNavigate();
  const ap = t.agent_page;

  const [subTab, setSubTab] = useState<SubTab>('soul');
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [saved, setSaved] = useState(false);
  const [memoryStats, setMemoryStats] = useState({ core: 0, active: 0, archive: 0 });
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    api.loadSettings().then(setSettings);
    api.memoryGetStats().then(setMemoryStats).catch(() => {});
  }, []);

  const updateField = useCallback((partial: Partial<AppSettings>) => {
    setSettings((prev) => prev ? { ...prev, ...partial } : prev);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      try {
        const updated = await api.updateSettings(partial);
        setSettings(updated);
        setSaved(true);
        setTimeout(() => setSaved(false), 1500);
      } catch { /* silent */ }
    }, 500);
  }, [api]);

  const subTabs: { key: SubTab; label: string; desc: string; placeholder: string }[] = [
    { key: 'soul', label: ap.soul_title, desc: ap.soul_desc, placeholder: ap.soul_placeholder },
    { key: 'rules', label: ap.rules_title, desc: ap.rules_desc, placeholder: ap.rules_placeholder },
  ];

  const currentSubTab = subTabs.find((t) => t.key === subTab)!;
  const currentValue = subTab === 'soul' ? settings?.soulConfig ?? '' : settings?.agentsRules ?? '';
  const handleChange = (val: string) => {
    if (subTab === 'soul') updateField({ soulConfig: val });
    else updateField({ agentsRules: val });
  };

  if (!settings) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="kz-text-mute kz-mono text-sm">{t.common.loading}</div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full gap-4">
      {/* Editorial page header — serif title with italic accent */}
      <div className="kz-ph flex-shrink-0" style={{ marginBottom: 0 }}>
        <div>
          <div className="kz-ph__title">
            {(ap as any).page_title_lead || '这是 '}
            <span className="kz-serif-italic kz-text-accent">DeepSeno</span>
            {(ap as any).page_title_tail || ' 的灵魂。'}
          </div>
          <div className="kz-ph__sub">{currentSubTab.desc}</div>
        </div>
        <div className="kz-ph__right">
          {saved && (
            <span className="kz-badge kz-badge--success kz-badge--dot">
              {t.common.auto_saved}
            </span>
          )}
        </div>
      </div>

      {/* Sub tabs */}
      <div className="flex-shrink-0">
        <div className="kz-tabs">
          {subTabs.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setSubTab(tab.key)}
              className={subTab === tab.key ? 'is-on' : ''}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* Editor — split mode: left = Markdown source, right = rendered preview */}
      <div key={subTab} className="flex-1 min-h-0 overflow-hidden flex flex-col">
        <MarkdownSplitEditor
          value={currentValue}
          onChange={handleChange}
          placeholder={currentSubTab.placeholder}
          className="flex-1 h-full"
          mode="split"
        />
      </div>

      {/* Bottom: Memory stats bar */}
      <div className="kz-card-soft flex items-center justify-between px-4 py-2 flex-shrink-0">
        <div className="flex items-center gap-3">
          <span className="kz-mono kz-text-faint" style={{ fontSize: 9, letterSpacing: '0.16em', textTransform: 'uppercase' }}>
            {ap.memory_stats}
          </span>
          <span className="h-3 w-px" style={{ background: 'var(--line)' }} />
          <div className="flex items-center gap-1.5">
            <span className="kz-sdot kz-sdot--success" />
            <span className="kz-num-display kz-text-soft" style={{ fontSize: 13 }}>{memoryStats.core}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="kz-sdot kz-sdot--info" />
            <span className="kz-num-display kz-text-soft" style={{ fontSize: 13 }}>{memoryStats.active}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="kz-sdot kz-sdot--mute" />
            <span className="kz-num-display kz-text-soft" style={{ fontSize: 13 }}>{memoryStats.archive}</span>
          </div>
        </div>
        <button
          onClick={() => navigate('/memories')}
          className="kz-btn kz-btn--ghost kz-btn--sm flex items-center gap-1.5 group"
        >
          <Brain size={12} />
          {ap.go_to_memories}
          <ArrowRight size={12} className="transition-transform group-hover:translate-x-0.5" />
        </button>
      </div>
    </div>
  );
}
