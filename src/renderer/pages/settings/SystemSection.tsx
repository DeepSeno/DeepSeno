import { useState, useEffect, useCallback, useRef } from 'react';
import {
  RefreshCw,
  ExternalLink,
  CheckCircle2,
  Key,
  Download,
} from 'lucide-react';
import type { AppSettings, EnvCheckResult, LicenseStatus } from '../../hooks/useApi';
import { useApi } from '../../hooks/useApi';
import { useI18n } from '../../i18n';
import { useNotifications } from '../../components/NotificationCenter';
import { SITE_BASE_URL } from '../../config';

interface SystemSectionProps {
  settings: AppSettings;
  s: any;
  updateField: (partial: Partial<AppSettings>) => void;
  onOpenExternal: (url: string) => void;
}

// V2.0: python/whisper/pyannote/hfToken removed — sherpa-onnx runs in-process
const ENV_KEYS: (keyof EnvCheckResult)[] = ['ffmpeg', 'local', 'sherpaModels'];

const ENV_LABELS: Record<string, { en: string; zh: string }> = {
  ffmpeg:      { en: 'FFmpeg',       zh: 'FFmpeg' },
  local:      { en: 'LLM Engine',   zh: 'LLM 引擎' },
  sherpaModels:{ en: 'ASR Models',   zh: 'ASR 模型' },
};

function formatBytes(bytes: number) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

// ─── FFmpeg Download Button (inline) ────────────────────
function FFmpegDownloadButton({ s }: { s: any }) {
  const api = useApi();
  const [state, setState] = useState<'idle' | 'downloading' | 'done' | 'error'>('idle');
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const unsubRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    unsubRef.current = api.onFFmpegDownloadProgress((_e: any, data: { completed: number; total: number; stage: string }) => {
      if (data.total > 0) {
        setProgress(Math.round((data.completed / data.total) * 100));
      }
    });
    return () => { unsubRef.current?.(); };
  }, [api]);

  const handleDownload = useCallback(async () => {
    setState('downloading');
    setProgress(0);
    setError(null);
    try {
      const result = await api.downloadFFmpeg();
      if (result.success) {
        setState('done');
      } else {
        setState('error');
        setError(result.error || 'Download failed');
      }
    } catch (err: any) {
      setState('error');
      setError(err.message || 'Download failed');
    }
  }, [api]);

  const handleCancel = useCallback(() => {
    api.cancelFFmpegDownload();
    setState('idle');
    setProgress(0);
  }, [api]);

  if (state === 'done') {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8 }}>
        <CheckCircle2 size={12} style={{ color: 'var(--c-success)' }} />
        <span className="kz-mono" style={{ fontSize: 11.5, color: 'var(--c-success)' }}>
          {s.ffmpeg_download_done || 'FFmpeg ready'}
        </span>
      </div>
    );
  }

  if (state === 'downloading') {
    return (
      <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span className="kz-mono kz-text-mute" style={{ fontSize: 11.5 }}>
            {s.ffmpeg_downloading || 'Downloading FFmpeg...'}
          </span>
          <button
            onClick={handleCancel}
            className="kz-mono"
            style={{ fontSize: 10.5, color: 'var(--ink-mute)', background: 'transparent', border: 0, cursor: 'pointer' }}
          >
            {s.clear_db_cancel || 'Cancel'}
          </button>
        </div>
        <div style={{ width: '100%', height: 4, background: 'var(--bg-elev)', borderRadius: 999, overflow: 'hidden' }}>
          <div
            style={{ height: '100%', width: `${progress}%`, background: 'var(--c-accent)', borderRadius: 999, transition: 'width 0.3s' }}
          />
        </div>
        <div className="kz-mono kz-text-mute" style={{ fontSize: 10, textAlign: 'right' }}>{progress}%</div>
      </div>
    );
  }

  return (
    <div style={{ marginTop: 8 }}>
      <button
        onClick={handleDownload}
        className="kz-btn kz-btn--primary kz-btn--sm"
        style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
      >
        <Download size={12} />
        {s.ffmpeg_download_btn || 'Download FFmpeg'}
      </button>
      {state === 'error' && error && (
        <div className="kz-mono" style={{ fontSize: 11, color: 'var(--c-danger)', marginTop: 4 }}>{error}</div>
      )}
    </div>
  );
}

export default function SystemSection({
  s,
  onOpenExternal,
}: SystemSectionProps) {
  const { lang } = useI18n();
  const api = useApi();
  const { toast } = useNotifications();

  // ─── Environment state (local) ─────────────────────────────
  const [envResult, setEnvResult] = useState<EnvCheckResult | null>(null);
  const [envLoading, setEnvLoading] = useState(false);

  // ─── Data management state (local) ─────────────────────────
  const [dbStats, setDbStats] = useState({ recordingCount: 0, segmentCount: 0, dbSize: 0 });
  const [clearConfirm, setClearConfirm] = useState(false);

  // ─── License state (local) ─────────────────────────────────
  const [licenseStatus, setLicenseStatus] = useState<LicenseStatus | null>(null);
  const [licenseKeyInput, setLicenseKeyInput] = useState('');
  const [licenseActivating, setLicenseActivating] = useState(false);
  const [licenseError, setLicenseError] = useState<string | null>(null);
  const [deactivateConfirm, setDeactivateConfirm] = useState(false);

  // ─── Load on mount ─────────────────────────────────────────
  useEffect(() => {
    api.getDbStats().then(setDbStats);
    api.licenseGetStatus().then(setLicenseStatus).catch(() => {});
  }, []);

  // ─── Callbacks ─────────────────────────────────────────────
  const runEnvCheck = useCallback(async () => {
    setEnvLoading(true);
    try {
      const result = await api.detectEnvironment();
      setEnvResult(result);
    } catch (err) {
      console.error('[Settings] Environment check failed:', err);
    }
    setEnvLoading(false);
  }, [api]);

  const handleClearDb = useCallback(async () => {
    try {
      await api.clearAllData();
      setClearConfirm(false);
      const stats = await api.getDbStats();
      setDbStats(stats);
      toast('success', s.clear_db_yes);
    } catch {
      toast('error', s.clear_db);
    }
  }, [api, s, toast]);

  const handleOpenDataDir = useCallback(async () => {
    try {
      const dir = await api.getDataDir();
      console.log('[SystemSection] getDataDir =>', dir);
      if (dir) await api.openPath(dir);
    } catch (err) {
      console.error('[SystemSection] handleOpenDataDir failed:', err);
    }
  }, [api]);

  const handleLicenseActivate = useCallback(async () => {
    if (!licenseKeyInput.trim()) return;
    setLicenseActivating(true);
    setLicenseError(null);
    try {
      const result = await api.licenseActivate(licenseKeyInput.trim());
      if (result.success) {
        const updated = await api.licenseGetStatus();
        setLicenseStatus(updated);
        setLicenseKeyInput('');
        toast('success', s.license_activated);
      } else {
        setLicenseError(result.error || s.license_error);
      }
    } catch {
      setLicenseError(s.license_error);
    }
    setLicenseActivating(false);
  }, [api, licenseKeyInput, s, toast]);

  const handleLicenseDeactivate = useCallback(async () => {
    await api.licenseDeactivate();
    const updated = await api.licenseGetStatus();
    setLicenseStatus(updated);
    setDeactivateConfirm(false);
    toast('info', s.license_deactivated);
  }, [api, s, toast]);

  // ─── Helpers ────────────────────────────────────────────────
  const envStatusBadge = (status: string, version?: string) => {
    if (status === 'ok') return <span className="kz-badge kz-badge--success kz-badge--dot">{version || 'OK'}</span>;
    if (status === 'error') return <span className="kz-badge kz-badge--danger kz-badge--dot">ERROR</span>;
    return <span className="kz-badge kz-badge--warn kz-badge--dot">MISSING</span>;
  };

  const dbStatItems = [
    { label: s.db_size || 'DB Size', value: formatBytes(dbStats.dbSize) },
    { label: s.recording_count || 'Recordings', value: String(dbStats.recordingCount) },
    { label: s.segment_count || 'Segments', value: String(dbStats.segmentCount) },
  ];

  return (
    <div>
      {/* ── Environment ─────────────────────────────────── */}
      <h3 className="kz-section-title">
        <span>{s.section_environment || 'Environment'}</span>
        <span className="kz-section-title__count">{ENV_KEYS.length}</span>
      </h3>
      <div className="kz-card" style={{ padding: 18, marginBottom: 22 }}>
        <div className="kz-text-mute" style={{ fontSize: 12, marginBottom: 12 }}>
          {s.section_environment_desc || 'Check required runtime dependencies and their status'}
        </div>
        {envResult ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {ENV_KEYS.map((key, i) => {
              const val = envResult[key];
              const label = ENV_LABELS[key]?.[lang === 'zh' ? 'zh' : 'en'] || (key as string);
              const isMissing = val.status !== 'ok';
              return (
                <div
                  key={key}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                    padding: '10px 6px',
                    borderTop: i > 0 ? '1px solid var(--line-soft)' : 0,
                  }}
                >
                  <span
                    className={`kz-sdot ${val.status === 'ok' ? 'kz-sdot--success' : val.status === 'error' ? 'kz-sdot--danger' : 'kz-sdot--warn'}`}
                  />
                  <span style={{ flex: 1, fontSize: 13, color: 'var(--ink)' }}>{label}</span>
                  {envStatusBadge(val.status, val.version)}
                  {key === 'ffmpeg' && isMissing && <FFmpegDownloadButton s={s} />}
                </div>
              );
            })}
          </div>
        ) : (
          <div className="kz-text-mute" style={{ fontSize: 13 }}>
            {envLoading
              ? (s.env_checking || 'Checking...')
              : (s.env_click_check || 'Click below to check environment')}
          </div>
        )}
        <div style={{ marginTop: 14 }}>
          <button
            onClick={runEnvCheck}
            disabled={envLoading}
            className="kz-btn kz-btn--sm"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, opacity: envLoading ? 0.5 : 1 }}
          >
            <RefreshCw size={12} className={envLoading ? 'animate-spin' : ''} />
            {s.recheck || 'Re-detect'}
          </button>
        </div>
      </div>

      {/* ── Data Management ─────────────────────────────── */}
      <h3 className="kz-section-title">
        <span>{s.section_data_management || 'Data Management'}</span>
      </h3>
      <div className="kz-card" style={{ padding: 18, marginBottom: 22 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 14, marginBottom: 16 }}>
          {dbStatItems.map((item) => (
            <div
              key={item.label}
              className="kz-paper"
              style={{
                padding: '20px 22px',
                textAlign: 'center',
                background: 'var(--bg-elev)',
              }}
            >
              <div className="kz-num-display" style={{ fontSize: 32, lineHeight: 1 }}>{item.value}</div>
              <div className="kz-serif-italic kz-text-mute" style={{ fontSize: 12.5, marginTop: 6 }}>{item.label}</div>
            </div>
          ))}
        </div>
        <div className="kz-text-mute" style={{ fontSize: 12, marginBottom: 10 }}>{s.export_desc}</div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button onClick={handleOpenDataDir} className="kz-btn kz-btn--sm">{s.open_data_dir}</button>
          <button
            onClick={async () => {
              const result = await api.exportDatabase();
              if (result.success) {
                toast('success', s.export_success);
              } else if (result.error) {
                toast('error', result.error);
              }
            }}
            className="kz-btn kz-btn--sm"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
          >
            <Download size={12} /> {s.export_database}
          </button>
          {!clearConfirm ? (
            <button
              onClick={() => setClearConfirm(true)}
              className="kz-btn kz-btn--sm kz-btn--danger"
              style={{ marginLeft: 'auto' }}
            >
              {s.clear_db}
            </button>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginLeft: 'auto' }}>
              <span className="kz-mono" style={{ fontSize: 11.5, color: 'var(--c-danger)' }}>{s.clear_db_confirm}</span>
              <button onClick={() => setClearConfirm(false)} className="kz-btn kz-btn--sm">{s.clear_db_cancel}</button>
              <button onClick={handleClearDb} className="kz-btn kz-btn--sm kz-btn--danger">
                {s.clear_db_yes}
              </button>
            </div>
          )}
        </div>
      </div>

      {/* ── License ─────────────────────────────────────── */}
      <h3 className="kz-section-title">
        <span>{s.section_license || 'License'}</span>
        {licenseStatus?.licensed && (
          <span className="kz-section-title__count">{s.license_licensed}</span>
        )}
      </h3>
      <div className="kz-card" style={{ padding: '6px 18px', marginBottom: 22 }}>
        {/* Status row */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 6px', borderBottom: '1px solid var(--line-soft)' }}>
          <div style={{ flex: 1, fontSize: 13, color: 'var(--ink)' }}>{s.license_status}</div>
          <div style={{ flexShrink: 0 }}>
            {licenseStatus ? (
              licenseStatus.licensed ? (
                <span className="kz-badge kz-badge--success kz-badge--dot">{s.license_licensed}</span>
              ) : licenseStatus.trial.active ? (
                <span className="kz-badge kz-badge--warn kz-badge--dot">
                  {s.license_trial_active} — {licenseStatus.trial.daysRemaining} {s.license_trial_days}
                </span>
              ) : (
                <span className="kz-badge kz-badge--danger kz-badge--dot">{s.license_trial_expired}</span>
              )
            ) : (
              <span className="kz-mono kz-text-mute" style={{ fontSize: 11 }}>...</span>
            )}
          </div>
        </div>

        {/* Tier row */}
        {licenseStatus && licenseStatus.licensed && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 6px', borderBottom: '1px solid var(--line-soft)' }}>
            <div style={{ flex: 1, fontSize: 13, color: 'var(--ink)' }}>{s.license_tier}</div>
            <div style={{ flexShrink: 0 }}>
              <span className="kz-badge kz-badge--accent">
                {(s[`license_tier_${licenseStatus.tier}` as keyof typeof s] as string) || licenseStatus.tier.toUpperCase()}
              </span>
            </div>
          </div>
        )}

        {/* Key row + deactivate */}
        {licenseStatus?.licensed && licenseStatus.licenseKey && (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 6px', borderBottom: '1px solid var(--line-soft)' }}>
              <div style={{ flex: 1, fontSize: 13, color: 'var(--ink)' }}>{s.license_key}</div>
              <span className="kz-mono" style={{ fontSize: 12, color: 'var(--ink-soft)', letterSpacing: '0.05em' }}>
                {licenseStatus.licenseKey.slice(0, 7)}****-****
              </span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '12px 6px' }}>
              {deactivateConfirm ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span className="kz-text-mute" style={{ fontSize: 12 }}>{s.license_deactivate_confirm}</span>
                  <button onClick={handleLicenseDeactivate} className="kz-btn kz-btn--sm kz-btn--danger">
                    {s.license_deactivate}
                  </button>
                  <button onClick={() => setDeactivateConfirm(false)} className="kz-btn kz-btn--sm">
                    {s.clear_db_cancel}
                  </button>
                </div>
              ) : (
                <button onClick={() => setDeactivateConfirm(true)} className="kz-btn kz-btn--sm kz-btn--danger">
                  {s.license_deactivate}
                </button>
              )}
            </div>
          </>
        )}

        {/* Activate form */}
        {licenseStatus && !licenseStatus.licensed && (
          <div style={{ padding: '14px 6px', display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div style={{ position: 'relative', flex: 1 }}>
                <Key
                  size={12}
                  style={{
                    position: 'absolute',
                    left: 10,
                    top: '50%',
                    transform: 'translateY(-50%)',
                    color: 'var(--ink-mute)',
                    pointerEvents: 'none',
                  }}
                />
                <input
                  type="text"
                  value={licenseKeyInput}
                  onChange={(e) => setLicenseKeyInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleLicenseActivate(); }}
                  placeholder={s.license_key_placeholder}
                  className="kz-input kz-mono"
                  style={{ width: '100%', paddingLeft: 28, fontSize: 12 }}
                  disabled={licenseActivating}
                />
              </div>
              <button
                onClick={handleLicenseActivate}
                disabled={licenseActivating || !licenseKeyInput.trim()}
                className="kz-btn kz-btn--primary kz-btn--sm"
                style={{ whiteSpace: 'nowrap', opacity: (licenseActivating || !licenseKeyInput.trim()) ? 0.4 : 1 }}
              >
                {licenseActivating ? s.license_activating : s.license_activate}
              </button>
            </div>
            {licenseError && (
              <div className="kz-mono" style={{ fontSize: 11, color: 'var(--c-danger)', background: 'var(--c-danger-bg)', padding: '6px 10px', borderRadius: 6 }}>
                {licenseError}
              </div>
            )}
            <div className="kz-text-mute" style={{ fontSize: 11.5, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <span>{s.license_gate_purchase}</span>
              <button
                onClick={() => onOpenExternal(SITE_BASE_URL + '/')}
                className="kz-text-accent"
                style={{ display: 'inline-flex', alignItems: 'center', gap: 3, background: 'transparent', border: 0, cursor: 'pointer' }}
              >
                deepseno.enmooy.com <ExternalLink size={9} />
              </button>
            </div>
          </div>
        )}
      </div>

      {/* ── Diagnostics ─────────────────────────────────── */}
      <h3 className="kz-section-title">
        <span>{s.section_about || 'Diagnostics'}</span>
      </h3>
      <div className="kz-card" style={{ padding: 18 }}>
        <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
          <button
            onClick={() => api.openDevTools()}
            className="kz-btn kz-btn--sm"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
          >
            <ExternalLink size={12} /> {s.open_devtools || 'Open DevTools'}
          </button>
          <button
            onClick={async () => {
              const logs = await api.getMainLogs();
              const text = logs.join('\n');
              await window.api.clipboardWriteText(text);
              toast('success', s.logs_copied || 'Logs copied to clipboard');
            }}
            className="kz-btn kz-btn--sm"
          >
            {s.copy_main_logs || 'Copy Main Process Logs'}
          </button>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 0', borderTop: '1px solid var(--line-soft)' }}>
          <div style={{ flex: 1 }}>
            <div className="kz-serif" style={{ fontSize: 14 }}>DeepSeno</div>
            <div className="kz-mono kz-text-mute" style={{ fontSize: 11.5, marginTop: 2 }}>
              {s.version} {typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '1.1.0'} · {s.about_tagline || 'Your Second Brain for Voice'}
            </div>
          </div>
          <button
            onClick={() => onOpenExternal('https://github.com/deepseno/deepseno')}
            className="kz-btn kz-btn--sm kz-btn--ghost"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
          >
            <ExternalLink size={12} /> {s.github}
          </button>
        </div>
      </div>
    </div>
  );
}
