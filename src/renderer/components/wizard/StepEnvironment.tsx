import { useState, useEffect } from 'react';
import { Search, CheckCircle2, XCircle, Loader2, Download, ExternalLink } from 'lucide-react';
import { useI18n } from '../../i18n';
import { useApi, EnvCheckResult } from '../../hooks/useApi';

interface Props {
  onResult: (result: EnvCheckResult) => void;
}

type CheckKey = keyof EnvCheckResult;

const CHECK_KEYS: CheckKey[] = ['ffmpeg', 'local', 'sherpaModels'];

export default function StepEnvironment({ onResult }: Props) {
  const { t } = useI18n();
  const api = useApi();
  const w = t.wizard;

  const [result, setResult] = useState<EnvCheckResult | null>(null);
  const [loading, setLoading] = useState(false);

  const nameMap: Record<CheckKey, string> = {
    ffmpeg: w.ffmpeg_name,
    local: w.local_name,
    sherpaModels: 'sherpa-onnx Models',
  };

  const isWin = navigator.userAgent.includes('Win');

  async function runCheck() {
    setLoading(true);
    try {
      const r = await api.detectEnvironment();
      setResult(r);
      onResult(r);
    } catch (err) {
      console.error('[StepEnvironment] Check failed:', err);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { runCheck(); }, []);

  function openDownload(url: string) {
    api.openExternal(url);
  }

  function renderAction(key: CheckKey) {
    const item = result?.[key];
    if (!item || item.status === 'ok') return null;

    switch (key) {
      case 'ffmpeg':
        return (
          <div className="ml-9 mt-2 px-2 space-y-2">
            <p className="kz-mono kz-text-mute" style={{ fontSize: '11.5px' }}>
              {isWin ? w.ffmpeg_install_hint_win : w.ffmpeg_install_hint_mac}
            </p>
            {isWin ? (
              <button
                onClick={() => openDownload('https://www.gyan.dev/ffmpeg/builds/')}
                className="kz-btn kz-btn--accent kz-btn--sm"
              >
                <Download size={12} />
                {w.install_ffmpeg}
                <ExternalLink size={10} />
              </button>
            ) : (
              <code className="kz-code block" style={{ fontSize: '11.5px', padding: '8px 12px' }}>
                brew install ffmpeg
              </code>
            )}
          </div>
        );

      case 'local':
        return (
          <div className="ml-9 mt-2 px-2 space-y-2">
            <p className="kz-mono kz-text-mute" style={{ fontSize: '11.5px' }}>{w.local_install_hint}</p>
            <button
              onClick={() => openDownload('https://local.com/download')}
              className="kz-btn kz-btn--accent kz-btn--sm"
            >
              <Download size={12} />
              {w.install_local}
              <ExternalLink size={10} />
            </button>
          </div>
        );

      case 'sherpaModels':
        return (
          <div className="ml-9 mt-2 px-2 space-y-2">
            <p className="kz-mono kz-text-mute" style={{ fontSize: '11.5px' }}>
              ASR/VAD/Speaker models will be downloaded in the next step.
            </p>
          </div>
        );

      default:
        return null;
    }
  }

  const allPassed = result && CHECK_KEYS.every((k) => result[k].status === 'ok');

  return (
    <div className="flex flex-col flex-1 px-12 py-8">
      <div className="flex items-center gap-2 mb-2">
        <Search size={18} className="kz-text-accent" />
        <h2 className="kz-serif" style={{ fontSize: '22px', color: 'var(--ink)' }}>{w.env_title}</h2>
      </div>
      <p className="kz-serif-italic kz-text-mute mb-6" style={{ fontSize: '12.5px' }}>{w.env_desc}</p>

      <div className="space-y-2 mb-4 flex-1 overflow-y-auto">
        {CHECK_KEYS.map((key) => {
          const item = result?.[key];
          const status = loading && !result ? 'checking' : item?.status || 'pending';

          return (
            <div key={key}>
              <div
                className="flex items-center gap-3 kz-card"
                style={{ padding: '10px 14px' }}
              >
                {status === 'ok' && <CheckCircle2 size={16} className="flex-shrink-0" style={{ color: 'var(--c-success)' }} />}
                {status === 'missing' && <XCircle size={16} className="flex-shrink-0" style={{ color: 'var(--c-danger)' }} />}
                {(status === 'checking' || status === 'pending') && <Loader2 size={16} className="animate-spin flex-shrink-0" style={{ color: 'var(--c-info)' }} />}
                <span className="kz-mono flex-1" style={{ fontSize: '12.5px', color: 'var(--ink-soft)' }}>{nameMap[key]}</span>
                {status === 'ok' && item?.version && (
                  <span className="kz-mono kz-text-mute" style={{ fontSize: '11px' }}>{item.version}</span>
                )}
                <span
                  className={
                    'kz-badge ' +
                    (status === 'ok'
                      ? 'kz-badge--success'
                      : status === 'missing'
                        ? 'kz-badge--danger'
                        : 'kz-badge--info')
                  }
                >
                  {status === 'ok' ? w.installed : status === 'missing' ? w.not_installed : w.checking}
                </span>
              </div>
              {status === 'missing' && renderAction(key)}
            </div>
          );
        })}
      </div>

      {allPassed && (
        <div className="text-center kz-serif-italic mb-4" style={{ color: 'var(--c-success)', fontSize: '13px' }}>
          {w.all_passed}
        </div>
      )}

      <div className="flex justify-center">
        <button
          onClick={runCheck}
          disabled={loading}
          className="kz-btn kz-btn--sm disabled:opacity-50"
        >
          {loading ? w.checking : w.recheck}
        </button>
      </div>
    </div>
  );
}
