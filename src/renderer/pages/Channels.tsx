import { useState, useEffect, useCallback } from 'react';
import { Cloud } from 'lucide-react';
import { useI18n } from '../i18n';
import { useApi } from '../hooks/useApi';
import type { SyncStatus } from '../hooks/useApi';
import { useSettings } from '../hooks/useSettings';
import { useNotifications } from '../components/NotificationCenter';
import { CollapsibleCard, FieldRow, StatusBadge, ToggleSwitch } from '../components/settings';
import OutputSection from './settings/OutputSection';

export default function Channels() {
  const { t } = useI18n();
  const api = useApi();
  const { toast } = useNotifications();
  const s = t.settings;
  const { settings, saved, updateField } = useSettings();

  // ─── Integrations state ──────────────────────────────────────
  const [obsidianSyncing, setObsidianSyncing] = useState(false);
  const [obsidianSyncResult, setObsidianSyncResult] = useState<string | null>(null);
  const [feishuStatus, setFeishuStatus] = useState<string>('disconnected');
  const [feishuTesting, setFeishuTesting] = useState(false);
  const [feishuTestResult, setFeishuTestResult] = useState<string | null>(null);
  const [wechatTesting, setWechatTesting] = useState(false);
  const [wechatTestResult, setWechatTestResult] = useState<string | null>(null);
  const [telegramTesting, setTelegramTesting] = useState(false);
  const [telegramTestResult, setTelegramTestResult] = useState<string | null>(null);
  const [emailTesting, setEmailTesting] = useState(false);
  const [emailTestResult, setEmailTestResult] = useState<string | null>(null);
  // OpenClaw WeChat (Personal)
  const [openclawWechatStatus, setOpenclawWechatStatus] = useState<'connected' | 'authenticated' | 'disconnected'>('disconnected');
  const [openclawWechatScanning, setOpenclawWechatScanning] = useState(false);
  const [openclawWechatQrImage, setOpenclawWechatQrImage] = useState<string | null>(null);
  const [openclawWechatTestResult, setOpenclawWechatTestResult] = useState<string | null>(null);

  // ─── Sync state ──────────────────────────────────────────────
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  const [syncLoading, setSyncLoading] = useState(false);

  // ─── Load data on mount ────────────────────────────────────
  useEffect(() => {
    api.feishuGetStatus().then((r) => setFeishuStatus(r.status));
    api.openclawWechatGetStatus().then((r) => setOpenclawWechatStatus(r.status)).catch(() => {});
    api.syncGetStatus().then(setSyncStatus);
  }, []);

  // ─── Core callbacks ──────────────────────────────────────────
  const handleDirChange = useCallback(async (field: 'obsidianVaultDir') => {
    const dir = await api.selectDirectory();
    if (dir) {
      updateField({ [field]: dir });
    }
  }, [api, updateField]);

  const handleOpenExternal = useCallback((path: string) => {
    try { api.openExternal(path); } catch {}
  }, [api]);

  // ─── Integration handlers ────────────────────────────────────
  const handleObsidianSync = useCallback(async () => {
    if (!settings?.obsidianVaultDir) return;
    setObsidianSyncing(true);
    setObsidianSyncResult(null);
    try {
      const result = await api.obsidianSyncAll();
      if (result.success) {
        setObsidianSyncResult(`${result.count} ${s.obsidian_synced}`);
        toast('success', s.obsidian_sync_success, `${result.count} ${s.obsidian_sync_files}`);
      } else {
        setObsidianSyncResult(result.error || s.obsidian_sync_failed);
        toast('error', s.obsidian_sync_failed, result.error);
      }
    } catch {
      setObsidianSyncResult(s.obsidian_sync_failed);
      toast('error', s.obsidian_sync_failed);
    }
    setObsidianSyncing(false);
  }, [api, settings?.obsidianVaultDir, s, toast]);

  const handleFeishuTest = useCallback(async () => {
    if (!settings) return;
    setFeishuTesting(true);
    setFeishuTestResult(null);
    try {
      const result = await api.feishuTestConnection(settings.feishuAppId, settings.feishuAppSecret);
      if (result.success) {
        setFeishuTestResult(s.feishu_test_ok);
        if (result.adminOpenId && !settings.feishuAdminOpenId) {
          updateField({ feishuAdminOpenId: result.adminOpenId });
        }
        toast('success', s.feishu_test_ok);
      } else {
        setFeishuTestResult(result.error || s.feishu_test_fail);
        toast('error', s.feishu_test_fail, result.error);
      }
    } catch {
      setFeishuTestResult(s.feishu_test_fail);
    }
    setFeishuTesting(false);
  }, [api, settings, s, toast, updateField]);

  const handleFeishuRestart = useCallback(async () => {
    const result = await api.feishuRestart();
    setFeishuStatus(result.status);
    if (result.status === 'connected') toast('success', s.feishu_connected);
    else if (result.error) toast('error', s.feishu_error, result.error);
  }, [api, s, toast]);

  const handleWechatTest = useCallback(async () => {
    if (!settings) return;
    setWechatTesting(true);
    setWechatTestResult(null);
    try {
      if (!settings.wechatCorpId || !settings.wechatAgentId || !settings.wechatSecret) {
        setWechatTestResult(s.wechat_test_fail);
        toast('error', s.wechat_test_fail);
      } else {
        const result = await api.wechatTestConnection(settings.wechatCorpId, settings.wechatSecret);
        if (result.success) {
          setWechatTestResult(s.wechat_test_ok);
          toast('success', s.wechat_test_ok);
        } else {
          setWechatTestResult(`${s.wechat_test_fail}: ${result.error || ''}`);
          toast('error', s.wechat_test_fail, result.error);
        }
      }
    } catch (err: any) {
      setWechatTestResult(s.wechat_test_fail);
      toast('error', s.wechat_test_fail, err?.message);
    }
    setWechatTesting(false);
  }, [api, settings, s, toast]);

  const handleWechatRestart = useCallback(async () => {
    if (!settings) return;
    await api.updateSettings({
      wechatCorpId: settings.wechatCorpId,
      wechatAgentId: settings.wechatAgentId,
      wechatSecret: settings.wechatSecret,
      wechatEnabled: settings.wechatEnabled,
    });
    toast('success', s.wechat_save_restart);
  }, [api, settings, s, toast]);

  const handleTelegramTest = useCallback(async () => {
    if (!settings) return;
    setTelegramTesting(true);
    setTelegramTestResult(null);
    try {
      if (!settings.telegramBotToken) {
        setTelegramTestResult(s.telegram_test_fail);
        toast('error', s.telegram_test_fail);
      } else {
        const result = await api.telegramTestConnection(settings.telegramBotToken);
        if (result.success) {
          setTelegramTestResult(`${s.telegram_test_ok} (@${result.username})`);
          toast('success', s.telegram_test_ok, `@${result.username}`);
        } else {
          setTelegramTestResult(`${s.telegram_test_fail}: ${result.error || ''}`);
          toast('error', s.telegram_test_fail, result.error);
        }
      }
    } catch (err: any) {
      setTelegramTestResult(s.telegram_test_fail);
      toast('error', s.telegram_test_fail, err?.message);
    }
    setTelegramTesting(false);
  }, [api, settings, s, toast]);

  const handleTelegramRestart = useCallback(async () => {
    if (!settings) return;
    await api.updateSettings({
      telegramBotToken: settings.telegramBotToken,
      telegramChatId: settings.telegramChatId,
      telegramEnabled: settings.telegramEnabled,
    });
    toast('success', s.telegram_save_restart);
  }, [api, settings, s, toast]);

  const handleEmailTest = useCallback(async () => {
    if (!settings) return;
    setEmailTesting(true);
    setEmailTestResult(null);
    try {
      if (!settings.smtpHost || !settings.smtpUser || !settings.smtpPass) {
        setEmailTestResult(s.email_test_fail);
        toast('error', s.email_test_fail);
      } else {
        await api.updateSettings({
          smtpHost: settings.smtpHost,
          smtpPort: settings.smtpPort,
          smtpUser: settings.smtpUser,
          smtpPass: settings.smtpPass,
          smtpFromName: settings.smtpFromName,
          emailEnabled: settings.emailEnabled,
        });
        const result = await api.emailTestConnection(
          settings.smtpHost,
          settings.smtpPort || 587,
          settings.smtpUser,
          settings.smtpPass,
        );
        if (result.success) {
          setEmailTestResult(s.email_test_ok);
          toast('success', s.email_test_ok);
        } else {
          setEmailTestResult(s.email_test_fail);
          toast('error', s.email_test_fail, result.error);
        }
      }
    } catch (err: any) {
      setEmailTestResult(s.email_test_fail);
      toast('error', s.email_test_fail, err?.message);
    }
    setEmailTesting(false);
  }, [api, settings, s, toast]);

  // ─── OpenClaw WeChat handlers ────────────────────────────────
  const handleOpenclawWechatScan = useCallback(async () => {
    setOpenclawWechatScanning(true);
    setOpenclawWechatQrImage(null);
    setOpenclawWechatTestResult(null);
    try {
      console.log('[OpenClawWechat] Requesting QR code...');
      const result = await api.openclawWechatGetQRCode();
      console.log('[OpenClawWechat] QR code result:', {
        qrcodeId: result.qrcodeId ? 'present' : 'missing',
        qrcodeImage: result.qrcodeImage ? `${result.qrcodeImage.length} chars` : 'missing',
      });
      const { qrcodeId, qrcodeImage } = result;
      setOpenclawWechatQrImage(qrcodeImage);

      // Poll for scan status
      const pollInterval = setInterval(async () => {
        try {
          const status = await api.openclawWechatGetQRCodeStatus(qrcodeId);
          if (status.status === 'confirmed') {
            clearInterval(pollInterval);
            setOpenclawWechatScanning(false);
            setOpenclawWechatQrImage(null);
            setOpenclawWechatStatus('connected');
            toast('success', s.openclaw_wechat_test_ok);
          } else if (status.status === 'expired') {
            clearInterval(pollInterval);
            setOpenclawWechatScanning(false);
            setOpenclawWechatQrImage(null);
            toast('error', s.openclaw_wechat_test_fail);
          }
        } catch {
          clearInterval(pollInterval);
          setOpenclawWechatScanning(false);
          setOpenclawWechatQrImage(null);
        }
      }, 2000);

      // Auto-cancel after 120s
      setTimeout(() => {
        clearInterval(pollInterval);
        setOpenclawWechatScanning(false);
        setOpenclawWechatQrImage(null);
      }, 120000);
    } catch (err: any) {
      setOpenclawWechatScanning(false);
      toast('error', s.openclaw_wechat_test_fail, err?.message);
    }
  }, [api, s, toast]);

  const handleOpenclawWechatLogout = useCallback(async () => {
    try {
      await api.openclawWechatLogout();
      setOpenclawWechatStatus('disconnected');
      setOpenclawWechatTestResult(null);
      toast('success', s.openclaw_wechat_disconnected);
    } catch {}
  }, [api, s, toast]);

  const handleOpenclawWechatTest = useCallback(async () => {
    setOpenclawWechatTestResult(null);
    try {
      const result = await api.openclawWechatTestConnection();
      if (result.success) {
        setOpenclawWechatTestResult(s.openclaw_wechat_test_ok);
        toast('success', s.openclaw_wechat_test_ok);
      } else {
        setOpenclawWechatTestResult(result.error || s.openclaw_wechat_test_fail);
        toast('error', s.openclaw_wechat_test_fail, result.error);
      }
    } catch (err: any) {
      setOpenclawWechatTestResult(s.openclaw_wechat_test_fail);
      toast('error', s.openclaw_wechat_test_fail, err?.message);
    }
  }, [api, s, toast]);

  // ─── Sync handlers ───────────────────────────────────────────
  const handleSyncEnable = useCallback(async () => {
    const dir = await api.selectDirectory();
    if (!dir) return;
    setSyncLoading(true);
    const result = await api.syncEnable(dir);
    if (result.success) {
      toast('success', s.sync_enabled);
      api.syncGetStatus().then(setSyncStatus);
    } else {
      toast('error', s.sync_enable_fail, result.error);
    }
    setSyncLoading(false);
  }, [api, s, toast]);

  const handleSyncDisable = useCallback(async () => {
    setSyncLoading(true);
    const result = await api.syncDisable();
    if (result.success) {
      toast('success', s.sync_disabled);
      api.syncGetStatus().then(setSyncStatus);
    } else {
      toast('error', s.sync_disable_fail, result.error);
    }
    setSyncLoading(false);
  }, [api, s, toast]);

  const handleSyncAcquireLock = useCallback(async () => {
    const result = await api.syncTryAcquireLock();
    if (result.acquired) {
      toast('success', s.sync_acquired);
      api.syncGetStatus().then(setSyncStatus);
    } else {
      toast('error', s.sync_acquire_fail);
    }
  }, [api, s, toast]);

  // ─── Loading state ───────────────────────────────────────────
  if (!settings) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="kz-text-mute kz-mono text-sm">{t.common.loading}</div>
      </div>
    );
  }

  // ─── Render ──────────────────────────────────────────────────
  return (
    <div className="space-y-6">
      {saved && (
        <div style={{ position: 'fixed', bottom: 24, right: 24, zIndex: 9999 }}>
          <StatusBadge status="ok" label="auto-saved" />
        </div>
      )}

      <OutputSection
        settings={settings}
        s={s}
        updateField={updateField}
        onDirChange={handleDirChange}
        onOpenExternal={handleOpenExternal}
        obsidianSyncing={obsidianSyncing}
        obsidianSyncResult={obsidianSyncResult}
        onObsidianSync={handleObsidianSync}
        feishuStatus={feishuStatus}
        feishuTesting={feishuTesting}
        feishuTestResult={feishuTestResult}
        onFeishuTest={handleFeishuTest}
        onFeishuRestart={handleFeishuRestart}
        wechatTesting={wechatTesting}
        wechatTestResult={wechatTestResult}
        onWechatTest={handleWechatTest}
        onWechatRestart={handleWechatRestart}
        telegramTesting={telegramTesting}
        telegramTestResult={telegramTestResult}
        onTelegramTest={handleTelegramTest}
        onTelegramRestart={handleTelegramRestart}
        openclawWechatStatus={openclawWechatStatus}
        openclawWechatScanning={openclawWechatScanning}
        openclawWechatQrImage={openclawWechatQrImage}
        openclawWechatTestResult={openclawWechatTestResult}
        onOpenclawWechatScan={handleOpenclawWechatScan}
        onOpenclawWechatLogout={handleOpenclawWechatLogout}
        onOpenclawWechatTest={handleOpenclawWechatTest}
        emailTesting={emailTesting}
        emailTestResult={emailTestResult}
        onEmailTest={handleEmailTest}
      />

      {/* ── Device Sync ── */}
      <CollapsibleCard title={s.nav_sync} icon={Cloud}>
        <FieldRow label={s.sync_enable} hint={s.sync_enable_desc}>
          <ToggleSwitch
            checked={syncStatus?.enabled || false}
            disabled={syncLoading}
            onChange={(checked) => { if (checked) handleSyncEnable(); else handleSyncDisable(); }}
          />
        </FieldRow>

        {syncStatus?.enabled && (
          <div className="space-y-3 pt-2 border-t border-neutral-100">
            <FieldRow label={s.sync_dir}>
              <span className="text-sm kz-text-ink kz-mono truncate max-w-[300px]">{syncStatus.syncDir}</span>
            </FieldRow>
            <FieldRow label={s.sync_machine_id}>
              <span className="text-sm kz-text-ink kz-mono">{syncStatus.machineId}</span>
            </FieldRow>
            <div className="flex items-center justify-between">
              <span className="text-sm kz-text-soft">
                {syncStatus.readOnly ? s.sync_status_ro : s.sync_status_rw}
              </span>
              <span className={`kz-badge ${syncStatus.readOnly ? 'kz-badge--warn' : 'kz-badge--success'}`}>
                {syncStatus.readOnly ? 'READ-ONLY' : 'READ-WRITE'}
              </span>
            </div>
            {syncStatus.readOnly && syncStatus.lockHolder && (
              <div className="flex items-center justify-between">
                <span className="text-xs kz-mono kz-text-accent">
                  {s.sync_locked_by}: {syncStatus.lockHolder.hostname}
                </span>
                <button onClick={handleSyncAcquireLock} className="kz-btn kz-btn--sm">
                  {s.sync_try_acquire}
                </button>
              </div>
            )}
          </div>
        )}

        {!syncStatus?.enabled && (
          <div className="text-[11px] kz-text-mute kz-serif-italic">{s.sync_dir_hint}</div>
        )}
      </CollapsibleCard>
    </div>
  );
}
