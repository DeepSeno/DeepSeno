import { useEffect, useState } from 'react';
import { Cpu, FolderOpen } from 'lucide-react';
import { CollapsibleCard } from '../../../components/settings';
import { useApi } from '../../../hooks/useApi';
import type { ModelsSectionProps } from './types';

type PromptKey =
  | 'imageAnalysis'
  | 'videoAnalysis'
  | 'infoExtract'
  | 'classify'
  | 'memoryExtract'
  | 'textClean'
  | 'dailySummary';

export default function AdvancedSection({ settings, s, updateField }: ModelsSectionProps) {
  const api = useApi();
  const [defaults, setDefaults] = useState<Record<string, string>>({});
  const [activePrompt, setActivePrompt] = useState<PromptKey>('imageAnalysis');

  useEffect(() => {
    // `getDefaultPrompts` is exposed at runtime via preload but missing from
    // VoiceBrainApi typings — same pattern as the prior AIEngineSection usage.
    (api as any).getDefaultPrompts?.().then(setDefaults).catch(() => {});
  }, []);

  const PROMPTS: { key: PromptKey; label: string }[] = [
    { key: 'imageAnalysis', label: s.prompt_imageAnalysis },
    { key: 'videoAnalysis', label: s.prompt_videoAnalysis },
    { key: 'infoExtract',   label: s.prompt_infoExtract },
    { key: 'classify',      label: s.prompt_classify },
    { key: 'memoryExtract', label: s.prompt_memoryExtract },
    { key: 'textClean',     label: s.prompt_textClean },
    { key: 'dailySummary',  label: s.prompt_dailySummary },
  ];

  const pipelinePrompts = (settings as any).pipelinePrompts as Record<string, string> | undefined;
  const saved = pipelinePrompts?.[activePrompt] || '';
  const displayValue = saved || defaults[activePrompt] || '';
  const isCustom = !!saved && saved !== defaults[activePrompt];

  const writePrompt = (key: PromptKey, value: string) => {
    const pp = { ...(pipelinePrompts || {}), [key]: value };
    updateField({ pipelinePrompts: pp } as any);
  };

  return (
    <div className="space-y-4">
      {/* ── Pipeline Prompts (vertical tab + textarea) ── */}
      <CollapsibleCard title={s.pipeline_prompts || 'Pipeline Prompts'} icon={Cpu}>
        <p className="kz-text-mute mb-3" style={{ fontSize: 12 }}>{s.pipeline_prompts_desc}</p>

        <div className="flex gap-3" style={{ minHeight: 480 }}>
          {/* Left: vertical tab list */}
          <div className="flex-shrink-0 flex flex-col gap-1" style={{ width: 180 }}>
            {PROMPTS.map((p) => {
              const ps = pipelinePrompts?.[p.key] || '';
              const customized = !!ps && ps !== defaults[p.key];
              const isOn = activePrompt === p.key;
              return (
                <button
                  key={p.key}
                  onClick={() => setActivePrompt(p.key)}
                  className="text-left kz-serif-italic"
                  style={{
                    padding: '8px 12px',
                    borderRadius: 6,
                    fontSize: 12.5,
                    background: isOn ? 'var(--bg-elev)' : 'transparent',
                    color: isOn ? 'var(--ink)' : 'var(--ink-soft)',
                    border: `1px solid ${isOn ? 'var(--line-strong)' : 'transparent'}`,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 6,
                    cursor: 'pointer',
                  }}
                >
                  <span className="truncate">{p.label}</span>
                  {customized && (
                    <span
                      style={{
                        background: 'var(--c-accent)',
                        width: 6,
                        height: 6,
                        borderRadius: '50%',
                        flexShrink: 0,
                      }}
                      title={s.prompt_customized || 'Customized'}
                    />
                  )}
                </button>
              );
            })}
          </div>

          {/* Right: textarea + reset */}
          <div className="flex-1 flex flex-col min-w-0">
            <div className="flex items-center justify-between mb-2">
              <label className="kz-serif-italic kz-text-soft" style={{ fontSize: 12.5 }}>
                {PROMPTS.find((p) => p.key === activePrompt)?.label}
              </label>
              {isCustom && (
                <button
                  onClick={() => writePrompt(activePrompt, '')}
                  className="kz-btn kz-btn--sm kz-btn--ghost"
                >
                  {s.prompt_reset || 'Reset'}
                </button>
              )}
            </div>
            <textarea
              className="flex-1 kz-mono kz-text-ink resize-none"
              style={{
                background: 'var(--bg-elev)',
                border: '1px solid var(--line)',
                borderRadius: 8,
                padding: '10px 12px',
                fontSize: 12,
                outline: 'none',
                minHeight: 440,
              }}
              value={displayValue}
              onChange={(e) => writePrompt(activePrompt, e.target.value)}
            />
          </div>
        </div>
      </CollapsibleCard>

      {/* ── Infrastructure (open models dir) ── */}
      <CollapsibleCard title={s.infrastructure || 'Infrastructure'} icon={FolderOpen}>
        <div
          className="flex items-center justify-between"
          style={{
            padding: '6px 0',
          }}
        >
          <div>
            <div className="kz-serif-italic kz-text-soft" style={{ fontSize: 12.5 }}>
              {s.model_storage}
            </div>
            <div className="kz-text-mute" style={{ fontSize: 11 }}>
              {s.model_storage_desc}
            </div>
          </div>
          <button onClick={() => api.openLocalModelsDir()} className="kz-btn kz-btn--sm">
            <FolderOpen size={12} />
            {s.open_directory}
          </button>
        </div>
      </CollapsibleCard>
    </div>
  );
}
