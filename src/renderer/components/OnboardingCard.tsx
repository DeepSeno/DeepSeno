import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CheckCircle2, Circle, X, ArrowRight } from 'lucide-react';
import { useI18n } from '../i18n';

interface OnboardingCardProps {
  recordingCount: number;
  sessionCount: number;
}

export function OnboardingCard({ recordingCount, sessionCount }: OnboardingCardProps) {
  const { t } = useI18n();
  const navigate = useNavigate();

  const [dismissed, setDismissed] = useState(
    () => localStorage.getItem('onboarding_dismissed') === 'true'
  );

  if (dismissed) return null;

  const steps = [
    { done: recordingCount > 0, label: t.onboarding.step1, path: '/sources' },
    { done: localStorage.getItem('onboarding_visited_transcripts') === 'true', label: t.onboarding.step2, path: '/library' },
    { done: sessionCount > 0, label: t.onboarding.step3, path: '/assistant' },
  ];

  const allDone = steps.every((s) => s.done);
  if (allDone) {
    localStorage.setItem('onboarding_dismissed', 'true');
    return null;
  }

  const handleDismiss = () => {
    localStorage.setItem('onboarding_dismissed', 'true');
    setDismissed(true);
  };

  return (
    <div className="relative border border-blue-200/60 bg-blue-50/30 rounded-lg px-4 py-3 mb-4">
      <button
        onClick={handleDismiss}
        className="absolute top-2 right-2 text-neutral-400 hover:text-neutral-600"
      >
        <X className="w-3.5 h-3.5" />
      </button>
      <p className="text-xs font-mono font-medium text-neutral-700 mb-2">{t.onboarding.title}</p>
      <div className="space-y-1.5">
        {steps.map((step, i) => (
          <div key={i} className="flex items-center gap-2">
            {step.done ? (
              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
            ) : (
              <Circle className="w-3.5 h-3.5 text-neutral-300 shrink-0" />
            )}
            <span
              className={`text-xs ${step.done ? 'text-neutral-400 line-through' : 'text-neutral-600'}`}
            >
              {step.label}
            </span>
            {!step.done && (
              <button
                onClick={() => {
                  if (step.path === '/library')
                    localStorage.setItem('onboarding_visited_transcripts', 'true');
                  navigate(step.path);
                }}
                className="ml-auto text-[10px] text-blue-500 hover:text-blue-700 flex items-center gap-0.5"
              >
                {t.onboarding.go} <ArrowRight className="w-2.5 h-2.5" />
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
