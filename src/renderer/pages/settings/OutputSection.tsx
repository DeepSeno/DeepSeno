import { useState } from 'react';
import {
  BookOpen,
  MessageSquare,
  ExternalLink,
  RefreshCw,
  ChevronDown,
  ChevronRight,
  Smartphone,
  Mail,
} from 'lucide-react';
import { CollapsibleCard, FieldRow, ToggleSwitch } from '../../components/settings';
import type { AppSettings } from '../../hooks/useApi';
import MobileSync from '../../components/MobileSync';

interface OutputSectionProps {
  settings: AppSettings;
  s: any;
  updateField: (partial: Partial<AppSettings>) => void;
  onDirChange: (field: 'obsidianVaultDir') => void;
  onOpenExternal: (path: string) => void;
  // Obsidian
  obsidianSyncing: boolean;
  obsidianSyncResult: string | null;
  onObsidianSync: () => void;
  // Feishu
  feishuStatus: string;
  feishuTesting: boolean;
  feishuTestResult: string | null;
  onFeishuTest: () => void;
  onFeishuRestart: () => void;
  // WeChat
  wechatTesting: boolean;
  wechatTestResult: string | null;
  onWechatTest: () => void;
  onWechatRestart: () => void;
  // Telegram
  telegramTesting: boolean;
  telegramTestResult: string | null;
  onTelegramTest: () => void;
  onTelegramRestart: () => void;
  // OpenClaw WeChat (Personal)
  openclawWechatStatus: 'connected' | 'authenticated' | 'disconnected';
  openclawWechatScanning: boolean;
  openclawWechatQrImage: string | null;
  openclawWechatTestResult: string | null;
  onOpenclawWechatScan: () => void;
  onOpenclawWechatLogout: () => void;
  onOpenclawWechatTest: () => void;
  // Email
  emailTesting: boolean;
  emailTestResult: string | null;
  onEmailTest: () => void;
}

type ChannelKey = 'feishu' | 'wechat' | 'telegram' | 'dingtalk' | 'openclaw-wechat';

export default function OutputSection({
  settings,
  s,
  updateField,
  onDirChange,
  onOpenExternal,
  obsidianSyncing,
  obsidianSyncResult,
  onObsidianSync,
  feishuStatus,
  feishuTesting,
  feishuTestResult,
  onFeishuTest,
  onFeishuRestart,
  wechatTesting,
  wechatTestResult,
  onWechatTest,
  onWechatRestart,
  telegramTesting,
  telegramTestResult,
  onTelegramTest,
  onTelegramRestart,
  openclawWechatStatus,
  openclawWechatScanning,
  openclawWechatQrImage,
  openclawWechatTestResult,
  onOpenclawWechatScan,
  onOpenclawWechatLogout,
  onOpenclawWechatTest,
  emailTesting,
  emailTestResult,
  onEmailTest,
}: OutputSectionProps) {
  const [expandedChannel, setExpandedChannel] = useState<ChannelKey | null>(null);
  const [showGuide, setShowGuide] = useState<Record<string, boolean>>({});
  const toggleGuide = (key: string) => setShowGuide(prev => ({ ...prev, [key]: !prev[key] }));

  const feishuConfigured = settings.feishuEnabled && !!settings.feishuAppId && !!settings.feishuAppSecret;
  const wechatConfigured = settings.wechatEnabled && !!settings.wechatCorpId && !!settings.wechatSecret;
  const telegramConfigured = settings.telegramEnabled && !!settings.telegramBotToken;
  const dingtalkConfigured = settings.dingtalkEnabled && !!settings.dingtalkAppKey && !!settings.dingtalkAppSecret;
  const openclawWechatConfigured = (settings as any).openclawWechatEnabled && openclawWechatStatus !== 'disconnected';

  const channels: { key: ChannelKey; label: string; enabled: boolean; configured: boolean }[] = [
    { key: 'feishu', label: s.nav_feishu || 'Feishu', enabled: settings.feishuEnabled, configured: feishuConfigured },
    { key: 'wechat', label: s.nav_wechat || 'WeChat', enabled: settings.wechatEnabled, configured: wechatConfigured },
    { key: 'openclaw-wechat', label: s.nav_openclaw_wechat || 'Personal WeChat', enabled: (settings as any).openclawWechatEnabled || false, configured: openclawWechatConfigured },
    { key: 'telegram', label: s.nav_telegram || 'Telegram', enabled: settings.telegramEnabled, configured: telegramConfigured },
    { key: 'dingtalk', label: s.nav_dingtalk || 'DingTalk', enabled: settings.dingtalkEnabled, configured: dingtalkConfigured },
  ];

  return (
    <div className="space-y-4">

      {/* ── Messaging Channels ── */}
      <CollapsibleCard title={s.messaging_channels} icon={MessageSquare}>
        {/* Compact channel list with inline accordion detail forms */}
        <div className="kz-card overflow-hidden">
            {channels.map((ch, idx) => {
              const isActive = ch.enabled && ch.configured;
              const isExpanded = expandedChannel === ch.key;
              const statusLabel = ch.enabled
                ? (isActive ? s.channel_status_enabled : s.channel_status_no_config)
                : s.channel_status_disabled;
              return (
                <div
                  key={ch.key}
                  style={idx > 0 ? { borderTop: '1px solid var(--line-soft)' } : undefined}
                >
                  <button
                    type="button"
                    onClick={() => setExpandedChannel(isExpanded ? null : ch.key)}
                    className={`kz-row-hover w-full flex items-center justify-between px-3 py-2.5 text-left ${
                      isExpanded ? 'kz-row-selected' : ''
                    }`}
                  >
                    <span className="text-[13px] kz-text-ink">{ch.label}</span>
                    <div className="flex items-center gap-2.5">
                      <span className={`kz-badge ${isActive ? 'kz-badge--success' : 'kz-badge--mute'}`}>
                        <span className={`kz-sdot ${isActive ? 'kz-sdot--success' : 'kz-sdot--mute'}`} />
                        {statusLabel}
                      </span>
                      {isExpanded
                        ? <ChevronDown size={13} className="kz-text-mute" />
                        : <ChevronRight size={13} className="kz-text-mute" />}
                    </div>
                  </button>

                  {/* Inline detail form */}
                  {isExpanded && (
                    <div className="px-3 pb-4 pt-3 space-y-3" style={{ background: 'var(--bg-elev)', borderTop: '1px solid var(--line-soft)' }}>

                      {/* Feishu */}
                      {ch.key === 'feishu' && (<>
                        {/* Setup Guide */}
                        <div className="mb-2">
                          <button
                            type="button"
                            onClick={() => toggleGuide('feishu')}
                            className="flex items-center gap-1.5 text-[11px] kz-mono kz-text-accent hover:opacity-80 transition-opacity"
                          >
                            <BookOpen size={12} />
                            {showGuide.feishu ? s.channel_guide_hide : s.channel_guide_title}
                            <ChevronDown size={11} className={`transition-transform ${showGuide.feishu ? 'rotate-0' : '-rotate-90'}`} />
                          </button>
                          {showGuide.feishu && (
                            <ol className="mt-2 ml-4 space-y-1.5 text-[11px] kz-text-soft list-decimal list-outside">
                              {(s.feishu_guide as unknown as string[]).map((step: string, i: number) => (
                                <li key={i} className="pl-1">{step}</li>
                              ))}
                            </ol>
                          )}
                        </div>
                        <div className="flex items-center justify-between">
                          <span className="text-xs kz-text-soft kz-serif-italic">{s.feishu_status}</span>
                          <span className={`kz-badge ${
                            feishuStatus === 'connected' ? 'kz-badge--success' : feishuStatus === 'error' ? 'kz-badge--danger' : 'kz-badge--mute'
                          }`}>
                            <span className={`kz-sdot ${
                              feishuStatus === 'connected' ? 'kz-sdot--success' : feishuStatus === 'error' ? 'kz-sdot--danger' : 'kz-sdot--mute'
                            }`} />
                            {feishuStatus === 'connected' ? s.feishu_connected
                              : feishuStatus === 'connecting' ? s.feishu_connecting
                              : feishuStatus === 'error' ? s.feishu_error
                              : s.feishu_disconnected}
                          </span>
                        </div>
                        <FieldRow label={s.feishu_enable} hint={s.feishu_enable_desc}>
                          <ToggleSwitch checked={settings.feishuEnabled} onChange={(checked) => updateField({ feishuEnabled: checked })} />
                        </FieldRow>
                        <FieldRow label={s.feishu_app_id}>
                          <input type="text" value={settings.feishuAppId} onChange={(e) => updateField({ feishuAppId: e.target.value })} placeholder="cli_xxxxxxxxxx" className="kz-input kz-mono max-w-[280px] w-full" />
                        </FieldRow>
                        <FieldRow label={s.feishu_app_secret}>
                          <input type="password" value={settings.feishuAppSecret} onChange={(e) => updateField({ feishuAppSecret: e.target.value })} placeholder="xxxxxxxxxxxxxxxx" className="kz-input kz-mono max-w-[280px] w-full" />
                        </FieldRow>
                        <FieldRow label={s.feishu_admin_id}>
                          <input type="text" value={settings.feishuAdminOpenId} onChange={(e) => updateField({ feishuAdminOpenId: e.target.value })} placeholder="ou_xxxxxxxxxx" className="kz-input kz-mono max-w-[280px] w-full" />
                        </FieldRow>
                        <FieldRow label={s.feishu_notify_complete} hint={s.feishu_notify_complete_desc}>
                          <ToggleSwitch checked={settings.feishuNotifyOnComplete} onChange={(checked) => updateField({ feishuNotifyOnComplete: checked })} />
                        </FieldRow>
                        <FieldRow label={s.feishu_notify_daily} hint={s.feishu_notify_daily_desc}>
                          <ToggleSwitch checked={settings.feishuNotifyDailyDigest} onChange={(checked) => updateField({ feishuNotifyDailyDigest: checked })} />
                        </FieldRow>
                        <div className="flex items-center gap-2 pt-1">
                          <button onClick={onFeishuTest} disabled={feishuTesting || !settings.feishuAppId || !settings.feishuAppSecret}
                            className={`kz-btn kz-btn--sm ${feishuTesting || !settings.feishuAppId || !settings.feishuAppSecret ? 'opacity-40 cursor-not-allowed' : ''}`}>
                            <RefreshCw size={12} className={feishuTesting ? 'animate-spin' : ''} />
                            {feishuTesting ? s.feishu_testing : s.feishu_test}
                          </button>
                          <button onClick={onFeishuRestart} disabled={!settings.feishuEnabled || !settings.feishuAppId || !settings.feishuAppSecret}
                            className={`kz-btn kz-btn--sm ${!settings.feishuEnabled || !settings.feishuAppId || !settings.feishuAppSecret ? 'opacity-40 cursor-not-allowed' : ''}`}>
                            {s.feishu_save_restart}
                          </button>
                          {feishuTestResult && (
                            <span className={`kz-badge ${feishuTestResult === s.feishu_test_ok ? 'kz-badge--success' : 'kz-badge--danger'}`}>{feishuTestResult}</span>
                          )}
                        </div>
                        <div className="text-[11px] kz-text-mute kz-serif-italic">{s.feishu_hint}</div>
                      </>)}

                      {/* WeChat Work */}
                      {ch.key === 'wechat' && (<>
                        {/* Setup Guide */}
                        <div className="mb-2">
                          <button
                            type="button"
                            onClick={() => toggleGuide('wechat')}
                            className="flex items-center gap-1.5 text-[11px] kz-mono kz-text-accent hover:opacity-80 transition-opacity"
                          >
                            <BookOpen size={12} />
                            {showGuide.wechat ? s.channel_guide_hide : s.channel_guide_title}
                            <ChevronDown size={11} className={`transition-transform ${showGuide.wechat ? 'rotate-0' : '-rotate-90'}`} />
                          </button>
                          {showGuide.wechat && (
                            <ol className="mt-2 ml-4 space-y-1.5 text-[11px] kz-text-soft list-decimal list-outside">
                              {(s.wechat_guide as unknown as string[]).map((step: string, i: number) => (
                                <li key={i} className="pl-1">{step}</li>
                              ))}
                            </ol>
                          )}
                        </div>
                        <div className="flex items-center justify-between">
                          <span className="text-xs kz-text-soft kz-serif-italic">{s.wechat_status}</span>
                          <span className={`kz-badge ${wechatConfigured ? 'kz-badge--success' : 'kz-badge--mute'}`}>
                            <span className={`kz-sdot ${wechatConfigured ? 'kz-sdot--success' : 'kz-sdot--mute'}`} />
                            {wechatConfigured ? s.wechat_connected : s.wechat_disconnected}
                          </span>
                        </div>
                        <FieldRow label={s.wechat_enable} hint={s.wechat_enable_desc}>
                          <ToggleSwitch checked={settings.wechatEnabled} onChange={(checked) => updateField({ wechatEnabled: checked })} />
                        </FieldRow>
                        <FieldRow label={s.wechat_corp_id}>
                          <input type="text" value={settings.wechatCorpId} onChange={(e) => updateField({ wechatCorpId: e.target.value })} placeholder="ww_xxxxxxxxxx" className="kz-input kz-mono max-w-[280px] w-full" />
                        </FieldRow>
                        <FieldRow label={s.wechat_agent_id}>
                          <input type="text" value={settings.wechatAgentId} onChange={(e) => updateField({ wechatAgentId: e.target.value })} placeholder="1000002" className="kz-input kz-mono max-w-[280px] w-full" />
                        </FieldRow>
                        <FieldRow label={s.wechat_secret}>
                          <input type="password" value={settings.wechatSecret} onChange={(e) => updateField({ wechatSecret: e.target.value })} placeholder="xxxxxxxxxxxxxxxx" className="kz-input kz-mono max-w-[280px] w-full" />
                        </FieldRow>
                        <FieldRow label={s.wechat_token}>
                          <input type="text" value={settings.wechatToken} onChange={(e) => updateField({ wechatToken: e.target.value })} placeholder="your_token" className="kz-input kz-mono max-w-[280px] w-full" />
                        </FieldRow>
                        <FieldRow label={s.wechat_encoding_key}>
                          <input type="password" value={settings.wechatEncodingAESKey} onChange={(e) => updateField({ wechatEncodingAESKey: e.target.value })} placeholder="43-char encoding key" className="kz-input kz-mono max-w-[280px] w-full" />
                        </FieldRow>
                        <div className="flex items-center gap-2 pt-1">
                          <button onClick={onWechatTest} disabled={wechatTesting || !settings.wechatCorpId || !settings.wechatAgentId || !settings.wechatSecret}
                            className={`kz-btn kz-btn--sm ${wechatTesting || !settings.wechatCorpId || !settings.wechatAgentId || !settings.wechatSecret ? 'opacity-40 cursor-not-allowed' : ''}`}>
                            <RefreshCw size={12} className={wechatTesting ? 'animate-spin' : ''} />
                            {wechatTesting ? s.wechat_testing : s.wechat_test}
                          </button>
                          <button onClick={onWechatRestart} disabled={!settings.wechatEnabled || !settings.wechatCorpId || !settings.wechatSecret}
                            className={`kz-btn kz-btn--sm ${!settings.wechatEnabled || !settings.wechatCorpId || !settings.wechatSecret ? 'opacity-40 cursor-not-allowed' : ''}`}>
                            {s.wechat_save_restart}
                          </button>
                          {wechatTestResult && (
                            <span className={`kz-badge ${wechatTestResult === s.wechat_test_ok ? 'kz-badge--success' : 'kz-badge--danger'}`}>{wechatTestResult}</span>
                          )}
                        </div>
                        <div className="text-[11px] kz-text-mute kz-serif-italic">{s.wechat_hint}</div>
                      </>)}

                      {/* OpenClaw WeChat (Personal) */}
                      {ch.key === 'openclaw-wechat' && (<>
                        {/* Setup Guide */}
                        <div className="mb-2">
                          <button
                            type="button"
                            onClick={() => toggleGuide('openclaw-wechat')}
                            className="flex items-center gap-1.5 text-[11px] kz-mono kz-text-accent hover:opacity-80 transition-opacity"
                          >
                            <BookOpen size={12} />
                            {showGuide['openclaw-wechat'] ? s.channel_guide_hide : s.channel_guide_title}
                            <ChevronDown size={11} className={`transition-transform ${showGuide['openclaw-wechat'] ? 'rotate-0' : '-rotate-90'}`} />
                          </button>
                          {showGuide['openclaw-wechat'] && (
                            <ol className="mt-2 ml-4 space-y-1.5 text-[11px] kz-text-soft list-decimal list-outside">
                              {(s.openclaw_wechat_guide as unknown as string[]).map((step: string, i: number) => (
                                <li key={i} className="pl-1">{step}</li>
                              ))}
                            </ol>
                          )}
                        </div>
                        <div className="flex items-center justify-between">
                          <span className="text-xs kz-text-soft kz-serif-italic">{s.openclaw_wechat_status}</span>
                          <span className={`kz-badge ${
                            openclawWechatStatus === 'connected' ? 'kz-badge--success'
                            : openclawWechatStatus === 'authenticated' ? 'kz-badge--warn'
                            : 'kz-badge--mute'
                          }`}>
                            <span className={`kz-sdot ${
                              openclawWechatStatus === 'connected' ? 'kz-sdot--success'
                              : openclawWechatStatus === 'authenticated' ? 'kz-sdot--warn'
                              : 'kz-sdot--mute'
                            }`} />
                            {openclawWechatStatus === 'connected' ? s.openclaw_wechat_connected
                              : openclawWechatStatus === 'authenticated' ? s.openclaw_wechat_authenticated
                              : s.openclaw_wechat_disconnected}
                          </span>
                        </div>
                        <FieldRow label={s.openclaw_wechat_enable} hint={s.openclaw_wechat_enable_desc}>
                          <ToggleSwitch checked={(settings as any).openclawWechatEnabled || false} onChange={(checked) => updateField({ openclawWechatEnabled: checked } as any)} />
                        </FieldRow>
                        {/* QR Code display */}
                        {openclawWechatQrImage && (
                          <div className="kz-paper flex flex-col items-center gap-3 py-5 px-4">
                            <div className="p-3" style={{ background: 'var(--bg)', border: '1px solid var(--line)', borderRadius: '10px' }}>
                              <img
                                src={openclawWechatQrImage.startsWith('data:') ? openclawWechatQrImage
                                  : openclawWechatQrImage.startsWith('http') ? openclawWechatQrImage
                                  : `data:image/png;base64,${openclawWechatQrImage}`}
                                alt="WeChat QR Code"
                                className="w-48 h-48 block"
                              />
                            </div>
                            <span className="text-[11px] kz-text-mute kz-serif-italic">{s.openclaw_wechat_scanning}</span>
                          </div>
                        )}
                        <div className="flex items-center gap-2 pt-1">
                          {openclawWechatStatus === 'disconnected' ? (
                            <button onClick={onOpenclawWechatScan} disabled={openclawWechatScanning}
                              className={`kz-btn kz-btn--sm ${openclawWechatScanning ? 'opacity-40 cursor-not-allowed' : ''}`}>
                              <RefreshCw size={12} className={openclawWechatScanning ? 'animate-spin' : ''} />
                              {openclawWechatScanning ? s.openclaw_wechat_scanning : s.openclaw_wechat_scan}
                            </button>
                          ) : (
                            <>
                              <button onClick={onOpenclawWechatTest} className="kz-btn kz-btn--sm">
                                <RefreshCw size={12} />
                                {s.openclaw_wechat_test}
                              </button>
                              <button onClick={onOpenclawWechatLogout} className="kz-btn kz-btn--sm kz-btn--danger">
                                {s.openclaw_wechat_logout}
                              </button>
                            </>
                          )}
                          {openclawWechatTestResult && (
                            <span className={`kz-badge ${openclawWechatTestResult === s.openclaw_wechat_test_ok ? 'kz-badge--success' : 'kz-badge--danger'}`}>{openclawWechatTestResult}</span>
                          )}
                        </div>
                        <div className="text-[11px] kz-text-mute kz-serif-italic">{s.openclaw_wechat_hint}</div>
                        <div className="text-[11px] kz-text-mute kz-serif-italic">{s.openclaw_wechat_poll_hint}</div>
                      </>)}

                      {/* Telegram */}
                      {ch.key === 'telegram' && (<>
                        {/* Setup Guide */}
                        <div className="mb-2">
                          <button
                            type="button"
                            onClick={() => toggleGuide('telegram')}
                            className="flex items-center gap-1.5 text-[11px] kz-mono kz-text-accent hover:opacity-80 transition-opacity"
                          >
                            <BookOpen size={12} />
                            {showGuide.telegram ? s.channel_guide_hide : s.channel_guide_title}
                            <ChevronDown size={11} className={`transition-transform ${showGuide.telegram ? 'rotate-0' : '-rotate-90'}`} />
                          </button>
                          {showGuide.telegram && (
                            <ol className="mt-2 ml-4 space-y-1.5 text-[11px] kz-text-soft list-decimal list-outside">
                              {(s.telegram_guide as unknown as string[]).map((step: string, i: number) => (
                                <li key={i} className="pl-1">{step}</li>
                              ))}
                            </ol>
                          )}
                        </div>
                        <div className="flex items-center justify-between">
                          <span className="text-xs kz-text-soft kz-serif-italic">{s.telegram_status}</span>
                          <span className={`kz-badge ${telegramConfigured ? 'kz-badge--success' : 'kz-badge--mute'}`}>
                            <span className={`kz-sdot ${telegramConfigured ? 'kz-sdot--success' : 'kz-sdot--mute'}`} />
                            {telegramConfigured ? s.telegram_connected : s.telegram_disconnected}
                          </span>
                        </div>
                        <FieldRow label={s.telegram_enable} hint={s.telegram_enable_desc}>
                          <ToggleSwitch checked={settings.telegramEnabled} onChange={(checked) => updateField({ telegramEnabled: checked })} />
                        </FieldRow>
                        <FieldRow label={s.telegram_bot_token}>
                          <input type="password" value={settings.telegramBotToken} onChange={(e) => updateField({ telegramBotToken: e.target.value })} placeholder="123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11" className="kz-input kz-mono max-w-[280px] w-full" />
                        </FieldRow>
                        <FieldRow label={s.telegram_chat_id}>
                          <input type="text" value={settings.telegramChatId} onChange={(e) => updateField({ telegramChatId: e.target.value })} placeholder="-1001234567890" className="kz-input kz-mono max-w-[280px] w-full" />
                        </FieldRow>
                        <div className="flex items-center gap-2 pt-1">
                          <button onClick={onTelegramTest} disabled={telegramTesting || !settings.telegramBotToken}
                            className={`kz-btn kz-btn--sm ${telegramTesting || !settings.telegramBotToken ? 'opacity-40 cursor-not-allowed' : ''}`}>
                            <RefreshCw size={12} className={telegramTesting ? 'animate-spin' : ''} />
                            {telegramTesting ? s.telegram_testing : s.telegram_test}
                          </button>
                          <button onClick={onTelegramRestart} disabled={!settings.telegramEnabled || !settings.telegramBotToken}
                            className={`kz-btn kz-btn--sm ${!settings.telegramEnabled || !settings.telegramBotToken ? 'opacity-40 cursor-not-allowed' : ''}`}>
                            {s.telegram_save_restart}
                          </button>
                          {telegramTestResult && (
                            <span className={`kz-badge ${telegramTestResult.startsWith(s.telegram_test_ok) ? 'kz-badge--success' : 'kz-badge--danger'}`}>{telegramTestResult}</span>
                          )}
                        </div>
                        <div className="text-[11px] kz-text-mute kz-serif-italic">{s.telegram_hint}</div>
                        <div className="text-[11px] kz-text-mute kz-serif-italic">{s.telegram_long_poll_hint}</div>
                      </>)}

                      {/* DingTalk */}
                      {ch.key === 'dingtalk' && (<>
                        {/* Setup Guide */}
                        <div className="mb-2">
                          <button
                            type="button"
                            onClick={() => toggleGuide('dingtalk')}
                            className="flex items-center gap-1.5 text-[11px] kz-mono kz-text-accent hover:opacity-80 transition-opacity"
                          >
                            <BookOpen size={12} />
                            {showGuide.dingtalk ? s.channel_guide_hide : s.channel_guide_title}
                            <ChevronDown size={11} className={`transition-transform ${showGuide.dingtalk ? 'rotate-0' : '-rotate-90'}`} />
                          </button>
                          {showGuide.dingtalk && (
                            <ol className="mt-2 ml-4 space-y-1.5 text-[11px] kz-text-soft list-decimal list-outside">
                              {(s.dingtalk_guide as unknown as string[]).map((step: string, i: number) => (
                                <li key={i} className="pl-1">{step}</li>
                              ))}
                            </ol>
                          )}
                        </div>
                        <FieldRow label={s.dingtalk_enable}>
                          <ToggleSwitch checked={settings.dingtalkEnabled} onChange={(checked) => updateField({ dingtalkEnabled: checked })} />
                        </FieldRow>
                        <FieldRow label={s.dingtalk_app_key}>
                          <input type="text" value={settings.dingtalkAppKey} onChange={(e) => updateField({ dingtalkAppKey: e.target.value })} placeholder="dingxxxxxxxx" className="kz-input kz-mono max-w-[280px] w-full" />
                        </FieldRow>
                        <FieldRow label={s.dingtalk_app_secret}>
                          <input type="password" value={settings.dingtalkAppSecret} onChange={(e) => updateField({ dingtalkAppSecret: e.target.value })} placeholder="xxxxxxxxxxxxxxxx" className="kz-input kz-mono max-w-[280px] w-full" />
                        </FieldRow>
                        <FieldRow label={s.dingtalk_robot_code}>
                          <input type="text" value={settings.dingtalkRobotCode} onChange={(e) => updateField({ dingtalkRobotCode: e.target.value })} placeholder="dingxxxxxxxx" className="kz-input kz-mono max-w-[280px] w-full" />
                        </FieldRow>
                        <div className="text-[11px] kz-text-mute kz-serif-italic">{s.dingtalk_hint}</div>
                      </>)}

                    </div>
                  )}
                </div>
              );
            })}
        </div>

        {/* Auto-push rules (merged from standalone Workflow card) */}
        <div className="pt-4 mt-4" style={{ borderTop: '1px solid var(--line-soft)' }}>
          <h3 className="kz-section-title">
            <span>{s.auto_push_title}</span>
          </h3>
          <FieldRow label={s.workflow_todo_push} hint={s.workflow_todo_push_desc}>
            <ToggleSwitch checked={settings.workflowTodoPush !== false} onChange={(checked) => updateField({ workflowTodoPush: checked })} />
          </FieldRow>
          <FieldRow label={s.workflow_decision_push} hint={s.workflow_decision_push_desc}>
            <ToggleSwitch checked={settings.workflowDecisionPush !== false} onChange={(checked) => updateField({ workflowDecisionPush: checked })} />
          </FieldRow>
          <FieldRow label={s.workflow_urgent_push} hint={s.workflow_urgent_push_desc}>
            <ToggleSwitch checked={settings.workflowUrgentPush !== false} onChange={(checked) => updateField({ workflowUrgentPush: checked })} />
          </FieldRow>
        </div>
      </CollapsibleCard>

      {/* ── Mobile Companion ── */}
      <CollapsibleCard title={s.mobile_companion} icon={Smartphone}>
        <MobileSync />
      </CollapsibleCard>

      {/* ── Email (SMTP) ── */}
      <CollapsibleCard title={s.email_title || 'Email (SMTP)'} icon={Mail}>
        <FieldRow label={s.email_enable} hint={s.email_enable_desc}>
          <ToggleSwitch checked={settings.emailEnabled} onChange={(checked) => updateField({ emailEnabled: checked })} />
        </FieldRow>
        {/* Setup Guide */}
        <div className="mb-2">
          <button
            type="button"
            onClick={() => toggleGuide('email')}
            className="flex items-center gap-1.5 text-[11px] kz-mono kz-text-accent hover:opacity-80 transition-opacity"
          >
            <BookOpen size={12} />
            {showGuide.email ? s.channel_guide_hide : s.channel_guide_title}
            <ChevronDown size={11} className={`transition-transform ${showGuide.email ? 'rotate-0' : '-rotate-90'}`} />
          </button>
          {showGuide.email && (
            <ol className="mt-2 ml-4 space-y-1.5 text-[11px] kz-text-soft list-decimal list-outside">
              {(s.email_guide as unknown as string[]).map((step: string, i: number) => (
                <li key={i} className="pl-1">{step}</li>
              ))}
            </ol>
          )}
        </div>
        <FieldRow label={s.email_smtp_host}>
          <input type="text" value={settings.smtpHost} onChange={(e) => updateField({ smtpHost: e.target.value })} placeholder="smtp.example.com" className="kz-input kz-mono max-w-[280px] w-full" />
        </FieldRow>
        <FieldRow label={s.email_smtp_port}>
          <input type="number" value={settings.smtpPort} onChange={(e) => updateField({ smtpPort: parseInt(e.target.value) || 587 })} placeholder="587" className="kz-input kz-mono max-w-[120px] w-full tabular-nums" />
        </FieldRow>
        <FieldRow label={s.email_smtp_user}>
          <input type="text" value={settings.smtpUser} onChange={(e) => updateField({ smtpUser: e.target.value })} placeholder="user@example.com" className="kz-input kz-mono max-w-[280px] w-full" />
        </FieldRow>
        <FieldRow label={s.email_smtp_pass}>
          <input type="password" value={settings.smtpPass} onChange={(e) => updateField({ smtpPass: e.target.value })} placeholder="••••••••" className="kz-input kz-mono max-w-[280px] w-full" />
        </FieldRow>
        <FieldRow label={s.email_from_name}>
          <input type="text" value={settings.smtpFromName} onChange={(e) => updateField({ smtpFromName: e.target.value })} placeholder="DeepSeno" className="kz-input kz-mono max-w-[280px] w-full" />
        </FieldRow>
        <div className="flex items-center gap-2 pt-3 mt-2" style={{ borderTop: '1px solid var(--line-soft)' }}>
          <button onClick={onEmailTest} disabled={emailTesting || !settings.smtpHost || !settings.smtpUser || !settings.smtpPass}
            className={`kz-btn kz-btn--sm ${emailTesting || !settings.smtpHost || !settings.smtpUser || !settings.smtpPass ? 'opacity-40 cursor-not-allowed' : ''}`}>
            <RefreshCw size={12} className={emailTesting ? 'animate-spin' : ''} />
            {emailTesting ? s.email_testing : s.email_test}
          </button>
          {emailTestResult && (
            <span className={`kz-badge ${emailTestResult === s.email_test_ok ? 'kz-badge--success' : 'kz-badge--danger'}`}>{emailTestResult}</span>
          )}
        </div>
      </CollapsibleCard>

      {/* ── Obsidian ── */}
      <CollapsibleCard title={s.nav_obsidian || 'Obsidian'} icon={BookOpen}>
        <FieldRow label={s.obsidian_vault}>
          <span className="text-sm kz-text-ink kz-mono truncate max-w-[300px]">
            {settings.obsidianVaultDir || s.not_set}
          </span>
          <button onClick={() => onDirChange('obsidianVaultDir')} className="kz-btn kz-btn--sm">
            {s.change}
          </button>
          {settings.obsidianVaultDir && (
            <button
              onClick={() => onOpenExternal(settings.obsidianVaultDir)}
              className="kz-btn kz-btn--ghost kz-btn--sm"
              title={s.open_folder}
            >
              <ExternalLink size={14} />
            </button>
          )}
        </FieldRow>

        <FieldRow label={s.obsidian_auto} hint={s.obsidian_auto_desc}>
          <ToggleSwitch
            checked={settings.obsidianAutoExport}
            onChange={(checked) => updateField({ obsidianAutoExport: checked })}
          />
        </FieldRow>

        <FieldRow label={s.obsidian_wikilinks} hint={s.obsidian_wikilinks_desc}>
          <ToggleSwitch
            checked={settings.obsidianWikilinks}
            onChange={(checked) => updateField({ obsidianWikilinks: checked })}
          />
        </FieldRow>

        <div className="flex items-center gap-2 pt-3 mt-2" style={{ borderTop: '1px solid var(--line-soft)' }}>
          <button
            onClick={onObsidianSync}
            disabled={obsidianSyncing || !settings.obsidianVaultDir}
            className={`kz-btn kz-btn--sm ${
              obsidianSyncing || !settings.obsidianVaultDir ? 'opacity-40 cursor-not-allowed' : ''
            }`}
          >
            <RefreshCw size={12} className={obsidianSyncing ? 'animate-spin' : ''} />
            {obsidianSyncing ? s.obsidian_syncing : s.obsidian_sync}
          </button>
          {obsidianSyncResult && (
            <span className="kz-badge kz-badge--success">{obsidianSyncResult}</span>
          )}
          {!settings.obsidianVaultDir && (
            <span className="text-[11px] kz-mono kz-text-mute kz-serif-italic">{s.obsidian_no_vault}</span>
          )}
        </div>
      </CollapsibleCard>
    </div>
  );
}
