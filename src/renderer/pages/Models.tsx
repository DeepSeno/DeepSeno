import { useState, useEffect, useCallback, useRef } from 'react';
import { Cpu, Sliders, Wrench } from 'lucide-react';
import { useI18n } from '../i18n';
import { useApi } from '../hooks/useApi';
import { useSettings } from '../hooks/useSettings';
import { useNotifications } from '../components/NotificationCenter';
import { StatusBadge } from '../components/settings';
import EnginesSection from './settings/models/EnginesSection';
import BehaviorSection from './settings/models/BehaviorSection';
import AdvancedSection from './settings/models/AdvancedSection';
import type { LocalInstallStage, LocalModelStatus } from './settings/models/types';

export type { LocalInstallStage, LocalModelStatus };

export default function Models() {
  const { t, lang } = useI18n();
  const api = useApi();
  const { toast } = useNotifications();
  const s = t.settings;
  const { settings, saved, updateField } = useSettings();

  // ─── Sub-tab state ──────────────────────────────────────────
  const [tab, setTab] = useState<'engines' | 'behavior' | 'advanced'>('engines');

  // ─── llama-server (bundled local) state ──────────────────────
  const [llamaServerStatus, setLlamaServerStatus] = useState<{ running: boolean; port: number | null }>({ running: false, port: null });

  // ─── Scroll targets for ribbon-click navigation ─────────────
  const sherpaRef = useRef<HTMLDivElement>(null!);
  const localRef = useRef<HTMLDivElement>(null!);
  const llmModelListRef = useRef<HTMLDivElement>(null!);

  // ─── AI engine state ─────────────────────────────────────────
  const [localModels, setLocalModels] = useState<string[]>([]);
  const [localStatus, setLocalStatus] = useState<'checking' | 'connected' | 'disconnected'>('checking');

  // Local install + model download state
  const [localInstallStage, setLocalInstallStage] = useState<LocalInstallStage>('checking');
  const [localModelStatuses, setLocalModelStatuses] = useState<Record<string, LocalModelStatus>>({});
  const [localModelErrors, setLocalModelErrors] = useState<Record<string, string>>({});
  const [localModelProgress, setLocalModelProgress] = useState<Record<string, { completed: number; total: number }>>({});
  const [localTesting, setLocalTesting] = useState(false);
  const [recentlyTested, setRecentlyTested] = useState<string | null>(null);

  // Cloud API state
  const [cloudStatus, setCloudStatus] = useState<'idle' | 'checking' | 'connected' | 'error'>('idle');
  const [cloudError, setCloudError] = useState<string | null>(null);
  const [cloudModels, setCloudModels] = useState<string[]>([]);

  // sherpa-onnx model state
  const [svModelStatus, setSvModelStatus] = useState<'checking' | 'ready' | 'missing' | 'downloading' | 'error'>('checking');
  const [svDownloadProgress, setSvDownloadProgress] = useState(0);
  const [svError, setSvError] = useState<string | null>(null);
  const [svMirror, setSvMirror] = useState<'' | 'modelscope' | 'hf-mirror' | 'ghfast'>('modelscope');

  // ─── Hardware info for model recommendations ───────────────
  const [totalMemoryGB, setTotalMemoryGB] = useState(0);

  // ─── Load data on mount ────────────────────────────────────
  useEffect(() => {
    if (settings?.llmProvider === 'local') {
      checkLlamaServer();
    } else {
      checkLocal();
    }
    api.detectHardware().then((hw) => setTotalMemoryGB(hw.totalMemoryGB)).catch(() => {});
  }, []);

  useEffect(() => {
    if (settings?.llmProvider === 'openai' && settings?.cloudApiUrl && settings?.cloudApiKey) {
      checkCloud();
    }
  }, [settings?.llmProvider, settings?.cloudApiUrl, settings?.cloudApiKey]);

  useEffect(() => {
    setSvModelStatus('checking');
    Promise.all([
      api.checkSherpaModels(),
      api.getSherpaDownloadStatus(),
    ]).then(([r, dlState]) => {
      if (dlState) {
        setSvModelStatus('downloading');
        if (dlState.total > 0) {
          setSvDownloadProgress(Math.round((dlState.completed / dlState.total) * 100));
        }
      } else {
        setSvModelStatus(r.allReady ? 'ready' : 'missing');
      }
    }).catch(() => setSvModelStatus('missing'));
  }, []);

  useEffect(() => {
    const unsub = api.onModelPullProgress((_event, data) => {
      if (data.model.startsWith('sherpa:')) {
        if (data.status === 'success') {
          setSvModelStatus('ready');
          setSvDownloadProgress(100);
        } else if (data.total > 0) {
          setSvDownloadProgress(Math.round((data.completed / data.total) * 100));
        }
      } else {
        if (data.status === 'testing') {
          setLocalModelStatuses((prev) => ({ ...prev, [data.model]: 'testing' }));
          setLocalModelErrors((prev) => {
            const next = { ...prev };
            delete next[data.model];
            return next;
          });
        }
        if (data.status?.startsWith('updating_local')) {
          setLocalModelStatuses((prev) => ({ ...prev, [data.model]: 'downloading' }));
          setLocalModelErrors((prev) => ({
            ...prev,
            [data.model]: s.local_updating,
          }));
        }
        setLocalModelProgress((prev) => ({
          ...prev,
          [data.model]: { completed: data.completed, total: data.total },
        }));
      }
    });
    return unsub;
  }, []);

  useEffect(() => {
    api.isLocalInstalled().then((installed) => {
      setLocalInstallStage(installed ? 'already_installed' : 'not_installed');
    }).catch(() => setLocalInstallStage('not_installed'));
  }, []);

  useEffect(() => {
    return api.onLocalInstallProgress((_e, data) => {
      setLocalInstallStage(data.stage as LocalInstallStage);
    });
  }, []);

  useEffect(() => {
    api.getPullStatus().then((state) => {
      if (state) {
        setLocalModelStatuses((prev) => ({ ...prev, [state.model]: 'downloading' }));
        setLocalModelProgress((prev) => ({
          ...prev,
          [state.model]: { completed: state.completed, total: state.total },
        }));
      }
    }).catch(() => {});
  }, []);

  useEffect(() => {
    const llm = settings?.llmModel || 'qwen3.5:4b';
    const QWEN_SIZES = ['qwen3.5:4b', 'qwen3.5:9b', 'qwen3.5:27b', 'qwen3.5:35b', 'qwen3.5:122b'];
    const toCheck = new Set([...QWEN_SIZES, llm, 'bge-m3']);
    setLocalModelStatuses((prev) => {
      const next = { ...prev };
      for (const m of toCheck) {
        if (next[m] !== 'downloading' && next[m] !== 'testing') {
          next[m] = localModels.some((n) => n === m || n === `${m}:latest` || `${n}:latest` === `${m}:latest`) ? 'done' : 'queued';
        }
      }
      return next;
    });
  }, [localModels, settings?.llmModel]);

  // ─── Core callbacks ──────────────────────────────────────────
  const checkLlamaServer = useCallback(async () => {
    try {
      const status = await api.llamaStatus();
      setLlamaServerStatus({ running: status.running, port: status.port });
    } catch {
      setLlamaServerStatus({ running: false, port: null });
    }
  }, [api]);

  const checkLocal = useCallback(async () => {
    setLocalStatus('checking');
    try {
      // llama.cpp is bundled — always available
      setLocalInstallStage('already_installed');
      setLocalStatus('connected');
      const models = await api.listModels();
      setLocalModels(models);
    } catch {
      setLocalStatus('disconnected');
    }
  }, [api]);

  const checkCloud = useCallback(async () => {
    if (!settings?.cloudApiUrl || !settings?.cloudApiKey) {
      setCloudStatus('idle');
      setCloudModels([]);
      return;
    }
    setCloudStatus('checking');
    setCloudError(null);
    try {
      const result = await api.checkCloudApi(settings.cloudApiUrl, settings.cloudApiKey);
      setCloudStatus(result.ok ? 'connected' : 'error');
      setCloudError(result.ok ? null : (result.error || 'Connection failed'));
      if (result.ok) {
        try {
          const models = await api.listCloudModels(settings.cloudApiUrl, settings.cloudApiKey);
          setCloudModels(models);
        } catch {
          setCloudModels([]);
        }
      } else {
        setCloudModels([]);
      }
    } catch {
      setCloudStatus('error');
      setCloudError('Connection failed');
    }
  }, [api, settings?.cloudApiUrl, settings?.cloudApiKey]);

  const handleDownloadSenseVoice = useCallback(async () => {
    const force = svModelStatus === 'ready';
    setSvModelStatus('downloading');
    setSvDownloadProgress(0);
    setSvError(null);
    try {
      const result = await api.downloadSherpaModels(svMirror, force);
      if (result.success) {
        setSvModelStatus('ready');
        toast('success', s.sherpa_download_done);
      } else if (result.error === 'cancelled') {
        setSvModelStatus(force ? 'ready' : 'missing');
      } else {
        setSvModelStatus('error');
        setSvError(result.error || s.sherpa_download_fail);
        toast('error', s.sherpa_download_fail, result.error);
      }
    } catch (err: any) {
      setSvModelStatus('error');
      setSvError(err.message || s.sherpa_download_fail);
      toast('error', s.sherpa_download_fail, err.message);
    }
  }, [api, toast, svMirror, svModelStatus]);

  const handleCancelSenseVoice = useCallback(() => {
    api.cancelSherpaDownload();
    setSvModelStatus('missing');
  }, [api]);

  const handleInstallLocal = useCallback(async () => {
    setLocalInstallStage('downloading');
    const result = await api.installLocal();
    if (result.success) {
      setLocalInstallStage('already_installed');
      checkLocal();
    } else {
      setLocalInstallStage('error');
    }
  }, [api, checkLocal]);

  const handleLocalNotReady = useCallback(async () => {
    const installed = await api.isLocalInstalled();
    if (installed) {
      toast('info', s.local_connecting);
      await checkLocal();
      setLocalInstallStage('already_installed');
    } else {
      toast('info', s.local_auto_installing);
      handleInstallLocal();
    }
  }, [api, s, toast, checkLocal, handleInstallLocal]);

  const handlePullLocalModel = useCallback(async (modelName: string, force = false) => {
    setLocalModelStatuses((prev) => ({ ...prev, [modelName]: 'downloading' }));
    setLocalModelErrors((prev) => { const next = { ...prev }; delete next[modelName]; return next; });
    try {
      const result = await api.pullModel(modelName, force);
      if (result.success) {
        setLocalModelStatuses((prev) => ({ ...prev, [modelName]: 'done' }));
        checkLocal();
        return;
      }

      const isCancelled = result.error === 'cancelled';
      setLocalModelStatuses((prev) => ({
        ...prev,
        [modelName]: isCancelled ? 'queued' : 'error',
      }));
      if (!isCancelled && result.error) {
        setLocalModelErrors((prev) => ({ ...prev, [modelName]: result.error! }));
        toast('error', result.error);
      }
    } catch (err: any) {
      const msg = err.message || 'Unknown error';
      setLocalModelStatuses((prev) => ({ ...prev, [modelName]: 'error' }));
      setLocalModelErrors((prev) => ({ ...prev, [modelName]: msg }));
      toast('error', msg);
    }
  }, [api, toast, checkLocal]);

  const handleTestLocal = useCallback(async (modelName?: string) => {
    const model = modelName || settings?.llmModel || 'qwen3.5:4b';
    setLocalTesting(true);
    try {
      // Ensure llama-server is running
      const status = await api.llamaStatus();
      if (!status.running) {
        const result = await api.llamaStart();
        if (!result.success) {
          throw new Error(result.error || 'Failed to start llama-server');
        }
      }

      // Send test request — model name is specified in the request body
      const port = (await api.llamaStatus()).port;
      if (!port) throw new Error('llama-server port not available');

      // Convert model name to GGUF filename format (e.g. "qwen3.5:4b" → "Qwen3.5-4B-Q4_K_M")
      const modelMap: Record<string, string> = {
        'qwen3.5:4b': 'Qwen3.5-4B-Q4_K_M',
        'qwen3.5:9b': 'Qwen3.5-9B-Q4_K_M',
        'qwen3.5:27b': 'Qwen3.5-27B-Q4_K_M',
        'qwen3.5:35b': 'Qwen3.5-35B-A3B-Q4_K_M',
        'qwen3.5:122b': 'Qwen3.5-122B-A10B-Q4_K_M',
      };
      const apiModel = modelMap[model] || model;

      // Send a test request via the running server

      const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: apiModel,
          messages: [{ role: 'user', content: 'hi' }],
          max_tokens: 5,
          temperature: 0,
        }),
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      const data = await res.json();
      const msg = data.choices?.[0]?.message;
      const hasContent = msg?.content || msg?.reasoning_content;
      if (hasContent) {
        setLocalModelStatuses((prev) => ({ ...prev, [model]: 'done' }));
        setLocalModelErrors((prev) => { const next = { ...prev }; delete next[model]; return next; });
        setRecentlyTested(model);
        setTimeout(() => setRecentlyTested((prev) => prev === model ? null : prev), 3000);
      } else {
        throw new Error('Empty response from model');
      }
    } catch (err: any) {
      const msg = err?.message || 'Unknown error';
      setLocalModelStatuses((prev) => ({ ...prev, [model]: 'error' }));
      setLocalModelErrors((prev) => ({ ...prev, [model]: msg }));
      toast('error', msg);
    } finally {
      // Restore the selected model if we tested a different one
      if (model !== selectedModel) {
        try {
          await api.llamaStop();
          await api.llamaStart();
        } catch { /* best effort restore */ }
      }
      setLocalTesting(false);
    }
  }, [api, s, settings?.llmModel, toast, lang]);

  const handleCancelLocalPull = useCallback(() => {
    api.cancelPull();
  }, [api]);

  // ─── Loading state ───────────────────────────────────────────
  if (!settings) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-neutral-400 font-mono text-sm">{t.common.loading}</div>
      </div>
    );
  }

  // ─── Readiness computation ─────────────────────────────────
  const localReady = localStatus === 'connected';
  const llmModel = settings?.llmModel || 'qwen3.5:4b';
  const llmReady = settings?.llmProvider === 'openai'
    ? cloudStatus === 'connected'
    : settings?.llmProvider === 'local'
      ? localModelStatuses[llmModel] === 'done'  // Model downloaded = ready
      : localModels.some((n) => n === llmModel || n === `${llmModel}:latest` || `${n}:latest` === `${llmModel}:latest`);
  const sherpaReady = svModelStatus === 'ready';
  const engineReady = settings?.llmProvider === 'openai' ? true : settings?.llmProvider === 'local' ? true : localReady; // llama-server binary is always bundled
  const allReady = engineReady && llmReady && sherpaReady;
  const enginesHasIssue = !allReady;

  // ─── Ribbon click → tab + scroll ──────────────────────────
  const jumpTo = (target: 'local' | 'llm' | 'sherpa') => {
    setTab('engines');
    requestAnimationFrame(() => {
      const ref = target === 'sherpa' ? sherpaRef
                : target === 'llm' ? llmModelListRef
                : localRef;
      ref.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  };

  // Update readiness ribbon labels
  const engineLabel = settings?.llmProvider === 'local' ? 'AI 内核' : settings?.llmProvider === 'openai' ? '云端' : '本地引擎';

  // ─── Section props ─────────────────────────────────────────
  const sectionProps = {
    settings,
    s,
    updateField,
    localModels,
    localStatus,
    onCheckLocal: checkLocal,
    onTestLocal: handleTestLocal,
    localTesting,
    recentlyTested,
    cloudStatus,
    cloudError,
    cloudModels,
    onCheckCloud: checkCloud,
    svModelStatus,
    svDownloadProgress,
    svError,
    onDownloadSenseVoice: handleDownloadSenseVoice,
    onCancelSenseVoice: handleCancelSenseVoice,
    mirror: svMirror,
    onMirrorChange: setSvMirror,
    localInstallStage,
    localModelStatuses,
    localModelErrors,
    localModelProgress,
    onInstallLocal: handleInstallLocal,
    onPullLocalModel: handlePullLocalModel,
    onCancelLocalPull: handleCancelLocalPull,
    totalMemoryGB,
    onLocalNotReady: handleLocalNotReady,
    sherpaRef,
    llamaServerStatus,
    onCheckLlama: checkLlamaServer,
    localRef,
    llmModelListRef,
  };

  // ─── Render ──────────────────────────────────────────────────
  return (
    <div className="space-y-4">
      {/* ── System readiness ribbon (clickable when issue present) ── */}
      <div
        className="kz-paper flex items-center gap-6"
        style={{
          padding: '16px 22px',
          background: allReady ? 'var(--c-success-bg)' : 'var(--c-warn-bg)',
          borderColor: allReady ? 'oklch(0.85 0.06 150)' : 'oklch(0.86 0.07 75)',
        }}
      >
        <div className="kz-serif" style={{ fontSize: 16 }}>
          {allReady ? t.models.all_ready : t.models.readiness}
        </div>
        <div className="flex items-center gap-5">
          {([
            { key: 'local' as const, label: engineLabel,
              ready: engineReady },
            { key: 'llm',    label: 'AI 模型',    ready: llmReady },
            { key: 'sherpa', label: '语音引擎', ready: sherpaReady },
          ] as const).map(item => (
            <button
              key={item.label}
              onClick={() => !item.ready && jumpTo(item.key)}
              disabled={item.ready}
              className="flex items-center gap-1.5"
              style={{
                fontSize: 12.5,
                cursor: item.ready ? 'default' : 'pointer',
                background: 'transparent',
                border: 'none',
                padding: 0,
              }}
            >
              <span className={`kz-sdot ${item.ready ? 'kz-sdot--success' : 'kz-sdot--danger'}`} />
              <span
                className="kz-mono kz-text-soft"
                style={{
                  textDecoration: item.ready ? 'none' : 'underline',
                  textUnderlineOffset: 3,
                }}
              >
                {item.label}
              </span>
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2 ml-auto">
          {saved && <StatusBadge status="ok" label="auto-saved" />}
          <span className={`kz-badge ${allReady ? 'kz-badge--success' : 'kz-badge--warn'}`}>
            {allReady ? 'READY' : 'PARTIAL'}
          </span>
        </div>
      </div>

      {/* ── Sub tabs (pill style, matches Settings page) ── */}
      <div style={{ marginBottom: 22 }}>
        <div
          style={{
            display: 'inline-flex',
            gap: 4,
            padding: 4,
            border: '1px solid var(--line)',
            borderRadius: 10,
            background: 'var(--bg-card)',
            width: 'fit-content',
          }}
        >
          {([
            { key: 'engines',  label: t.models.tab_engines  || 'Engines',  icon: Cpu,     dot: enginesHasIssue },
            { key: 'behavior', label: t.models.tab_behavior || 'Behavior', icon: Sliders, dot: false },
            { key: 'advanced', label: t.models.tab_advanced || 'Advanced', icon: Wrench,  dot: false },
          ] as const).map((item) => {
            const Icon = item.icon;
            const on = tab === item.key;
            return (
              <button
                key={item.key}
                onClick={() => setTab(item.key)}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 7,
                  padding: '8px 16px',
                  borderRadius: 7,
                  fontSize: 12.5,
                  whiteSpace: 'nowrap',
                  background: on ? 'var(--c-accent)' : 'transparent',
                  color: on ? 'var(--c-accent-ink)' : 'var(--ink-soft)',
                  border: 0,
                  cursor: 'pointer',
                  transition: 'background 0.14s, color 0.14s',
                  position: 'relative',
                }}
              >
                <Icon size={13} />
                {item.label}
                {item.dot && (
                  <span
                    aria-label="has issues"
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: '50%',
                      background: on ? 'var(--c-accent-ink)' : 'var(--c-danger)',
                      marginLeft: 2,
                      flexShrink: 0,
                    }}
                  />
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* ── Tab content ── */}
      <div>
        {tab === 'engines' && <EnginesSection {...sectionProps} />}
        {tab === 'behavior' && <BehaviorSection {...sectionProps} />}
        {tab === 'advanced' && <AdvancedSection {...sectionProps} />}
      </div>
    </div>
  );
}
