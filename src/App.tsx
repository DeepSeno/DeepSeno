import { useState, useEffect, Component, type ReactNode, type ErrorInfo } from 'react';
import { HashRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { I18nProvider } from './renderer/i18n';
import { useApi } from './renderer/hooks/useApi';
import Layout from './renderer/components/Layout';
import Dashboard from './renderer/pages/Dashboard';
import Sources from './renderer/pages/Recordings';
import Library from './renderer/pages/Transcripts';
import Assistant from './renderer/pages/Assistant';
import Reports from './renderer/pages/Reports';
import SettingsPage from './renderer/pages/Settings';
import Models from './renderer/pages/Models';
import Channels from './renderer/pages/Channels';
import FeishuCliSource from './renderer/pages/FeishuCliSource';
import PluginMarket from './renderer/pages/PluginMarket';
import PluginPage from './renderer/pages/PluginPage';
import Help from './renderer/pages/Help';
import SoulPage from './renderer/pages/SoulPage';
import MemoryManager from './renderer/pages/MemoryManager';
import Scheduler from './renderer/pages/Scheduler';
import KnowledgePage from './renderer/pages/KnowledgePage';
import LogWindow from './renderer/pages/LogWindow';
import SetupWizard from './renderer/components/wizard/SetupWizard';
import CommandPalette from './renderer/components/CommandPalette';
import { PageErrorBoundary } from './renderer/components/PageErrorBoundary';
import { NotificationProvider } from './renderer/components/NotificationCenter';
import { RecordingProvider } from './renderer/contexts/RecordingContext';

// Error boundary to prevent white screen on component crashes
class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ErrorBoundary]', error, info.componentStack);
  }
  render() {
    if (this.state.error) {
      return (
        <div className="h-screen w-screen bg-zinc-100 flex items-center justify-center">
          <div className="max-w-lg p-8 bg-white border border-zinc-200 rounded-sm shadow-sm font-mono">
            <div className="text-red-600 text-sm font-bold mb-2">RENDER_ERROR</div>
            <div className="text-zinc-600 text-xs mb-4 whitespace-pre-wrap">{this.state.error.message}</div>
            <button
              onClick={() => { this.setState({ error: null }); window.location.hash = '/'; }}
              className="px-4 py-2 bg-zinc-900 text-white text-xs rounded-sm hover:bg-zinc-700"
            >
              RELOAD
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

/** Redirect that preserves query string + hash. Plain `<Navigate to="/x">`
 * drops `?recording=123` etc., so deep-link navigations from Dashboard
 * silently lost their params via /transcripts → /library redirect. */
function RedirectKeepQuery({ to }: { to: string }) {
  const location = useLocation();
  return <Navigate to={{ pathname: to, search: location.search, hash: location.hash }} replace />;
}

function AppRoutes() {
  return (
    <>
      <Routes>
        <Route path="/logs" element={<PageErrorBoundary pageName="Logs"><LogWindow /></PageErrorBoundary>} />
        <Route element={<Layout />}>
          <Route path="/" element={<PageErrorBoundary pageName="Dashboard"><Dashboard /></PageErrorBoundary>} />
          <Route path="/sources" element={<PageErrorBoundary pageName="Sources"><Sources /></PageErrorBoundary>} />
          <Route path="/library" element={<PageErrorBoundary pageName="Library"><Library /></PageErrorBoundary>} />
          <Route path="/assistant" element={<PageErrorBoundary pageName="Assistant"><Assistant /></PageErrorBoundary>} />
          <Route path="/reports" element={<PageErrorBoundary pageName="Reports"><Reports /></PageErrorBoundary>} />
          <Route path="/soul" element={<PageErrorBoundary pageName="Soul"><SoulPage /></PageErrorBoundary>} />
          <Route path="/memories" element={<PageErrorBoundary pageName="Memories"><div className="overflow-auto -m-6" style={{ height: 'calc(100% + 3rem)' }}><MemoryManager /></div></PageErrorBoundary>} />
          <Route path="/scheduler" element={<PageErrorBoundary pageName="Scheduler"><div className="overflow-auto -m-6" style={{ height: 'calc(100% + 3rem)' }}><Scheduler /></div></PageErrorBoundary>} />
          <Route path="/agent" element={<Navigate to="/soul" replace />} />
          {/* Backward compat redirects (preserve query + hash so deep links survive) */}
          <Route path="/recordings" element={<RedirectKeepQuery to="/sources" />} />
          <Route path="/transcripts" element={<RedirectKeepQuery to="/library" />} />
          {/* /memories and /scheduler are now direct routes, old redirects removed */}
          <Route path="/knowledge" element={<PageErrorBoundary pageName="Knowledge"><KnowledgePage /></PageErrorBoundary>} />
          <Route path="/vocabulary" element={<Navigate to="/knowledge" replace />} />
          <Route path="/plugins" element={<PageErrorBoundary pageName="Plugins"><PluginMarket /></PageErrorBoundary>} />
          <Route path="/plugin/:pluginId" element={<PageErrorBoundary pageName="Plugin"><PluginPage /></PageErrorBoundary>} />
          {/* Backward compat redirect */}
          <Route path="/skills" element={<Navigate to="/plugins" replace />} />
          <Route path="/skill/:skillId" element={<Navigate to="/plugins" replace />} />
          <Route path="/settings" element={<PageErrorBoundary pageName="Settings"><SettingsPage /></PageErrorBoundary>} />
          <Route path="/models" element={<PageErrorBoundary pageName="Models"><Models /></PageErrorBoundary>} />
          <Route path="/channels" element={<PageErrorBoundary pageName="Channels"><Channels /></PageErrorBoundary>} />
          <Route path="/feishu-cli-source" element={<PageErrorBoundary pageName="FeishuCliSource"><FeishuCliSource /></PageErrorBoundary>} />
          <Route path="/help" element={<PageErrorBoundary pageName="Help"><Help /></PageErrorBoundary>} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </>
  );
}

function AppContent() {
  const api = useApi();
  const [setupComplete, setSetupComplete] = useState<boolean | null>(null);
  const [defaultOutputDir, setDefaultOutputDir] = useState('');
  const [defaultWatchDir, setDefaultWatchDir] = useState('');
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [hashPath, setHashPath] = useState(() => window.location.hash || '#/');
  const isLogRoute = hashPath.startsWith('#/logs');

  useEffect(() => {
    api.loadSettings().then((settings) => {
      setSetupComplete(settings.setupComplete);
      setDefaultOutputDir(settings.outputDir || '');
      setDefaultWatchDir(settings.watchDir || '');
    }).catch(() => {
      setSetupComplete(false);
    });
  }, []);

  useEffect(() => {
    function handleToggle() {
      setPaletteOpen((prev) => !prev);
    }
    window.addEventListener('toggle-command-palette', handleToggle);
    return () => window.removeEventListener('toggle-command-palette', handleToggle);
  }, []);

  useEffect(() => {
    const onHashChange = () => setHashPath(window.location.hash || '#/');
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  if (setupComplete === null && !isLogRoute) {
    return (
      <div className="h-screen w-screen bg-zinc-100 flex items-center justify-center">
        <div className="text-zinc-400 font-mono text-sm">Loading...</div>
      </div>
    );
  }

  if (!setupComplete && !isLogRoute) {
    return (
      <SetupWizard
        defaultOutputDir={defaultOutputDir}
        defaultWatchDir={defaultWatchDir}
        onComplete={() => setSetupComplete(true)}
      />
    );
  }

  return (
    <HashRouter>
      <RecordingProvider>
        {!isLogRoute && <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />}
        <AppRoutes />
      </RecordingProvider>
    </HashRouter>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <I18nProvider>
        <NotificationProvider>
          <AppContent />
        </NotificationProvider>
      </I18nProvider>
    </ErrorBoundary>
  );
}
