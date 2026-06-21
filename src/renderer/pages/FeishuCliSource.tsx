import { useState, useEffect, useCallback } from 'react';
import { Download, RefreshCw, LogIn, LogOut, CheckCircle, XCircle, Circle, Play, Settings, Clock } from 'lucide-react';
import { useI18n } from '../i18n';
import { useApi } from '../hooks/useApi';
import { useNotifications } from '../components/NotificationCenter';
import { CollapsibleCard, FieldRow, BTN, INPUT } from '../components/settings';
import { useSettings } from '../hooks/useSettings';

interface CliStatus {
  installed: boolean;
  installPath: string | null;
  configured: boolean;
  loggedIn: boolean;
  user: { open_id: string; name: string; avatar_url?: string; scopes: string[] } | null;
  lastSyncAt: string | null;
  error?: string;
}

export default function FeishuCliSource() {
  const { t } = useI18n();
  const s = t.settings;
  const api = useApi();
  const { toast } = useNotifications();
  const { settings, saved, updateField } = useSettings();

  const [activeTab, setActiveTab] = useState<'feishu'>('feishu');
  const [status, setStatus] = useState<CliStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [installing, setInstalling] = useState(false);
  const [configuring, setConfiguring] = useState(false);
  const [loginUrl, setLoginUrl] = useState<string | null>(null);
  const [polling, setPolling] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<string | null>(null);
  const [syncOk, setSyncOk] = useState(false);

  const refreshStatus = useCallback(async () => {
    try {
      const st = await api.feishuCliGetStatus();
      setStatus(st);
    } catch {
      setStatus(null);
    }
    setLoading(false);
  }, [api]);

  useEffect(() => { refreshStatus(); }, [refreshStatus]);

  const handleInstall = useCallback(async () => {
    setInstalling(true);
    try {
      const result = await api.feishuCliInstall();
      if (result.ok) {
        toast('success', s.feishu_cli_install_ok, 'Feishu CLI provider 已就绪');
      } else {
        toast('error', s.feishu_cli_install_fail, result.error);
      }
    } catch (err: any) {
      toast('error', s.feishu_cli_install_fail, err.message);
    }
    setInstalling(false);
    await refreshStatus();
  }, [api, toast, refreshStatus, s]);

  const handleInitConfig = useCallback(async () => {
    setConfiguring(true);
    try {
      const result = await api.feishuCliInitConfig();
      if (result.ok && result.url) {
        setLoginUrl(result.url);
        api.openExternal(result.url);
        toast('success', s.feishu_cli_init_ok, s.feishu_cli_init_browser);
      } else if (result.ok) {
        toast('success', s.feishu_cli_init_ok2, s.feishu_cli_init_done);
      } else {
        toast('error', s.feishu_cli_init_fail, result.error);
      }
    } catch (err: any) {
      toast('error', s.feishu_cli_init_fail, err.message);
    }
    setConfiguring(false);
    await refreshStatus();
  }, [api, toast, refreshStatus, s]);

  const handleLogin = useCallback(async () => {
    try {
      const result = await api.feishuCliLogin();
      if (result.ok && result.url) {
        setLoginUrl(result.url);
        api.openExternal(result.url);
        toast('info', s.feishu_cli_login_info, s.feishu_cli_login_browser);
        if (result.deviceCode) {
          setPolling(true);
          const pollResult = await api.feishuCliPollLogin(result.deviceCode);
          setPolling(false);
          if (pollResult.ok) {
            toast('success', s.feishu_cli_login_ok, '');
          } else {
            toast('error', s.feishu_cli_login_timeout, pollResult.error);
          }
        }
      } else {
        toast('error', s.feishu_cli_login_fail, result.error);
      }
    } catch (err: any) {
      toast('error', s.feishu_cli_login_fail, err.message);
    }
    await refreshStatus();
  }, [api, toast, refreshStatus, s]);

  const handleLogout = useCallback(async () => {
    try {
      const result = await api.feishuCliLogout();
      if (result.ok) {
        toast('success', s.feishu_cli_logout_ok, '');
      } else {
        toast('error', s.feishu_cli_logout_fail, result.error);
      }
    } catch (err: any) {
      toast('error', s.feishu_cli_logout_fail, err.message);
    }
    await refreshStatus();
  }, [api, toast, refreshStatus, s]);

  const handleSync = useCallback(async () => {
    setSyncing(true);
    setSyncResult(null);
    setSyncOk(false);
    try {
      const result = await api.feishuCliSyncNow();
      if (result.ok) {
        const msg = s.feishu_cli_sync_result
          .replace('{documents}', String(result.documents))
          .replace('{chunks}', String(result.chunks));
        setSyncResult(msg);
        setSyncOk(true);
        toast('success', s.feishu_cli_sync_ok, msg);
      } else {
        setSyncResult(result.error || s.feishu_cli_sync_fail);
        toast('error', s.feishu_cli_sync_fail, result.error);
      }
    } catch (err: any) {
      setSyncResult(err.message);
      toast('error', s.feishu_cli_sync_fail, err.message);
    }
    setSyncing(false);
    await refreshStatus();
  }, [api, toast, refreshStatus, s]);

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="kz-text-mute kz-mono text-sm">{t.common.loading}</div>
      </div>
    );
  }

  const tabs: { id: 'feishu'; label: string }[] = [
    { id: 'feishu', label: s.feishu_cli_tab },
  ];

  return (
    <div className="flex flex-col h-full">
      {saved && (
        <div className="fixed bottom-6 right-6 z-50 flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-zinc-900 text-white text-[11px] kz-mono shadow-lg pointer-events-none">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
          auto-saved
        </div>
      )}

      {/* ── 梯形标签栏 ── */}
      <div className="relative flex items-end gap-0 pl-2" style={{ borderBottom: '1px solid #e4e4e7', background: 'transparent' }}>
        {tabs.map((tab) => {
          const active = activeTab === tab.id;
          return (
            <div
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              role="button"
              style={{ position: 'relative', marginBottom: active ? '-1px' : '0', cursor: 'pointer', userSelect: 'none' }}
            >
              <svg viewBox="0 0 120 34" preserveAspectRatio="none"
                style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', overflow: 'visible' }}>
                <path d="M10,0 L110,0 L120,34 L0,34 Z"
                  fill={active ? 'white' : 'transparent'}
                  stroke="#e4e4e7" strokeWidth="1" vectorEffect="non-scaling-stroke" />
                {active && <line x1="0" y1="34" x2="120" y2="34" stroke="white" strokeWidth="2" vectorEffect="non-scaling-stroke" />}
              </svg>
              <span
                className={`relative z-10 block px-5 py-1 text-xs kz-mono font-medium transition-colors ${active ? 'text-zinc-900' : 'text-zinc-400 hover:text-zinc-600'}`}
                style={{ minWidth: 72, textAlign: 'center' }}
              >
                {tab.label}
              </span>
            </div>
          );
        })}
      </div>

      {/* ── 标签内容 ── */}
      <div className="flex-1 overflow-y-auto">
        {activeTab === 'feishu' && (
          <div className="space-y-6 p-1 pt-5">

            {/* ── 数据源配置 ── */}
            <CollapsibleCard title={s.feishu_cli_section_config} icon={Download}>
              <FieldRow label={s.feishu_cli_enable} hint={s.feishu_cli_enable_hint}>
                <ToggleSwitch
                  checked={settings?.feishuCliEnabled || false}
                  onChange={(checked) => updateField({ feishuCliEnabled: checked })}
                />
              </FieldRow>
            </CollapsibleCard>

            {/* ── CLI 运行环境 ── */}
            <CollapsibleCard title={s.feishu_cli_section_env} icon={Settings}>
              <div className="flex items-center justify-between mb-3">
                <span className="text-xs kz-text-soft kz-serif-italic">{s.feishu_cli_status}</span>
                <span className={`kz-badge ${status?.installed ? 'kz-badge--success' : 'kz-badge--mute'}`}>
                  <span className={`kz-sdot ${status?.installed ? 'kz-sdot--success' : 'kz-sdot--mute'}`} />
                  {status?.installed ? s.feishu_cli_installed : s.feishu_cli_not_installed}
                </span>
              </div>
              {!status?.installed ? (
                <div className="mb-3 p-3 bg-zinc-50 border border-zinc-200 rounded-lg">
                  <p className="text-[11px] kz-text-soft kz-serif-italic mb-2">{s.feishu_cli_install_desc}</p>
                  <button
                    onClick={handleInstall}
                    disabled={installing}
                    className={`${BTN} inline-flex items-center gap-1.5 ${installing ? 'opacity-40 cursor-not-allowed' : ''}`}
                  >
                    <Download size={12} className={installing ? 'animate-pulse' : ''} />
                    {installing ? s.feishu_cli_installing : s.feishu_cli_install_btn}
                  </button>
                </div>
              ) : (
                <div className="mb-3 text-xs kz-text-soft kz-mono">
                  {s.feishu_cli_installed_path} {status.installPath || 'bundled cli'}
                </div>
              )}

              <div className="flex items-center justify-between mt-4 pt-3 border-t border-neutral-100">
                <span className="text-xs kz-text-soft kz-serif-italic">{s.feishu_cli_app_config}</span>
                <span className={`kz-badge ${status?.configured ? 'kz-badge--success' : 'kz-badge--mute'}`}>
                  {status?.configured ? <CheckCircle size={11} className="mr-1" /> : <Circle size={11} className="mr-1" />}
                  {status?.configured ? s.feishu_cli_configured : s.feishu_cli_not_configured}
                </span>
              </div>
              {!status?.configured && status?.installed && (
                <button
                  onClick={handleInitConfig}
                  disabled={configuring || !settings?.feishuCliEnabled}
                  className={`${BTN} inline-flex items-center gap-1.5 mt-2 ${configuring || !settings?.feishuCliEnabled ? 'opacity-40 cursor-not-allowed' : ''}`}
                >
                  <Settings size={12} className={configuring ? 'animate-spin' : ''} />
                  {configuring ? s.feishu_cli_initing : s.feishu_cli_init_btn}
                </button>
              )}
              {loginUrl && !status?.loggedIn && (
                <div className="mt-2 p-2 bg-blue-50 border border-blue-200 rounded-lg">
                  <p className="text-[11px] text-blue-700 kz-mono break-all">{loginUrl}</p>
                </div>
              )}
            </CollapsibleCard>

            {/* ── 鉴权 ── */}
            <CollapsibleCard title={s.feishu_cli_section_auth} icon={status?.loggedIn ? CheckCircle : XCircle}>
              <div className="flex items-center justify-between mb-3">
                <span className="text-xs kz-text-soft kz-serif-italic">{s.feishu_cli_login_status}</span>
                <span className={`kz-badge ${status?.loggedIn ? 'kz-badge--success' : 'kz-badge--mute'}`}>
                  <span className={`kz-sdot ${status?.loggedIn ? 'kz-sdot--success' : 'kz-sdot--mute'}`} />
                  {status?.loggedIn ? s.feishu_cli_logged_in : s.feishu_cli_not_logged_in}
                </span>
              </div>

              {status?.loggedIn && status.user && (
                <div className="mb-3 space-y-1.5">
                  <FieldRow label={s.feishu_cli_user}>
                    <span className="text-sm kz-text-ink kz-mono">{status.user.name}</span>
                  </FieldRow>
                  <FieldRow label={s.feishu_cli_open_id}>
                    <span className="text-xs kz-text-soft kz-mono">{status.user.open_id}</span>
                  </FieldRow>
                  <FieldRow label={s.feishu_cli_scopes} hint={s.feishu_cli_scopes_hint}>
                    <div className="flex flex-wrap gap-1 mt-1">
                      {status.user.scopes.map((scope) => (
                        <span key={scope} className="text-[10px] bg-zinc-100 px-1.5 py-0.5 rounded kz-mono kz-text-soft">
                          {scope}
                        </span>
                      ))}
                    </div>
                  </FieldRow>
                </div>
              )}

              {!status?.installed ? (
                <div className="text-[11px] kz-text-mute kz-serif-italic">{s.feishu_cli_need_install}</div>
              ) : (
                <div className="flex items-center gap-2">
                  <button
                    onClick={handleLogin}
                    disabled={polling || !settings?.feishuCliEnabled}
                    className={`${BTN} inline-flex items-center gap-1.5 ${polling || !settings?.feishuCliEnabled ? 'opacity-40 cursor-not-allowed' : ''}`}
                  >
                    <LogIn size={12} className={polling ? 'animate-pulse' : ''} />
                    {polling ? s.feishu_cli_login_wait : s.feishu_cli_login_btn}
                  </button>
                  {status?.loggedIn && (
                    <button onClick={handleLogout} className={`${BTN} inline-flex items-center gap-1.5 text-red-600 border-red-200`}>
                      <LogOut size={12} />
                      {s.feishu_cli_logout_btn}
                    </button>
                  )}
                </div>
              )}

              {status?.error && (
                <div className="mt-2 p-2 bg-red-50 border border-red-200 rounded text-[11px] text-red-700 kz-mono">
                  {status.error}
                </div>
              )}
            </CollapsibleCard>

            {/* ── 数据同步 ── */}
            <CollapsibleCard title={s.feishu_cli_section_sync} icon={RefreshCw}>
              <div className="flex items-center justify-between mb-3">
                <span className="text-xs kz-text-soft kz-serif-italic">{s.feishu_cli_sync_scopes}</span>
                <div className="flex gap-1 flex-wrap justify-end">
                  {['calendar', 'task', 'doc', 'im'].map((d) => (
                    <span key={d} className="text-[11px] bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 px-2 py-0.5 rounded kz-mono">
                      {d}
                    </span>
                  ))}
                </div>
              </div>

              <FieldRow label={s.feishu_cli_sync_btn} hint={s.feishu_cli_sync_hint}>
                <button
                  onClick={handleSync}
                  disabled={syncing || !status?.loggedIn}
                  className={`${BTN} inline-flex items-center gap-1.5 ${syncing || !status?.loggedIn ? 'opacity-40 cursor-not-allowed' : ''}`}
                >
                  <Play size={12} className={syncing ? 'animate-spin' : ''} />
                  {syncing ? s.feishu_cli_syncing : s.feishu_cli_sync_btn}
                </button>
              </FieldRow>

              {syncResult && (
                <div className={`mt-2 p-2 rounded text-[11px] kz-mono border ${
                  syncOk ? 'bg-green-50 border-green-200 text-green-700' : 'bg-red-50 border-red-200 text-red-700'
                }`}>
                  {syncResult}
                </div>
              )}

              {status?.lastSyncAt && (
                <div className="mt-3 pt-3 border-t border-neutral-100">
                  <span className="text-xs kz-text-soft kz-serif-italic">
                    {s.feishu_cli_last_sync} {new Date(status.lastSyncAt).toLocaleString()}
                  </span>
                </div>
              )}
            </CollapsibleCard>

            {/* ── 使用说明 ── */}
            <CollapsibleCard title={s.feishu_cli_section_guide} icon={Clock}>
              <ol className="text-[11px] kz-text-soft space-y-1.5 list-decimal list-inside kz-serif-italic">
                <li>{s.feishu_cli_guide_1}</li>
                <li>{s.feishu_cli_guide_2}</li>
                <li>{s.feishu_cli_guide_3}</li>
                <li>{s.feishu_cli_guide_4}</li>
                <li>{s.feishu_cli_guide_5}</li>
                <li>{s.feishu_cli_guide_6}</li>
              </ol>
            </CollapsibleCard>

          </div>
        )}
      </div>
    </div>
  );
}

function ToggleSwitch({ checked, disabled, onChange }: { checked: boolean; disabled?: boolean; onChange: (checked: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => !disabled && onChange(!checked)}
      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
        checked ? 'bg-zinc-900' : 'bg-zinc-200'
      } ${disabled ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'}`}
    >
      <span
        className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow-sm transition-transform ${
          checked ? 'translate-x-4.5' : 'translate-x-0.5'
        }`}
      />
    </button>
  );
}
