import { useState, useEffect, useCallback, useRef } from 'react';
import {
  LayoutGrid, Import, BookOpen, BarChart3, ClipboardList, Settings, Brain, Bot, Puzzle,
  Sparkles, Mail, Calendar, Pen, Code2, Search, Hash, MessageSquare, Lightbulb, Wrench, Globe, Cpu, Zap, Clock, Network, Cloud,
} from 'lucide-react';
import logoIcon from '../assets/logo-icon.jpg';
import { useI18n } from '../i18n';
import { useApi } from '../hooks/useApi';
import { useLocation, useNavigate } from 'react-router-dom';
import type { LucideIcon } from 'lucide-react';
import type { KeyboardEvent, MouseEvent } from 'react';
import { useFeatureLevel, meetsLevel } from '../hooks/useFeatureLevel';
import type { FeatureLevel } from '../hooks/useFeatureLevel';

const SKILL_ICON_MAP: Record<string, LucideIcon> = {
  mail: Mail, calendar: Calendar, brain: Brain, sparkles: Sparkles,
  pen: Pen, book: BookOpen, chart: BarChart3, code: Code2,
  search: Search, clipboard: ClipboardList, hash: Hash, message: MessageSquare,
  lightbulb: Lightbulb, wrench: Wrench, globe: Globe, bot: Bot,
};
function resolveSkillIcon(name?: string): LucideIcon {
  return (name && SKILL_ICON_MAP[name]) || Sparkles;
}

interface MenuItem {
  id: string;
  path: string;
  icon: LucideIcon;
  label: string;
  minLevel: FeatureLevel;
}

export default function Sidebar() {
  const { t, lang } = useI18n();
  const api = useApi();
  const location = useLocation();
  const navigate = useNavigate();
  const [apiOnline, setApiOnline] = useState(false);
  const [aiProvider, setAiProvider] = useState<'local' | 'openai'>('local');
  const [isRecording, setIsRecording] = useState(false);
  const [pluginPageItems, setPluginPageItems] = useState<MenuItem[]>([]);
  const featureLevel = useFeatureLevel();
  const brandClickRef = useRef<{ count: number; lastAt: number }>({ count: 0, lastAt: 0 });

  const loadPluginPages = useCallback(() => {
    api.pluginGetAll().then((plugins) => {
      const items: MenuItem[] = plugins
        .filter((p) => p.enabled && p.page)
        .map((p) => ({
          id: `plugin-${p.id}`,
          path: `/plugin/${p.id}`,
          icon: resolveSkillIcon(p.page?.icon),
          label: p.page?.menuLabel || p.name,
          minLevel: 'intermediate' as FeatureLevel,
        }));
      setPluginPageItems(items);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    loadPluginPages();
    const timer = setInterval(loadPluginPages, 5000);
    return () => clearInterval(timer);
  }, [loadPluginPages]);

  useEffect(() => {
    function checkStatus() {
      api.getStatus().then((s) => {
        setApiOnline(s.local);
        setAiProvider(s.aiProvider || 'local');
      }).catch(() => setApiOnline(false));
    }
    checkStatus();
    const timer = setInterval(checkStatus, 30_000);
    const unsub = api.onRecordingStateChanged((_e, recording) => setIsRecording(recording));
    return () => { clearInterval(timer); unsub(); };
  }, [api]);

  const menuGroups: { label: string; items: MenuItem[] }[] = [
    {
      label: t.nav_core,
      items: [
        { id: 'dashboard', path: '/', icon: LayoutGrid, label: t.menu.dashboard, minLevel: 'beginner' },
        { id: 'sources', path: '/sources', icon: Import, label: t.menu.sources, minLevel: 'beginner' },
        { id: 'library', path: '/library', icon: BookOpen, label: t.menu.library, minLevel: 'beginner' },
      ],
    },
    {
      label: t.nav_knowledge,
      items: [
        { id: 'knowledge', path: '/knowledge', icon: Network, label: t.menu.knowledge_graph, minLevel: 'intermediate' },
        { id: 'reports', path: '/reports', icon: BarChart3, label: t.menu.reports, minLevel: 'advanced' },
      ],
    },
    {
      label: t.nav_ai,
      items: [
        { id: 'assistant', path: '/assistant', icon: MessageSquare, label: t.menu.chat, minLevel: 'beginner' },
        { id: 'memories', path: '/memories', icon: Brain, label: t.menu.memories, minLevel: 'intermediate' as FeatureLevel },
        { id: 'soul', path: '/soul', icon: Bot, label: t.menu.soul, minLevel: 'intermediate' as FeatureLevel },
        ...pluginPageItems,
      ],
    },
    {
      label: t.nav_system,
      items: [
        { id: 'models', path: '/models', icon: Cpu, label: t.menu.models, minLevel: 'beginner' },
        { id: 'plugins', path: '/plugins', icon: Puzzle, label: t.menu.skills, minLevel: 'intermediate' as FeatureLevel },
        { id: 'channels', path: '/channels', icon: Zap, label: t.menu.channels, minLevel: 'intermediate' },
        { id: 'feishu-cli-source', path: '/feishu-cli-source', icon: Cloud, label: t.menu.feishu_cli_source || '第三方数据源', minLevel: 'intermediate' },
        { id: 'scheduler', path: '/scheduler', icon: Clock, label: t.menu.scheduler, minLevel: 'advanced' as FeatureLevel },
        { id: 'settings', path: '/settings', icon: Settings, label: t.menu.settings, minLevel: 'beginner' },
      ],
    },
  ];

  const visibleGroups = menuGroups
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => meetsLevel(featureLevel, item.minLevel)),
    }))
    .filter((group) => group.items.length > 0);
  const isCloudAi = aiProvider === 'openai';
  const aiReadyLabel = isCloudAi
    ? ((t.settings as any).cloud_ai_connected || 'Cloud AI capability')
    : ((t.settings as any).local_ai_connected || 'Local AI capability');
  const aiOfflineLabel = isCloudAi
    ? ((t.settings as any).cloud_ai_not_ready || 'Cloud AI capability not ready')
    : ((t.settings as any).local_ai_not_ready || 'Local AI capability not ready');
  const aiStatusLabel = apiOnline ? aiReadyLabel : aiOfflineLabel;

  const handleBrandClick = useCallback((event: MouseEvent<HTMLDivElement>) => {
    const now = Date.now();
    const state = brandClickRef.current;
    state.count = now - state.lastAt <= 1_800 ? state.count + 1 : 1;
    state.lastAt = now;
    if (event.detail >= 3 || state.count >= 3) {
      state.count = 0;
      api.openLogWindow().catch((err) => console.warn('[Sidebar] Failed to open log window:', err));
      return;
    }
    navigate('/');
  }, [api, navigate]);

  const handleBrandKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    navigate('/');
  }, [navigate]);

  return (
    <aside className="side" style={{ width: 240, flexShrink: 0 }}>
      {/* Brand */}
      <div
        className="side__brand"
        role="button"
        tabIndex={0}
        data-log-name="DeepSeno brand shortcut"
        aria-label="DeepSeno"
        style={{ cursor: 'pointer' }}
        onClick={handleBrandClick}
        onKeyDown={handleBrandKeyDown}
      >
        <img
          src={logoIcon}
          alt="DeepSeno"
          className="side__brand-mark"
          style={{ objectFit: 'cover' }}
        />
        <div>
          <div className="side__brand-name">DeepSeno</div>
          <div className="side__brand-tag">{(t.menu as any).brand_tag || 'capture · think · local'}</div>
        </div>
      </div>

      {/* Nav */}
      <nav className="side__nav">
        {visibleGroups.map((group) => (
          <div key={group.label}>
            <div className="side__group">{group.label}</div>
            {group.items.map((item) => {
              const Icon = item.icon;
              const isActive = location.pathname === item.path;
              return (
                <button
                  key={item.id}
                  type="button"
                  className={'side__item' + (isActive ? ' side__item--active' : '')}
                  onClick={() => navigate(item.path)}
                >
                  <Icon size={15} strokeWidth={isActive ? 1.8 : 1.5} />
                  <span className="side__label">{item.label}</span>
                  {item.id === 'sources' && isRecording && <span className="side__dot" />}
                </button>
              );
            })}
          </div>
        ))}
      </nav>

      {/* Footer */}
      <div className="side__foot">
        <span
          className={`side__foot-license ${
            apiOnline ? 'side__foot-license--ready' : 'side__foot-license--not-ready'
          }`}
          title={aiStatusLabel}
        >
          {aiStatusLabel}
        </span>
        <span>v{typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '1.1.0'}</span>
      </div>

      {/* Suppress unused-lang warning while preserving runtime hook order */}
      {lang ? null : null}
    </aside>
  );
}
