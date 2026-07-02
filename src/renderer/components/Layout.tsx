import { useEffect, useState, useCallback, useRef } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { Upload, ArrowUpCircle, Loader2, X, AlertTriangle } from 'lucide-react';
import { useI18n } from '../i18n';
import { useApi } from '../hooks/useApi';
import type { SyncStatus } from '../hooks/useApi';
import { useNotifications } from './NotificationCenter';
import { SITE_BASE_URL } from '../config';
import Header from './Header';
import Sidebar from './Sidebar';
import { ShortcutPanel } from './ShortcutPanel';

const PAGE_KEYS: Record<string, string> = {
  '/': 'dashboard',
  '/sources': 'sources',
  '/library': 'library',
  '/assistant': 'assistant',
  '/reports': 'reports',
  '/agent': 'agent',
  '/plugins': 'plugins',
  '/settings': 'settings',
  '/models': 'models',
  '/channels': 'channels',
  '/knowledge': 'knowledge',
  '/vocabulary': 'vocabulary',
};

const SUPPORTED_EXTS = new Set([
  'wav', 'mp3', 'm4a', 'flac', 'ogg', 'webm',
  'mp4', 'mkv', 'avi', 'mov', 'wmv',
  'pdf', 'docx', 'txt', 'md',
  'jpg', 'jpeg', 'png', 'heic', 'webp',
]);
const DOC_EXTS = new Set(['pdf', 'docx', 'txt', 'md']);
const MAX_MEDIA_SIZE = 500 * 1024 * 1024; // 500MB for audio/video
const MAX_DOC_SIZE = 50 * 1024 * 1024;    // 50MB for documents

export default function Layout() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const { t } = useI18n();
  const api = useApi();
  const { toast } = useNotifications();
  const [globalDrag, setGlobalDrag] = useState(false);
  const dragCounter = useRef(0);
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);

  // Auto-update state
  const [updateState, setUpdateState] = useState<'idle' | 'available' | 'downloading' | 'ready' | 'installing' | 'failed'>('idle');
  const [updateVersion, setUpdateVersion] = useState('');
  const [updatePercent, setUpdatePercent] = useState(0);
  const [updateDismissed, setUpdateDismissed] = useState(false);
  const [updateDownloadUrl, setUpdateDownloadUrl] = useState(SITE_BASE_URL);
  const [showShortcuts, setShowShortcuts] = useState(false);

  useEffect(() => {
    const key = PAGE_KEYS[pathname];
    const menu = t.menu as Record<string, string>;
    const pageName = key && menu ? menu[key] : '';
    document.title = pageName ? `DeepSeno - ${pageName}` : 'DeepSeno';
  }, [pathname, t]);

  // Handle keyboard shortcut events from main process
  useEffect(() => {
    const cleanups = [
      api.onShortcutSearch(() => {
        const el = document.querySelector<HTMLElement>('[data-search-input]');
        if (el) el.click();
      }),
      api.onShortcutSettings(() => {
        navigate('/settings');
      }),
    ];
    return () => cleanups.forEach((fn) => fn());
  }, [api, navigate]);

  // Keyboard shortcuts: Cmd+/ for shortcut panel, Cmd+1-5 for navigation
  useEffect(() => {
    const NAV_ROUTES = ['/', '/sources', '/library', '/assistant'];
    const handler = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key === '/') {
        e.preventDefault();
        setShowShortcuts((prev) => !prev);
      }
      const idx = parseInt(e.key, 10);
      if (idx >= 1 && idx <= NAV_ROUTES.length) {
        e.preventDefault();
        navigate(NAV_ROUTES[idx - 1]);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [navigate]);

  // Poll sync status periodically (only when enabled)
  useEffect(() => {
    api.syncGetStatus().then(setSyncStatus);
    const interval = setInterval(() => {
      api.syncGetStatus().then((s) => {
        setSyncStatus(s);
        // Stop polling if sync is not enabled
        if (!s.enabled) return;
      });
    }, 30_000);
    return () => clearInterval(interval);
  }, [api]);

  // Auto-update event listeners
  useEffect(() => {
    const cleanups = [
      api.onUpdateAvailable((_e, { version }) => {
        setUpdateVersion(version);
        setUpdateState('available');
        setUpdateDismissed(false);
      }),
      api.onUpdateDownloadProgress((_e, { percent }) => {
        setUpdateState('downloading');
        setUpdatePercent(Math.round(percent));
      }),
      api.onUpdateDownloaded(() => {
        setUpdateState('ready');
      }),
      api.onUpdateInstallFailed((_e, { downloadUrl }) => {
        if (downloadUrl) setUpdateDownloadUrl(downloadUrl);
        setUpdateState('failed');
        setUpdateDismissed(false);
      }),
    ];
    return () => cleanups.forEach((fn) => fn());
  }, [api]);

  const handleDownloadUpdate = useCallback(async () => {
    setUpdateState('downloading');
    const result = await api.downloadUpdate();
    if (!result.success) {
      setUpdateState('failed');
      setUpdateDismissed(false);
    }
  }, [api]);

  const handleInstallUpdate = useCallback(() => {
    setUpdateState('installing');
    void api.installUpdate();
  }, [api]);

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCounter.current++;
    if (e.dataTransfer.types.includes('Files')) {
      setGlobalDrag(true);
    }
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCounter.current--;
    if (dragCounter.current <= 0) {
      dragCounter.current = 0;
      setGlobalDrag(false);
    }
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }, []);

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    dragCounter.current = 0;
    setGlobalDrag(false);

    // Skip on Recordings page (has its own drop zone)
    if (pathname === '/sources') return;

    const files = Array.from(e.dataTransfer.files);
    let enqueued = 0;
    let skipped = 0;
    let tooLarge = 0;
    for (const file of files) {
      const ext = file.name.split('.').pop()?.toLowerCase() || '';
      if (SUPPORTED_EXTS.has(ext)) {
        let filePath = '';
        try { filePath = api.getPathForFile ? api.getPathForFile(file) : (file as any).path || ''; } catch { filePath = (file as any).path || ''; }
        if (!filePath) { skipped++; continue; }
        const maxSize = DOC_EXTS.has(ext) ? MAX_DOC_SIZE : MAX_MEDIA_SIZE;
        if (file.size > maxSize) {
          tooLarge++;
          continue;
        }
        try {
          const result = await api.enqueue(filePath);
          if (result?.status === 'failed') {
            console.warn('[Layout] Enqueue failed:', result.error);
            skipped++;
          } else {
            enqueued++;
          }
        } catch {
          skipped++;
        }
      }
    }
    if (tooLarge > 0) {
      toast('error', `${tooLarge} ${t.rec.file_too_large}`);
    }
    if (enqueued > 0) {
      toast('success', `${enqueued} ${t.rec.files_queued}`, t.rec.drop_title);
    } else if (files.length > 0 && tooLarge === 0 && skipped === 0) {
      toast('error', t.rec.drop_formats);
    }
  }, [pathname, api, toast, t]);

  return (
    <div
      className="flex h-screen w-full min-w-[1200px] min-h-[700px] selection:bg-neutral-900 selection:text-white overflow-hidden relative"
      style={{ background: 'var(--bg)', color: 'var(--ink)' }}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {/* Global drop overlay */}
      {globalDrag && pathname !== '/sources' && (
        <div className="absolute inset-0 z-[9998] bg-neutral-900/15 backdrop-blur-sm flex items-center justify-center pointer-events-none">
          <div className="bg-white border-2 border-dashed border-neutral-400 rounded-lg px-12 py-8 flex flex-col items-center gap-3 shadow-lg">
            <Upload size={32} className="text-neutral-500" />
            <span className="text-sm font-semibold text-neutral-700">{t.rec.drop_title}</span>
            <span className="text-xs text-neutral-400">{t.rec.drop_formats}</span>
          </div>
        </div>
      )}
      <Sidebar />
      <main
        className="flex-1 flex flex-col h-full overflow-hidden relative"
        style={{ background: 'var(--bg)' }}
      >
        {/* Auto-update banner */}
        {updateState !== 'idle' && !updateDismissed && (
          <div className={`flex items-center justify-between px-4 py-1.5 border-b text-xs ${updateState === 'failed' ? 'bg-amber-50 border-amber-200 text-amber-800' : 'bg-blue-50 border-blue-200 text-blue-800'}`}>
            <span className="flex items-center gap-2">
              {updateState === 'failed' && (
                <>
                  <AlertTriangle size={14} />
                  {(t.update as any).install_failed}
                </>
              )}
              {updateState === 'available' && (
                <>
                  <ArrowUpCircle size={14} />
                  {(t.update as any).available.replace('{version}', updateVersion)}
                </>
              )}
              {updateState === 'downloading' && (
                <>
                  <Loader2 size={14} className="animate-spin" />
                  {(t.update as any).downloading.replace('{percent}', String(updatePercent))}
                </>
              )}
              {updateState === 'ready' && (
                <>
                  <ArrowUpCircle size={14} />
                  {(t.update as any).ready}
                </>
              )}
              {updateState === 'installing' && (
                <>
                  <Loader2 size={14} className="animate-spin" />
                  {(t.update as any).installing}
                </>
              )}
            </span>
            <span className="flex items-center gap-2">
              {updateState === 'available' && (
                <button
                  onClick={handleDownloadUpdate}
                  className="px-2 py-0.5 bg-blue-600 text-white rounded hover:bg-blue-700"
                >
                  {(t.update as any).download}
                </button>
              )}
              {updateState === 'ready' && (
                <button
                  onClick={handleInstallUpdate}
                  className="px-2 py-0.5 bg-blue-600 text-white rounded hover:bg-blue-700"
                >
                  {(t.update as any).install}
                </button>
              )}
              {updateState === 'failed' && (
                <button
                  onClick={() => api.openExternal(updateDownloadUrl)}
                  className="px-2 py-0.5 bg-amber-600 text-white rounded hover:bg-amber-700"
                >
                  {(t.update as any).manual_download}
                </button>
              )}
              {updateState !== 'downloading' && updateState !== 'installing' && (
                <button
                  onClick={() => setUpdateDismissed(true)}
                  className={`p-0.5 rounded ${updateState === 'failed' ? 'hover:bg-amber-100' : 'hover:bg-blue-100'}`}
                >
                  <X size={14} />
                </button>
              )}
            </span>
          </div>
        )}
        {/* Read-only sync banner */}
        {syncStatus?.enabled && syncStatus.readOnly && (
          <div className="flex items-center justify-between px-4 py-1.5 bg-amber-50 border-b border-amber-200 text-xs text-amber-800">
            <span>
              {t.settings.sync_readonly_banner}
              {syncStatus.lockHolder && (
                <> — {syncStatus.lockHolder.hostname} {t.settings.sync_readonly_writing}</>
              )}
            </span>
            <button
              onClick={async () => {
                const result = await api.syncTryAcquireLock();
                if (result.acquired) {
                  toast('success', t.settings.sync_acquired);
                  api.syncGetStatus().then(setSyncStatus);
                } else {
                  toast('error', t.settings.sync_acquire_fail);
                }
              }}
              className="px-2 py-0.5 border border-amber-300 rounded-lg hover:bg-amber-100 text-amber-700"
            >
              {t.settings.sync_try_acquire}
            </button>
          </div>
        )}
        <Header />
        <div className="flex-1 overflow-y-auto p-6">
          <Outlet />
        </div>
      </main>
      <ShortcutPanel isOpen={showShortcuts} onClose={() => setShowShortcuts(false)} />
    </div>
  );
}
