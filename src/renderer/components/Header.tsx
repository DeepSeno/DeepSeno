import { useEffect, useState, useRef } from 'react';
import { Search, Mic, Square, Loader2, ChevronDown, Users, Monitor, Tv, Sun, Moon } from 'lucide-react';
import { useI18n } from '../i18n';
import { useApi } from '../hooks/useApi';
import { useLocation } from 'react-router-dom';
import { NotificationBell, useNotifications } from './NotificationCenter';
import { useTheme } from '../hooks/useTheme';

const routeToTab: Record<string, string> = {
  '/': 'dashboard',
  '/sources': 'sources',
  '/library': 'library',
  '/assistant': 'chat',
  '/reports': 'reports',
  '/soul': 'soul',
  '/memories': 'memories',
  '/scheduler': 'scheduler',
  '/plugins': 'skills',
  '/settings': 'settings',
  '/models': 'models',
  '/channels': 'channels',
  '/help': 'help',
  '/knowledge': 'knowledge_graph',
};

const PAGE_SUB: Record<string, { zh: string; en: string }> = {
  '/':          { zh: '今天 · 个人二脑',          en: 'Today · Personal Second Brain' },
  '/sources':   { zh: '音视频 · 文档 · 文本笔记',  en: 'Media · Documents · Notes' },
  '/library':   { zh: '全部录音 · 片段',           en: 'All recordings · Segments' },
  '/knowledge': { zh: '自动抽取的知识页',          en: 'Auto-extracted knowledge pages' },
  '/reports':   { zh: '日报 · 周报 · 月报',        en: 'Daily · Weekly · Monthly' },
  '/assistant': { zh: '跨全库 RAG 对话',           en: 'Cross-library RAG dialogue' },
  '/memories':  { zh: '核心 · 活跃 · 归档',        en: 'Core · Active · Archive' },
  '/soul':      { zh: 'Agent 人格与规则',          en: 'Agent personality & rules' },
  '/models':    { zh: '本地引擎与云端服务',         en: 'Local engines & cloud services' },
  '/plugins':   { zh: '插件 · 技能 · MCP 工具',    en: 'Plugins · Skills · MCP tools' },
  '/channels':  { zh: '推送 · 同步 · 移动端',      en: 'Push · Sync · Mobile' },
  '/scheduler': { zh: '后台周期任务',              en: 'Background scheduled tasks' },
  '/settings':  { zh: '通用 · 录音 · 系统 · 帮助', en: 'General · Recording · System · Help' },
  '/help':      { zh: '帮助与文档',                en: 'Help & Documentation' },
};

type RecordingScene = 'dictation' | 'local_meeting' | 'online_meeting' | 'media';

const SCENE_ICONS: Record<RecordingScene, React.ComponentType<{ size?: number; className?: string }>> = {
  dictation: Mic,
  local_meeting: Users,
  online_meeting: Monitor,
  media: Tv,
};

const SCENE_OPTIONS: { value: RecordingScene }[] = [
  { value: 'dictation' },
  { value: 'local_meeting' },
  { value: 'online_meeting' },
  { value: 'media' },
];

function getSceneLabel(scene: RecordingScene, t: any): string {
  const key = `recording_scene_${scene}`;
  return (t.settings as any)?.[key] || scene;
}

export default function Header() {
  const { lang, setLang, t } = useI18n();
  const api = useApi();
  const location = useLocation();
  const { theme, toggle: toggleTheme } = useTheme();
  const activeTab = routeToTab[location.pathname] || 'dashboard';
  const [isRecording, setIsRecording] = useState(false);
  const [isPostProcessing, setIsPostProcessing] = useState(false);
  const [showScenePicker, setShowScenePicker] = useState(false);
  const [lastScene, setLastScene] = useState<RecordingScene>(() => {
    try {
      const saved = localStorage.getItem('deepseno-last-scene');
      if (saved && SCENE_OPTIONS.some((o) => o.value === saved)) return saved as RecordingScene;
    } catch {}
    return 'dictation';
  });
  const sceneRef = useRef<HTMLDivElement>(null);
  const { toast } = useNotifications();

  useEffect(() => {
    const unsub = api.onRecordingStateChanged((_event: any, recording: boolean) => {
      setIsRecording(recording);
    });
    return unsub;
  }, []);

  useEffect(() => {
    const unsub1 = api.onPostProcessing?.(((_event: any, data: { active: boolean }) => {
      if (data.active) setIsPostProcessing(true);
    }) as any);
    const unsub2 = api.onPostProcessComplete?.(((_event: any) => {
      setIsPostProcessing(false);
    }) as any);
    return () => { unsub1?.(); unsub2?.(); };
  }, []);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent('toggle-command-palette'));
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  useEffect(() => {
    if (!showScenePicker) return;
    function handleClickOutside(e: MouseEvent) {
      if (sceneRef.current && !sceneRef.current.contains(e.target as Node)) {
        setShowScenePicker(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showScenePicker]);

  const pageTitle = t.menu[activeTab as keyof typeof t.menu] || activeTab;
  const pageSubLocalized = PAGE_SUB[location.pathname];
  const pageSub = pageSubLocalized ? pageSubLocalized[lang === 'en' ? 'en' : 'zh'] : '';

  async function handleToggleRecording() {
    if (isPostProcessing) return;
    try {
      await api.toggleRecording(isRecording ? undefined : lastScene);
    } catch (err) {
      toast('error', t.rec.recording_error, String(err));
    }
  }

  function handleSelectScene(scene: RecordingScene) {
    setLastScene(scene);
    try { localStorage.setItem('deepseno-last-scene', scene); } catch {}
    setShowScenePicker(false);
    api.toggleRecording(scene).catch((err: any) => {
      toast('error', t.rec.recording_error, String(err));
    });
  }

  const CurrentSceneIcon = SCENE_ICONS[lastScene];
  const micTitle = isRecording ? t.rec.recording_stop
    : isPostProcessing ? 'Processing...'
    : `${t.rec.title} — ${getSceneLabel(lastScene, t)}`;

  return (
    <header className="head">
      {/* Crumb — page title + sub */}
      <div className="head__crumb">
        <span className="head__crumb-title">{pageTitle}</span>
        {pageSub ? <span className="head__crumb-meta">{pageSub}</span> : null}
      </div>

      {/* Search — command palette trigger */}
      <div
        className="head__search"
        data-search-input
        tabIndex={0}
        onClick={() => window.dispatchEvent(new CustomEvent('toggle-command-palette'))}
      >
        <Search size={14} />
        <span className="head__search-placeholder">{t.search_placeholder}</span>
        <span className="head__kbd">{navigator.platform.includes('Mac') ? '⌘K' : 'Ctrl+K'}</span>
      </div>

      {/* Right cluster */}
      <div className="head__right">
        {/* Lang toggle */}
        <div className="head__lang">
          <button
            className={lang === 'en' ? 'is-on' : ''}
            onClick={() => { setLang('en'); api.updateSettings({ language: 'en' }).catch(() => {}); }}
          >
            EN
          </button>
          <button
            className={lang === 'zh' ? 'is-on' : ''}
            onClick={() => { setLang('zh'); api.updateSettings({ language: 'zh' }).catch(() => {}); }}
          >
            ZH
          </button>
        </div>

        {/* Theme toggle — sun in dark mode, moon in light mode */}
        <button
          className="head__icon-btn"
          title={theme === 'dark' ? (lang === 'zh' ? '切换浅色主题' : 'Switch to light theme') : (lang === 'zh' ? '切换深色主题' : 'Switch to dark theme')}
          onClick={toggleTheme}
        >
          {theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />}
        </button>

        {/* Mic + scene picker */}
        <div ref={sceneRef} style={{ position: 'relative' }}>
          <div
            className={'head__mic' + (isRecording ? ' head__mic--recording' : '') + (isRecording || isPostProcessing ? ' head__mic--solo' : '')}
            title={micTitle}
          >
            <button
              onClick={handleToggleRecording}
              style={{ display: 'flex', alignItems: 'center', gap: 4, background: 'transparent', border: 0, color: 'inherit', cursor: isPostProcessing ? 'wait' : 'pointer', padding: 0 }}
              title={micTitle}
            >
              {isRecording ? <Square size={13} /> : isPostProcessing ? <Loader2 size={13} className="animate-spin" /> : <CurrentSceneIcon size={14} />}
            </button>
            {!isRecording && !isPostProcessing && (
              <>
                <span className="head__mic-sep" />
                <button
                  className="head__mic-arrow"
                  onClick={() => setShowScenePicker((prev) => !prev)}
                  title={getSceneLabel(lastScene, t)}
                >
                  <ChevronDown size={12} />
                </button>
              </>
            )}
          </div>
          {showScenePicker && !isRecording && !isPostProcessing && (
            <div
              className="kz-card"
              style={{
                position: 'absolute', right: 0, top: 'calc(100% + 6px)',
                minWidth: 180, padding: 4, zIndex: 60,
                boxShadow: '0 8px 24px oklch(0.3 0.02 60 / 0.12)',
              }}
            >
              {SCENE_OPTIONS.map((opt) => {
                const Icon = SCENE_ICONS[opt.value];
                const on = opt.value === lastScene;
                return (
                  <button
                    key={opt.value}
                    onClick={() => handleSelectScene(opt.value)}
                    className="side__item"
                    style={{ width: '100%', fontSize: 12, color: on ? 'var(--ink)' : 'var(--ink-soft)' }}
                  >
                    <Icon size={13} />
                    <span className="side__label">{getSceneLabel(opt.value, t)}</span>
                    {on ? <span className="kz-sdot kz-sdot--accent" /> : null}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Notification bell — styled as icon button via shell */}
        <NotificationBell />
      </div>
    </header>
  );
}
