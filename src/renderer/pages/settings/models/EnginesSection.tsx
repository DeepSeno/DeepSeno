import { useEffect, useMemo } from 'react';
import {
  Cpu,
  RefreshCw,
  Download,
  CheckCircle2,
  XCircle,
  Loader2,
} from 'lucide-react';
import { CollapsibleCard, FieldRow } from '../../../components/settings';
import ModelCombobox from '../../../components/ModelCombobox';
import Select from '../../../components/Select';
import { useI18n } from '../../../i18n';
import type { ModelsSectionProps } from './types';
import { getLocalModelTestButtonClass } from './local-model-test';
import { toSelectableModelId } from './model-status';

function toPercent(completed: number, total: number): number {
  if (!total || total <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round((completed / total) * 100)));
}

interface CloudPreset {
  id: string;
  name: string;
  nameEn?: string;
  url: string;
  models: string[];
  embedModels: string[];
}

const CLOUD_PRESETS: CloudPreset[] = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    nameEn: 'DeepSeek',
    url: 'https://api.deepseek.com',
    models: [],
    embedModels: [],
  },
  {
    id: 'volcengine',
    name: '火山引擎 CodePlan (Volcengine)',
    nameEn: 'Volcengine CodePlan',
    url: 'https://ark.cn-beijing.volces.com/api/coding/v3',
    models: ['ark-code-latest'],
    embedModels: [],
  },
];

type ModelArch = 'dense' | 'moe';
interface ModelCatalogEntry {
  name: string;
  fileGB: number;
  runGB: number;
  perf: number;
  arch: ModelArch;
}

const MODEL_CATALOG: ModelCatalogEntry[] = [
  { name: 'qwen3.5:4b',   fileGB: 2.7, runGB: 6,  perf: 70, arch: 'dense' },
  { name: 'qwen3.5:9b',   fileGB: 5.7, runGB: 10, perf: 78, arch: 'dense' },
  { name: 'qwen3.5:27b',  fileGB: 16.8, runGB: 22, perf: 86, arch: 'dense' },
  { name: 'qwen3.5:35b',  fileGB: 22.0, runGB: 30, perf: 85, arch: 'moe' },
];

const SYSTEM_OVERHEAD_GB = 6;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export default function EnginesSection(props: ModelsSectionProps) {
  const {
    settings,
    s,
    updateField,
    cloudStatus,
    cloudError,
    cloudModels,
    onCheckCloud,
    svModelStatus,
    svDownloadProgress,
    svError,
    onDownloadSenseVoice,
    onCancelSenseVoice,
    localInstallStage,
    localModelStatuses,
    localModelErrors,
    localModelProgress,
    onPullLocalModel,
    onCancelLocalPull,
    onTestLocal,
    localTesting,
    recentlyTested,
    totalMemoryGB,
    onLocalNotReady,
    sherpaRef,
    localRef,
    llmModelListRef,
  } = props;

  const { lang } = useI18n();
  const isLocalMode = (settings.llmProvider || 'local') === 'local';
  const isCloudMode = settings.llmProvider === 'openai';

  const availableForModel = totalMemoryGB > 0 ? totalMemoryGB - SYSTEM_OVERHEAD_GB : 0;
  const bestModelName = totalMemoryGB > 0
    ? (MODEL_CATALOG.filter((m) => m.runGB <= availableForModel)
        .sort((a, b) => b.perf - a.perf)[0]?.name || MODEL_CATALOG[0].name)
    : '';

  const MODEL_SIZES: Record<string, string> = Object.fromEntries(
    MODEL_CATALOG.map((m) => [m.name, `~${m.fileGB} GB`]),
  );

  const activePreset = useMemo(
    () => {
      if (settings.cloudPresetId) {
        return CLOUD_PRESETS.find((p) => p.id === settings.cloudPresetId) || null;
      }
      return CLOUD_PRESETS.find((p) => p.url === settings.cloudApiUrl) || null;
    },
    [settings.cloudPresetId, settings.cloudApiUrl],
  );
  const cloudEmbedModelValue = settings.cloudEmbedModel || settings.cloudModel || '';
  const cloudEmbedSuggestions = [
    ...new Set([
      ...(activePreset?.embedModels || []),
      ...(settings.cloudModel ? [settings.cloudModel] : []),
      ...cloudModels,
    ]),
  ];

  const rawLlmModel = settings.llmModel || 'qwen3.5:4b';
  const llmModel = toSelectableModelId(rawLlmModel);
  const runtimeReady = localInstallStage === 'already_installed';

  useEffect(() => {
    if (rawLlmModel !== llmModel) {
      updateField({ llmModel });
    }
  }, [llmModel, rawLlmModel, updateField]);

  type ModelListItem = { name: string; size: string; tag?: 'recommended' | 'caution'; arch?: ModelArch; perf?: number };
  const llmListItems: ModelListItem[] = MODEL_CATALOG.map((m) => {
    let tag: ModelListItem['tag'];
    if (totalMemoryGB > 0) {
      if (m.name === bestModelName) tag = 'recommended';
      else if (m.runGB > availableForModel) tag = 'caution';
    }
    return { name: m.name, size: `~${m.fileGB} GB`, tag, arch: m.arch, perf: m.perf };
  });

  if (llmModel && !llmListItems.some((m) => m.name === llmModel)) {
    llmListItems.push({ name: llmModel, size: MODEL_SIZES[llmModel] || '~? GB' });
  }

  return (
    <div className="space-y-4">
      {/* ── Speech Recognition (ASR) ── */}
      <div ref={sherpaRef}>
        <CollapsibleCard title={s.whisper_model} icon={Cpu}>
          <FieldRow
            label={s.whisper_model}
            hint={
              svModelStatus === 'ready'
                ? s.sherpa_model_ready
                : svModelStatus === 'missing'
                  ? s.sherpa_not_downloaded
                  : svModelStatus === 'error'
                    ? (svError || s.sherpa_download_failed)
                    : undefined
            }
          >
            <div className="flex items-center gap-2">
              {svModelStatus === 'ready' && <span className="kz-sdot kz-sdot--success flex-shrink-0" />}
              {svModelStatus === 'missing' && <span className="kz-sdot kz-sdot--warn flex-shrink-0" />}
              {svModelStatus === 'error' && <span className="kz-sdot kz-sdot--danger flex-shrink-0" />}
              {svModelStatus === 'checking' && <Loader2 size={13} className="animate-spin kz-text-mute flex-shrink-0" />}
              <span className="kz-mono kz-text-ink" style={{ fontSize: 13 }}>SenseVoice Small</span>
            </div>
          </FieldRow>

          {/* SenseVoice download controls */}
          {settings.whisperModel === 'sensevoice' && svModelStatus !== 'checking' && (
            <div className="pl-2 py-1 space-y-2">
              {svModelStatus === 'downloading' && (
                <div className="flex items-center gap-3 w-full">
                  <Loader2 size={13} className="animate-spin flex-shrink-0" style={{ color: 'var(--c-info)' }} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between mb-1">
                      <span className="kz-mono kz-badge kz-badge--info">{svDownloadProgress}%</span>
                    </div>
                    <div className="overflow-hidden" style={{ background: 'var(--bg-elev)', height: 4, borderRadius: 999 }}>
                      <div
                        className="h-full transition-all duration-500"
                        style={{ width: `${svDownloadProgress}%`, background: 'var(--c-accent)' }}
                      />
                    </div>
                  </div>
                  <button onClick={onCancelSenseVoice} className="kz-btn kz-btn--sm flex-shrink-0">
                    <XCircle size={12} />
                    {s.cancel}
                  </button>
                </div>
              )}

              {svModelStatus !== 'downloading' && (
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2 kz-text-mute" style={{ fontSize: 11.5 }}>
                    <span className="kz-serif-italic flex-shrink-0">{s.download_source}</span>
                    <span className="kz-badge kz-badge--info kz-mono">{s.source_modelscope}</span>
                  </div>
                  <button onClick={onDownloadSenseVoice} className="kz-btn kz-btn--sm flex-shrink-0">
                    {svModelStatus === 'error' ? <RefreshCw size={12} /> : <Download size={12} />}
                    {svModelStatus === 'ready'
                      ? s.redownload
                      : svModelStatus === 'error'
                        ? s.retry
                        : s.download}
                  </button>
                </div>
              )}
            </div>
          )}
        </CollapsibleCard>
      </div>

      {/* ── LLM Engine (provider toggle + config + local ops) ── */}
      <div ref={localRef}>
        <CollapsibleCard title={s.llm_provider} icon={Cpu}>
          {/* Provider toggle */}
          <FieldRow label={s.llm_provider}>
            <div className="kz-tabs">
              <button
                onClick={() => updateField({ llmProvider: 'local' })}
                className={isLocalMode ? 'is-on' : ''}
                style={{ fontSize: 11, padding: '5px 11px' }}
              >
                {s.provider_local}
              </button>
              <button
                onClick={() => updateField({ llmProvider: 'openai' })}
                className={isCloudMode ? 'is-on' : ''}
                style={{ fontSize: 11, padding: '5px 11px' }}
              >
                {s.provider_cloud}
              </button>
            </div>
          </FieldRow>

          {isCloudMode ? (
            /* ── Cloud mode ── */
            <>
              <FieldRow label={s.cloud_provider} hint={s.cloud_provider_hint}>
                <Select
                  value={activePreset?.id || '_custom'}
                  className="kz-mono max-w-md"
                  ariaLabel={s.cloud_provider}
                  options={[
                    ...CLOUD_PRESETS.map((p) => {
                      const hasSaved = !!(settings.cloudProviderConfigs || {})[p.id];
                      const displayName = lang === 'en' && p.nameEn ? p.nameEn : p.name;
                      return { value: p.id, label: `${displayName}${hasSaved ? ' ✓' : ''}` };
                    }),
                    { value: '_custom', label: s.cloud_custom },
                  ]}
                  onChange={(newPresetId) => {
                    const preset = CLOUD_PRESETS.find((p) => p.id === newPresetId);
                    const configs = { ...(settings.cloudProviderConfigs || {}) };

                    const oldId = settings.cloudPresetId || activePreset?.id || '_custom';
                    if (settings.cloudApiUrl || settings.cloudApiKey || settings.cloudModel) {
                      configs[oldId] = {
                        url: settings.cloudApiUrl || '',
                        apiKey: settings.cloudApiKey || '',
                        model: settings.cloudModel || '',
                        embedModel: settings.cloudEmbedModel || '',
                      };
                    }

                    const saved = configs[newPresetId];
                    if (saved) {
                      updateField({
                        cloudPresetId: newPresetId === '_custom' ? '' : newPresetId,
                        cloudProviderConfigs: configs,
                        cloudApiUrl: saved.url,
                        cloudApiKey: saved.apiKey,
                        cloudModel: saved.model,
                        cloudEmbedModel: saved.embedModel,
                      });
                    } else if (preset) {
                      updateField({
                        cloudPresetId: newPresetId,
                        cloudProviderConfigs: configs,
                        cloudApiUrl: preset.url,
                        cloudApiKey: '',
                        cloudModel: '',
                        cloudEmbedModel: '',
                      });
                    } else {
                      updateField({
                        cloudPresetId: '',
                        cloudProviderConfigs: configs,
                        cloudApiUrl: '',
                        cloudApiKey: '',
                        cloudModel: '',
                        cloudEmbedModel: '',
                      });
                    }
                  }}
                />
              </FieldRow>

              <FieldRow
                label={s.cloud_api_url}
                hint={activePreset ? undefined : s.cloud_api_url_hint}
              >
                {activePreset ? (
                  <span className="kz-mono kz-text-mute truncate max-w-md" style={{ fontSize: 12 }}>
                    {settings.cloudApiUrl}
                  </span>
                ) : (
                  <input
                    type="text"
                    value={settings.cloudApiUrl || ''}
                    onChange={(e) => updateField({ cloudApiUrl: e.target.value })}
                    placeholder="https://api.example.com/v1"
                    className="kz-input kz-mono max-w-md w-full"
                  />
                )}
              </FieldRow>

              <FieldRow label={s.cloud_api_key}>
                <div className="flex items-center gap-2 max-w-md w-full">
                  <input
                    type="password"
                    value={settings.cloudApiKey || ''}
                    onChange={(e) => updateField({ cloudApiKey: e.target.value })}
                    onBlur={onCheckCloud}
                    placeholder="sk-..."
                    className="kz-input kz-mono flex-1"
                    style={{ letterSpacing: 1 }}
                  />
                  <button
                    onClick={onCheckCloud}
                    disabled={cloudStatus === 'checking'}
                    className={`kz-btn kz-btn--sm flex-shrink-0 ${cloudStatus === 'checking' ? 'opacity-50' : ''}`}
                  >
                    {cloudStatus === 'checking' ? (
                      <Loader2 size={12} className="animate-spin" />
                    ) : (
                      <RefreshCw size={12} />
                    )}
                    {s.test}
                  </button>
                </div>
                {cloudStatus !== 'idle' && cloudStatus !== 'checking' && (
                  <span
                    className={`kz-badge flex items-center gap-1 mt-1 ${
                      cloudStatus === 'connected' ? 'kz-badge--success' : 'kz-badge--danger'
                    }`}
                  >
                    <span className={`kz-sdot ${cloudStatus === 'connected' ? 'kz-sdot--success' : 'kz-sdot--danger'}`} />
                    {cloudStatus === 'connected'
                      ? s.cloud_connected_label
                      : (cloudError || s.cloud_conn_failed)}
                  </span>
                )}
              </FieldRow>

              <FieldRow label={s.cloud_model} hint={s.cloud_model_hint}>
                <div className="max-w-md w-full">
                  <ModelCombobox
                    value={settings.cloudModel || ''}
                    onChange={(v) => updateField({ cloudModel: v })}
                    suggestions={[...new Set([...(activePreset?.models || []), ...cloudModels])]}
                    placeholder={s.cloud_model_placeholder}
                  />
                </div>
              </FieldRow>

              <FieldRow label={s.cloud_embed_model} hint={s.cloud_embed_model_hint}>
                <div className="max-w-md w-full">
                  <ModelCombobox
                    value={cloudEmbedModelValue}
                    onChange={(v) => updateField({ cloudEmbedModel: v === settings.cloudModel ? '' : v })}
                    suggestions={cloudEmbedSuggestions}
                    placeholder={settings.cloudModel || s.cloud_model_placeholder}
                  />
                </div>
              </FieldRow>
            </>
          ) : (
            /* ── Local (llama.cpp) mode ── */
            <>
              {/* Inline model list */}
              <div ref={llmModelListRef} className="kz-paper mt-1 overflow-hidden" style={{ padding: 0 }}>
                {/* LLM model rows */}
                {llmListItems.map((model) => {
                  const status = localModelStatuses[model.name] || 'queued';
                  const prog = localModelProgress[model.name];
                  const pct = prog && prog.total > 0 ? toPercent(prog.completed, prog.total) : 0;
                  const isSelected = model.name === llmModel;
                  const isDownloading = status === 'downloading';
                  const isTesting = status === 'testing';

                  return (
                    <div
                      key={model.name}
                      style={{
                        borderBottom: '1px solid var(--line-soft)',
                        position: 'relative',
                      }}
                    >
                      <div className="flex items-center gap-3" style={{ padding: '10px 14px' }}>
                        <button onClick={() => updateField({ llmModel: model.name })} className="flex-shrink-0">
                          <div
                            style={{
                              width: 12,
                              height: 12,
                              borderRadius: '50%',
                              border: `2px solid ${isSelected ? 'var(--ink)' : 'var(--line-strong)'}`,
                              background: isSelected ? 'var(--ink)' : 'var(--bg-card)',
                              transition: 'all 0.14s',
                            }}
                          />
                        </button>

                        <div className="flex-1 min-w-0 flex items-center gap-1.5">
                          <span
                            className={`kz-mono truncate ${
                              isSelected ? 'kz-text-ink' : model.tag === 'caution' ? 'kz-text-mute' : 'kz-text-soft'
                            }`}
                            style={{ fontSize: 12.5, fontWeight: isSelected ? 500 : 400 }}
                          >
                            {model.name.replace('qwen3.5:', 'Qwen3.5 ')} GGUF
                          </span>
                          <span className="kz-mono kz-text-faint flex-shrink-0" style={{ fontSize: 11 }}>{model.size}</span>
                          {model.arch === 'moe' && (
                            <span className="kz-badge kz-badge--mute" title={s.moe_tooltip}>MoE</span>
                          )}
                          {model.tag === 'recommended' && (
                            <span className="kz-badge kz-badge--accent flex-shrink-0">{s.model_recommended}</span>
                          )}
                          {model.tag === 'caution' && (
                            <span
                              className="kz-badge kz-badge--warn flex-shrink-0"
                              title={`~${MODEL_CATALOG.find((c) => c.name === model.name)?.runGB} GB RAM`}
                            >
                              {s.model_low_ram}
                            </span>
                          )}
                        </div>

                        <div className="flex items-center gap-2 flex-shrink-0">
                          {status === 'done' && (
                            <>
                              <span className="kz-badge kz-badge--success flex items-center gap-1">
                                <CheckCircle2 size={11} />
                                {s.model_ready}
                              </span>
                              <button
                                onClick={() => onTestLocal(model.name)}
                                disabled={localTesting}
                                className={getLocalModelTestButtonClass(model.name, recentlyTested, localTesting)}
                              >
                                {localTesting ? (
                                  <Loader2 size={11} className="animate-spin" />
                                ) : recentlyTested === model.name ? (
                                  <CheckCircle2 size={11} />
                                ) : (
                                  <RefreshCw size={11} />
                                )}
                                {s.test}
                              </button>
                            </>
                          )}
                          {isDownloading && (
                            <span className="kz-badge kz-badge--info flex items-center gap-1">
                              <Loader2 size={11} className="animate-spin" />
                              {pct > 0 ? `${pct}%` : s.model_pulling}
                            </span>
                          )}
                          {isTesting && (
                            <span className="kz-badge kz-badge--info flex items-center gap-1">
                              <Loader2 size={11} className="animate-spin" />
                              {s.model_smoke_testing}
                            </span>
                          )}
                          {status === 'error' && (
                            <span
                              className="kz-badge kz-badge--danger flex items-center gap-1 max-w-[200px] truncate"
                              title={localModelErrors[model.name] || ''}
                            >
                              <XCircle size={11} className="shrink-0" />
                              {localModelErrors[model.name]
                                ? localModelErrors[model.name].slice(0, 40)
                                : s.model_failed}
                            </span>
                          )}
                          {isDownloading ? (
                            <button onClick={() => onCancelLocalPull(model.name)} className="kz-btn kz-btn--sm">
                              <XCircle size={11} />
                              {s.cancel}
                            </button>
                          ) : status !== 'done' ? (
                            <button
                              disabled={isTesting}
                              onClick={() => runtimeReady ? onPullLocalModel(model.name) : onLocalNotReady?.()}
                              className={`kz-btn kz-btn--sm${isTesting ? ' opacity-50' : ''}`}
                            >
                              <Download size={11} />
                              {s.model_pull}
                            </button>
                          ) : (
                            <button
                              onClick={() => runtimeReady ? onPullLocalModel(model.name, true) : onLocalNotReady?.()}
                              className="kz-btn kz-btn--sm"
                            >
                              <RefreshCw size={11} />
                              {s.redownload}
                            </button>
                          )}
                        </div>
                      </div>

                      {isDownloading && (
                        <div
                          style={{
                            position: 'absolute',
                            bottom: 0,
                            left: 0,
                            right: 0,
                            height: 2,
                            background: 'var(--bg-elev)',
                          }}
                          title={
                            prog && prog.total > 0
                              ? `${formatBytes(prog.completed)} / ${formatBytes(prog.total)}`
                              : ''
                          }
                        >
                          <div
                            className="h-full transition-all duration-300"
                            style={{ width: `${pct}%`, background: 'var(--c-accent)' }}
                          />
                        </div>
                      )}
                    </div>
                  );
                })}

                {/* bge-m3 embed model row */}
                {(() => {
                  const embedStatus = localModelStatuses['bge-m3'] || 'queued';
                  const embedProg = localModelProgress['bge-m3'];
                  const embedPct = embedProg && embedProg.total > 0 ? toPercent(embedProg.completed, embedProg.total) : 0;
                  const isDownloading = embedStatus === 'downloading';
                  const isTesting = embedStatus === 'testing';
                  return (
                    <div style={{ borderTop: '1px solid var(--line)', position: 'relative' }}>
                      <div className="flex items-center gap-3" style={{ padding: '10px 14px' }}>
                        <div className="w-3 h-3 flex-shrink-0" />
                        <div className="flex-1 min-w-0 flex items-center gap-2">
                          <span className="kz-mono kz-text-soft truncate" style={{ fontSize: 12.5 }}>bge-m3</span>
                          <span className="kz-mono kz-text-faint flex-shrink-0" style={{ fontSize: 11 }}>~0.63 GB</span>
                          <span className="kz-badge kz-badge--violet">embed</span>
                        </div>
                        <div className="flex items-center gap-2 flex-shrink-0">
                          {embedStatus === 'done' && (
                            <span className="kz-badge kz-badge--success flex items-center gap-1">
                              <CheckCircle2 size={11} />
                              {s.model_ready}
                            </span>
                          )}
                          {isDownloading && (
                            <span className="kz-badge kz-badge--info flex items-center gap-1">
                              <Loader2 size={11} className="animate-spin" />
                              {embedPct > 0 ? `${embedPct}%` : s.model_pulling}
                            </span>
                          )}
                          {isTesting && (
                            <span className="kz-badge kz-badge--info flex items-center gap-1">
                              <Loader2 size={11} className="animate-spin" />
                              {s.model_smoke_testing}
                            </span>
                          )}
                          {embedStatus === 'error' && (
                            <span
                              className="kz-badge kz-badge--danger flex items-center gap-1 max-w-[200px] truncate"
                              title={localModelErrors['bge-m3'] || ''}
                            >
                              <XCircle size={11} className="shrink-0" />
                              {localModelErrors['bge-m3']
                                ? localModelErrors['bge-m3'].slice(0, 40)
                                : s.model_failed}
                            </span>
                          )}
                          {isDownloading ? (
                            <button onClick={() => onCancelLocalPull('bge-m3')} className="kz-btn kz-btn--sm">
                              <XCircle size={11} />
                              {s.cancel}
                            </button>
                          ) : embedStatus !== 'done' ? (
                            <button
                              disabled={isTesting}
                              onClick={() => runtimeReady ? onPullLocalModel('bge-m3') : onLocalNotReady?.()}
                              className={`kz-btn kz-btn--sm${isTesting ? ' opacity-50' : ''}`}
                            >
                              <Download size={11} />
                              {s.model_pull}
                            </button>
                          ) : (
                            <button
                              onClick={() => runtimeReady ? onPullLocalModel('bge-m3', true) : onLocalNotReady?.()}
                              className="kz-btn kz-btn--sm"
                            >
                              <RefreshCw size={11} />
                              {s.redownload}
                            </button>
                          )}
                        </div>
                      </div>
                      {isDownloading && (
                        <div
                          style={{
                            position: 'absolute',
                            bottom: 0,
                            left: 0,
                            right: 0,
                            height: 2,
                            background: 'var(--bg-elev)',
                          }}
                          title={
                            embedProg && embedProg.total > 0
                              ? `${formatBytes(embedProg.completed)} / ${formatBytes(embedProg.total)}`
                              : ''
                          }
                        >
                          <div
                            className="h-full transition-all duration-300"
                            style={{ width: `${embedPct}%`, background: 'var(--c-accent)' }}
                          />
                        </div>
                      )}
                    </div>
                  );
                })()}
              </div>
            </>
          )}
        </CollapsibleCard>
      </div>
    </div>
  );
}
