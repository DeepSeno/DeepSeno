import { useState, useCallback, useRef } from 'react';
import { useI18n, Lang } from '../../i18n';
import { useApi } from '../../hooks/useApi';
import StepWelcome from './StepWelcome';
import StepDirectories from './StepDirectories';
import StepModels from './StepModels';
import StepComplete from './StepComplete';

const TOTAL_STEPS = 4;

interface Props {
  onComplete: () => void;
  defaultOutputDir: string;
  defaultWatchDir: string;
}

export default function SetupWizard({ onComplete, defaultOutputDir, defaultWatchDir }: Props) {
  const { t, lang, setLang } = useI18n();
  const api = useApi();
  const w = t.wizard;

  function toggleLang() {
    const next: Lang = lang === 'en' ? 'zh' : 'en';
    setLang(next);
    api.updateSettings({ language: next });
  }

  const stepLabels = lang === 'zh'
    ? ['欢迎', '目录', '模型', '完成']
    : ['Welcome', 'Dirs', 'Models', 'Done'];
  const [step, setStep] = useState(1);
  const [watchDir, setWatchDir] = useState(defaultWatchDir);
  const [outputDir, setOutputDir] = useState(defaultOutputDir);

  // Model download state
  const [canProceedModels, setCanProceedModels] = useState(false);
  const recommendedModelRef = useRef<string>('');

  const handleModelsReady = useCallback((_models: string[]) => {
    setCanProceedModels(true);
  }, []);

  const handleRecommendedModel = useCallback((model: string) => {
    recommendedModelRef.current = model;
  }, []);

  function canGoNext(): boolean {
    switch (step) {
      case 1: return true;
      case 2: return !!watchDir;
      case 3: return canProceedModels;
      case 4: return true;
      default: return false;
    }
  }

  function goNext() {
    if (step < TOTAL_STEPS && canGoNext()) setStep(step + 1);
  }

  function goPrev() {
    if (step > 1) setStep(step - 1);
  }

  function goToStep(target: number) {
    // Allow going back to any previous step
    if (target < step) setStep(target);
  }

  async function handleFinish() {
    const updates: Record<string, unknown> = {
      setupComplete: true,
      watchDir,
      outputDir,
    };
    // Persist recommended model selection
    if (recommendedModelRef.current) {
      updates.llmModel = recommendedModelRef.current;
      updates.embedModel = 'bge-m3';
    }
    await api.updateSettings(updates as any);
    onComplete();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center kz-wizard-bg">
      <div
        className="kz-paper w-[680px] flex flex-col overflow-hidden kz-anim-in"
        style={{ borderRadius: 'var(--radius-lg)', maxHeight: '90vh' }}
      >
        {/* Progress bar */}
        <div
          className="w-full"
          style={{ height: 2, background: 'var(--bg-elev)' }}
        >
          <div
            className="h-full transition-all duration-300"
            style={{ width: `${(step / TOTAL_STEPS) * 100}%`, background: 'var(--c-accent)' }}
          />
        </div>

        {/* Step indicators + language toggle */}
        <div className="flex items-center px-8 pt-5 pb-2">
          <div className="flex-1" />
          <div className="flex items-center gap-2">
            {stepLabels.map((label, i) => {
              const s = i + 1;
              return (
                <button
                  key={s}
                  onClick={() => goToStep(s)}
                  disabled={s >= step}
                  className="flex items-center gap-2"
                >
                  <div className="flex flex-col items-center gap-1">
                    <span
                      className={
                        s < step
                          ? 'kz-sdot kz-sdot--success'
                          : s === step
                            ? 'kz-sdot kz-sdot--accent'
                            : 'kz-sdot kz-sdot--mute'
                      }
                    />
                    <span
                      className={s === step ? 'kz-serif-italic' : 'kz-mono'}
                      style={{
                        fontSize: s === step ? '10.5px' : '9.5px',
                        color: s === step ? 'var(--ink)' : 'var(--ink-mute)',
                        letterSpacing: s === step ? 0 : '0.04em',
                        textTransform: s === step ? 'none' : 'uppercase',
                      }}
                    >
                      {label}
                    </span>
                  </div>
                  {s < TOTAL_STEPS && (
                    <div
                      className="w-6 mb-3"
                      style={{
                        height: 1,
                        background: s < step ? 'var(--c-success)' : 'var(--line)',
                      }}
                    />
                  )}
                </button>
              );
            })}
          </div>
          <div className="flex-1 flex justify-end">
            <button
              onClick={toggleLang}
              className="kz-btn kz-btn--sm kz-mono"
            >
              {lang === 'en' ? '中文' : 'EN'}
            </button>
          </div>
        </div>

        {/* Step content */}
        {step === 1 && <StepWelcome onNext={goNext} />}
        {step === 2 && (
          <StepDirectories
            watchDir={watchDir}
            outputDir={outputDir}
            onWatchDir={setWatchDir}
            onOutputDir={setOutputDir}
          />
        )}
        {step === 3 && (
          <StepModels
            onModelsReady={handleModelsReady}
            onSkip={() => { setCanProceedModels(true); setStep(4); }}
            onRecommendedModel={handleRecommendedModel}
          />
        )}
        {step === 4 && <StepComplete onFinish={handleFinish} />}

        {/* Navigation buttons (steps 2 and 3) */}
        {(step === 2 || step === 3) && (
          <div
            className="flex justify-between px-8 pb-6 pt-3"
            style={{ borderTop: '1px solid var(--line-soft)' }}
          >
            <button
              onClick={goPrev}
              className="kz-btn kz-btn--ghost"
            >
              ← {w.prev}
            </button>
            <div className="flex items-center gap-3">
              {step === 3 && !canProceedModels && (
                <button
                  onClick={() => { setCanProceedModels(true); setStep(4); }}
                  className="kz-btn kz-btn--ghost kz-text-mute"
                  style={{ fontSize: '11px' }}
                >
                  {w.model_skip}
                </button>
              )}
              <button
                onClick={goNext}
                disabled={!canGoNext()}
                className="kz-btn kz-btn--primary disabled:opacity-30 disabled:cursor-not-allowed"
              >
                {step === 3 ? w.next : w.next} →
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
