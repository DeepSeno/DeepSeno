import { useState, useEffect, useRef, useCallback } from 'react';
import { Download, CheckCircle2, XCircle, Loader2, Clock, Cpu, HardDrive, Monitor, Server } from 'lucide-react';
import { useI18n } from '../../i18n';
import { useApi, ModelPullProgress, HardwareInfo } from '../../hooks/useApi';
import Select from '../Select';

interface ModelInfo {
  name: string;
  label: string;
  size: string;
  isLocal: boolean; // true = Local model, false = sherpa-onnx
}

type ModelStatus = 'queued' | 'downloading' | 'done' | 'error' | 'skipped';
type LocalStage = 'checking' | 'not_installed' | 'downloading' | 'installing' | 'starting' | 'ready' | 'error' | 'already_installed';

const PULL_TERMINAL_RESTORE_WINDOW_MS = 60 * 1000;

interface Props {
  onModelsReady: (models: string[]) => void;
  onSkip?: () => void;
  onRecommendedModel?: (model: string) => void;
}

const QUALITY_TONE: Record<string, 'warn' | 'info' | 'success'> = {
  basic: 'warn',
  good: 'info',
  excellent: 'success',
};

function shouldRestorePullState(state: ModelPullProgress): boolean {
  if (state.status === 'downloading') return true;
  if (!state.updatedAt) return false;
  return Date.now() - state.updatedAt <= PULL_TERMINAL_RESTORE_WINDOW_MS;
}

export default function StepModels({ onModelsReady, onSkip: _onSkip, onRecommendedModel }: Props) {
  const { t, lang } = useI18n();
  const api = useApi();
  const w = t.wizard;

  // Hardware detection state
  const [hardware, setHardware] = useState<HardwareInfo | null>(null);
  const [hwLoading, setHwLoading] = useState(true);

  const [MODELS, setModels] = useState<ModelInfo[]>([
    { name: 'qwen3.5:4b', label: 'Qwen3.5-4B (LLM)', size: '~3.4 GB', isLocal: true },
    { name: 'bge-m3', label: 'bge-m3 (Embeddings)', size: '~1.2 GB', isLocal: true },
    { name: 'sherpa-onnx', label: 'sherpa-onnx (ASR/VAD/Speaker)', size: '~406 MB', isLocal: false },
  ]);

  const [statuses, setStatuses] = useState<Record<string, ModelStatus>>({});
  const [progress, setProgress] = useState<Record<string, { completed: number; total: number; status: string }>>({});
  const [downloading, setDownloading] = useState(false);
  const downloadingRef = useRef(false);
  const downloadedRef = useRef<string[]>([]);
  const pullUpdatedAtRef = useRef<Record<string, number>>({});
  const [sherpaMirror, setSherpaMirror] = useState<'' | 'modelscope' | 'hf-mirror' | 'ghfast'>('modelscope');

  // Local install state
  const [localStage, setLocalStage] = useState<LocalStage>('checking');
  const [localProgress, setLocalProgress] = useState<{ completed: number; total: number }>({ completed: 0, total: 0 });

  const applyPullProgress = useCallback((data: ModelPullProgress) => {
    if (!data?.model) return;

    const key = data.model.startsWith('sherpa:') ? 'sherpa-onnx' : data.model;
    const incomingUpdatedAt = data.updatedAt ?? Date.now();
    const lastUpdatedAt = pullUpdatedAtRef.current[key] ?? 0;
    if (data.updatedAt && lastUpdatedAt > data.updatedAt) return;
    pullUpdatedAtRef.current[key] = Math.max(lastUpdatedAt, incomingUpdatedAt);

    setProgress((prev) => ({
      ...prev,
      [key]: { completed: data.completed, total: data.total, status: data.status },
    }));

    setStatuses((prev) => {
      const next = { ...prev };
      if (data.status === 'success' || data.status === 'done') {
        next[key] = 'done';
      } else if (data.status === 'error') {
        next[key] = 'error';
      } else if (data.status === 'cancelled') {
        next[key] = 'queued';
      } else {
        next[key] = 'downloading';
      }
      return next;
    });

    if ((data.status === 'success' || data.status === 'done') && !downloadedRef.current.includes(key)) {
      downloadedRef.current.push(key);
    }
  }, []);

  // Detect hardware on mount
  useEffect(() => {
    (async () => {
      try {
        const hw = await api.detectHardware();
        setHardware(hw);
        if (hw.recommendedLlmModel) {
          onRecommendedModel?.(hw.recommendedLlmModel);
        }

        // Auto-select the recommended LLM model based on hardware
        if (hw.recommendedLlmModel && hw.recommendedLlmModel !== 'qwen3.5:4b') {
          const sizeMap: Record<string, string> = {
            'qwen3.5:4b': '~3.4 GB',
            'qwen3.5:9b': '~6.6 GB',
            'qwen3.5:27b': '~17 GB',
            'qwen3.5:35b': '~24 GB',
            'qwen3.5:122b': '~81 GB',
          };
          setModels([
            {
              name: hw.recommendedLlmModel,
              label: `${hw.recommendedLlmModel} (LLM)`,
              size: sizeMap[hw.recommendedLlmModel] || '~? GB',
              isLocal: true,
            },
            { name: 'bge-m3', label: 'bge-m3 (Embeddings)', size: '~1.2 GB', isLocal: true },
          ]);
        }
      } catch (err) {
        console.error('[StepModels] Hardware detection failed:', err);
      } finally {
        setHwLoading(false);
      }
    })();
  }, []);

  // Check Local installation status on mount
  useEffect(() => {
    (async () => {
      try {
        const installed = await api.isLocalInstalled();
        setLocalStage(installed ? 'already_installed' : 'not_installed');
      } catch {
        setLocalStage('not_installed');
      }
    })();
  }, []);

  // Check which models are already installed
  useEffect(() => {
    (async () => {
      try {
        const [installed, sherpaStatus] = await Promise.all([
          api.listModels(),
          api.checkSherpaModels(),
        ]);
        const initial: Record<string, ModelStatus> = {};
        const done: string[] = [];
        for (const m of MODELS) {
          const localInstalled = installed.some((n: string) => (
            n === m.name ||
            n === `${m.name}:latest` ||
            `${n}:latest` === `${m.name}:latest`
          ));
          if (m.isLocal && localInstalled) {
            initial[m.name] = 'done';
            done.push(m.name);
          } else if (m.name === 'sherpa-onnx' && sherpaStatus.allReady) {
            initial[m.name] = 'done';
            done.push(m.name);
          } else {
            initial[m.name] = 'queued';
          }
        }
        setStatuses((prev) => {
          const next = { ...initial };
          for (const [name, status] of Object.entries(prev)) {
            if (status === 'downloading' || status === 'error') {
              next[name] = status;
            }
          }
          return next;
        });
        downloadedRef.current = done;
        if (done.length === MODELS.length) {
          onModelsReady(done);
        }
      } catch {
        const initial: Record<string, ModelStatus> = {};
        for (const m of MODELS) initial[m.name] = 'queued';
        setStatuses(initial);
      }
    })();
  }, [MODELS]);

  // Subscribe to pull progress events
  useEffect(() => {
    const unsub = api.onModelPullProgress((_e, data: ModelPullProgress) => {
      applyPullProgress(data);
    });
    return unsub;
  }, [api, applyPullProgress]);

  useEffect(() => {
    api.getPullStatus().then((states) => {
      const list = Array.isArray(states) ? states : [];
      for (const state of list) {
        if (!shouldRestorePullState(state)) continue;
        applyPullProgress(state);
      }
    }).catch(() => {});
  }, [api, applyPullProgress]);

  // Subscribe to Local install progress events
  useEffect(() => {
    const unsub = api.onLocalInstallProgress((_e, data: { stage: string; completed: number; total: number }) => {
      setLocalStage(data.stage as LocalStage);
      setLocalProgress({ completed: data.completed, total: data.total });
    });
    return unsub;
  }, []);

  async function startDownloads() {
    if (downloadingRef.current) return;
    downloadingRef.current = true;
    setDownloading(true);

    try {
      // Step 0: Install Local if not installed
      if (localStage === 'not_installed') {
        setLocalStage('downloading');
        const result = await api.installLocal();
        if (!result.success) {
          setLocalStage('error');
          return;
        }
        setLocalStage('ready');
      }

      // Step 1-N: Download models (existing logic)
      const toDownload = MODELS.filter((m) => statuses[m.name] !== 'done');

      for (const model of toDownload) {
        setStatuses((prev) => ({ ...prev, [model.name]: 'downloading' }));
        try {
          if (model.isLocal) {
            const result = await api.pullModel(model.name);
            if (!result.success) {
              setStatuses((prev) => ({ ...prev, [model.name]: 'error' }));
              continue;
            }
          } else if (model.name === 'sherpa-onnx') {
            const result = await api.downloadSherpaModels(sherpaMirror);
            if (!result.success) {
              setStatuses((prev) => ({ ...prev, [model.name]: 'error' }));
              continue;
            }
          }
          setStatuses((prev) => ({ ...prev, [model.name]: 'done' }));
          downloadedRef.current.push(model.name);
        } catch {
          setStatuses((prev) => ({ ...prev, [model.name]: 'error' }));
        }
      }

      onModelsReady(downloadedRef.current);
    } finally {
      downloadingRef.current = false;
      setDownloading(false);
    }
  }

  function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }

  function getQualityLabel(quality: string): string {
    switch (quality) {
      case 'basic': return w.hw_quality_basic;
      case 'good': return w.hw_quality_good;
      case 'excellent': return w.hw_quality_excellent;
      default: return quality;
    }
  }

  function getPlatformLabel(platform: string, arch: string): string {
    const platMap: Record<string, string> = {
      darwin: 'macOS',
      win32: 'Windows',
      linux: 'Linux',
    };
    const archMap: Record<string, string> = {
      arm64: 'Apple Silicon',
      x64: 'x86_64',
      ia32: 'x86',
    };
    return `${platMap[platform] || platform} ${archMap[arch] || arch}`;
  }

  function getLocalStageLabel(): string {
    switch (localStage) {
      case 'checking': return w.local_checking;
      case 'downloading': return w.local_downloading;
      case 'installing': return w.local_installing;
      case 'starting': return w.local_starting;
      case 'ready':
      case 'already_installed': return w.local_ready;
      case 'not_installed': return w.local_not_installed;
      case 'error': return w.local_install_failed;
      default: return '';
    }
  }

  const allDone = MODELS.every((m) => statuses[m.name] === 'done');
  const hasQueued = MODELS.some((m) => statuses[m.name] === 'queued');
  const needsLocalInstall = localStage === 'not_installed';

  const qualityTone = hardware ? (QUALITY_TONE[hardware.recommendedQuality] || 'info') : 'info';

  // Compute Local download progress percentage
  const localPct = localProgress.total > 0
    ? Math.min(100, Math.max(0, Math.round((localProgress.completed / localProgress.total) * 100)))
    : 0;

  return (
    <div className="flex flex-col flex-1 px-12 py-6 overflow-y-auto">
      {/* Hardware Detection Card */}
      <div className="flex items-center gap-2 mb-2">
        <Cpu size={18} className="kz-text-accent" />
        <h2 className="kz-serif" style={{ fontSize: '22px', color: 'var(--ink)' }}>{w.hw_title}</h2>
      </div>
      <p className="kz-serif-italic kz-text-mute mb-4" style={{ fontSize: '12.5px' }}>{w.hw_desc}</p>

      {hwLoading ? (
        <div className="kz-card flex items-center gap-2 mb-5" style={{ padding: '12px 16px' }}>
          <Loader2 size={14} className="animate-spin" style={{ color: 'var(--c-info)' }} />
          <span className="kz-text-soft" style={{ fontSize: '12px' }}>{w.hw_detecting}</span>
        </div>
      ) : hardware ? (
        <div className="kz-card-soft mb-5" style={{ padding: '14px 16px' }}>
          <div className="grid grid-cols-2 gap-3">
            {/* RAM */}
            <div className="flex items-center gap-2">
              <HardDrive size={13} className="kz-text-mute flex-shrink-0" />
              <span className="kz-mono kz-text-mute" style={{ fontSize: '11px' }}>{w.hw_ram}</span>
              <span className="kz-mono kz-text-ink ml-auto" style={{ fontSize: '11.5px', fontWeight: 500 }}>
                {hardware.totalMemoryGB} GB
              </span>
            </div>
            {/* CPU */}
            <div className="flex items-center gap-2">
              <Cpu size={13} className="kz-text-mute flex-shrink-0" />
              <span className="kz-mono kz-text-mute" style={{ fontSize: '11px' }}>{w.hw_cpu}</span>
              <span className="kz-mono kz-text-ink ml-auto" style={{ fontSize: '11.5px', fontWeight: 500 }}>
                {hardware.cpuCores}
              </span>
            </div>
            {/* Platform */}
            <div className="flex items-center gap-2">
              <Monitor size={13} className="kz-text-mute flex-shrink-0" />
              <span className="kz-mono kz-text-mute" style={{ fontSize: '11px' }}>{w.hw_platform}</span>
              <span className="kz-mono kz-text-ink ml-auto" style={{ fontSize: '11.5px', fontWeight: 500 }}>
                {getPlatformLabel(hardware.platform, hardware.arch)}
              </span>
            </div>
            {/* Quality */}
            <div className="flex items-center gap-2">
              <span className="kz-mono kz-text-mute ml-5" style={{ fontSize: '11px' }}>{w.hw_quality_label}</span>
              <span className={`kz-badge kz-badge--${qualityTone} ml-auto`}>
                {getQualityLabel(hardware.recommendedQuality)}
              </span>
            </div>
          </div>
          {/* Recommended model */}
          <div
            className="mt-3 pt-3 flex items-center justify-between"
            style={{ borderTop: '1px solid var(--line-soft)' }}
          >
            <span className="kz-mono kz-text-mute" style={{ fontSize: '11px' }}>{w.hw_recommended}</span>
            <span className="kz-text-ink" style={{ fontSize: '13px', fontWeight: 600 }}>
              {hardware.recommendedLlmModel}
            </span>
          </div>
        </div>
      ) : null}

      {/* Model Download Section */}
      <div className="flex items-center gap-2 mb-2">
        <Download size={16} className="kz-text-accent" />
        <h3 className="kz-serif" style={{ fontSize: '17px', color: 'var(--ink)' }}>{w.model_title}</h3>
      </div>
      <p className="kz-mono kz-text-mute mb-4" style={{ fontSize: '11px' }}>{w.model_desc}</p>

      <div className="space-y-3 flex-1">
        {/* Local Runtime Row — show when not installed */}
        {localStage !== 'already_installed' && (
          <div className="kz-card" style={{ padding: '14px 16px' }}>
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <Server size={14} className="kz-text-mute" />
                <span className="kz-mono kz-text-soft" style={{ fontSize: '12.5px', fontWeight: 600 }}>{w.local_env}</span>
                <span className="kz-mono kz-text-mute ml-2" style={{ fontSize: '11px' }}>
                  {hardware?.platform === 'win32' ? '~1.2 GB' : '~80 MB'}
                </span>
              </div>
              <div className="flex items-center gap-1.5">
                {(localStage === 'ready') && <CheckCircle2 size={14} style={{ color: 'var(--c-success)' }} />}
                {(localStage === 'downloading' || localStage === 'installing' || localStage === 'starting') && <Loader2 size={14} className="animate-spin" style={{ color: 'var(--c-info)' }} />}
                {localStage === 'not_installed' && <Clock size={14} className="kz-text-faint" />}
                {localStage === 'checking' && <Loader2 size={14} className="animate-spin kz-text-faint" />}
                {localStage === 'error' && <XCircle size={14} style={{ color: 'var(--c-danger)' }} />}
                <span
                  className={
                    'kz-badge ' +
                    (localStage === 'ready'
                      ? 'kz-badge--success'
                      : localStage === 'error'
                        ? 'kz-badge--danger'
                        : localStage === 'not_installed'
                          ? 'kz-badge--mute'
                          : 'kz-badge--info')
                  }
                >
                  {localStage === 'downloading' ? `${localPct}%` : getLocalStageLabel()}
                </span>
              </div>
            </div>
            {localStage === 'downloading' && (
              <div
                className="w-full overflow-hidden"
                style={{ height: 4, background: 'var(--bg-elev)', borderRadius: 2 }}
              >
                <div
                  className="h-full transition-all duration-300"
                  style={{ width: `${localPct}%`, background: 'var(--c-accent)' }}
                />
              </div>
            )}
            {localStage === 'downloading' && localProgress.total > 0 && (
              <div className="flex justify-between mt-1 kz-mono kz-text-mute" style={{ fontSize: '10.5px' }}>
                <span>{w.local_downloading}</span>
                <span>{formatBytes(localProgress.completed)} / {formatBytes(localProgress.total)}</span>
              </div>
            )}
          </div>
        )}

        {MODELS.map((model) => {
            const status = statuses[model.name] || 'queued';
            const prog = progress[model.name];
            const pct = prog && prog.total > 0
              ? Math.min(100, Math.max(0, Math.round((prog.completed / prog.total) * 100)))
              : 0;
            const showSize = prog && prog.total > 1024;

          return (
            <div key={model.name} className="kz-card" style={{ padding: '14px 16px' }}>
              <div className="flex items-center justify-between mb-2">
                <div>
                  <span className="kz-mono kz-text-soft" style={{ fontSize: '12.5px', fontWeight: 600 }}>{model.label}</span>
                  <span className="kz-mono kz-text-mute ml-2" style={{ fontSize: '11px' }}>{model.size}</span>
                </div>
                <div className="flex items-center gap-1.5">
                  {status === 'done' && <CheckCircle2 size={14} style={{ color: 'var(--c-success)' }} />}
                  {status === 'downloading' && <Loader2 size={14} className="animate-spin" style={{ color: 'var(--c-info)' }} />}
                  {status === 'queued' && <Clock size={14} className="kz-text-faint" />}
                  {status === 'error' && <XCircle size={14} style={{ color: 'var(--c-danger)' }} />}
                  <span
                    className={
                      'kz-badge ' +
                      (status === 'done'
                        ? 'kz-badge--success'
                        : status === 'downloading'
                          ? 'kz-badge--info'
                          : status === 'error'
                            ? 'kz-badge--danger'
                            : 'kz-badge--mute')
                    }
                  >
                    {status === 'done' ? w.model_done
                      : status === 'downloading' ? `${pct}%`
                      : status === 'error' ? w.model_error
                      : w.model_queued}
                  </span>
                </div>
              </div>
              {status === 'downloading' && (
                <div
                  className="w-full overflow-hidden"
                  style={{ height: 4, background: 'var(--bg-elev)', borderRadius: 2 }}
                >
                  <div
                    className="h-full transition-all duration-300"
                    style={{ width: `${pct}%`, background: 'var(--c-accent)' }}
                  />
                </div>
              )}
              {status === 'downloading' && showSize && (
                <div className="flex justify-between mt-1 kz-mono kz-text-mute" style={{ fontSize: '10.5px' }}>
                  <span>{prog.status}</span>
                  <span>{formatBytes(prog.completed)} / {formatBytes(prog.total)}</span>
                </div>
              )}
            </div>
          );
        })}

      </div>

      <div className="flex justify-center gap-3 mt-4">
        {(hasQueued || needsLocalInstall) && !downloading && (
          <button
            onClick={startDownloads}
            className="kz-btn kz-btn--primary kz-btn--lg"
          >
            <Download size={14} />
            {w.model_one_click_btn}
          </button>
        )}
      </div>

      {/* Settings hint */}
      {!allDone && !downloading && (
        <p className="text-center kz-text-mute mt-3" style={{ fontSize: '11.5px' }}>
          {w.model_settings_hint}
        </p>
      )}

      {/* Mirror Source Selector — only show when downloads are queued and not in progress */}
      {(hasQueued || needsLocalInstall) && !downloading && (
        <div className="flex items-center justify-center gap-2 mt-3 kz-text-soft" style={{ fontSize: '12px' }}>
          <span className="kz-mono">{lang === 'zh' ? '语音模型下载源' : 'ASR Model Source'}</span>
          <Select
            value={sherpaMirror}
            onChange={(v) => setSherpaMirror(v as any)}
            className="kz-mono"
            style={{ width: 200, height: 28, fontSize: 11.5 }}
            ariaLabel={lang === 'zh' ? '语音模型下载源' : 'ASR Model Source'}
            options={[
              { value: 'modelscope', label: lang === 'zh' ? 'ModelScope（推荐）' : 'ModelScope (recommended)' },
              { value: 'hf-mirror', label: lang === 'zh' ? 'HF Mirror 镜像' : 'HF Mirror' },
              { value: 'ghfast', label: lang === 'zh' ? 'GitHub 加速代理' : 'GitHub Proxy' },
              { value: '', label: lang === 'zh' ? 'GitHub 直连' : 'GitHub Direct' },
            ]}
          />
        </div>
      )}
    </div>
  );
}
