import { useState, useEffect, useCallback, useRef } from 'react';
import { useI18n } from '../i18n';
import { useApi } from '../hooks/useApi';
import type { AppSettings } from '../hooks/useApi';
import MarkdownSplitEditor from '../components/MarkdownSplitEditor';

const PLACEHOLDER = `\u793A\u4F8B\uFF1A

## \u4EBA\u540D
\u5F20\u603B\u3001\u80E1\u4E3B\u4EFB\u3001\u674E\u56DB\u3001\u738B\u4E94

## \u54C1\u724C / \u516C\u53F8
\u5E0C\u5C14\u987F\u3001\u661F\u5DF4\u514B\u3001ABC\u79D1\u6280

## \u9879\u76EE
\u6D77\u5854\u667A\u80FD\u4F53\u3001\u56FE\u7247\u5E93\u5347\u7EA7

## \u672F\u8BED
LLM\u3001RAG\u3001\u4E09\u7EA7\u7B49\u4FDD\u3001\u79C1\u6709\u5316\u90E8\u7F72

## \u7EA0\u6B63\u89C4\u5219
- "\u8001\u80E1"\u5C31\u662F"\u80E1\u4E3B\u4EFB"
- "\u56FE\u7247\u5E93"\u5728\u6211\u4EEC\u8BED\u5883\u4E2D\u6307"\u5A92\u8D44\u7BA1\u7406\u7CFB\u7EDF"
- \u91D1\u989D\u9ED8\u8BA4\u5355\u4F4D\u4E3A"\u4E07\u5143"`;

export default function VocabularyPage() {
  const { t } = useI18n();
  const api = useApi();

  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [saved, setSaved] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    api.loadSettings().then(setSettings);
  }, []);

  const updateField = useCallback((partial: Partial<AppSettings>) => {
    setSettings((prev) => prev ? { ...prev, ...partial } : prev);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      try {
        const updated = await api.updateSettings(partial);
        setSettings(updated);
        setSaved(true);
        setTimeout(() => setSaved(false), 1500);
      } catch { /* silent */ }
    }, 500);
  }, [api]);

  if (!settings) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-neutral-400 font-mono text-sm">{t.common.loading}</div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full gap-4">
      {/* Header */}
      <div className="flex items-center justify-between flex-shrink-0">
        <div className="flex items-center gap-3">
          <span className="text-[12px] font-mono font-medium text-neutral-700">
            {t.knowledge?.vocab_title || 'Vocabulary & Correction Rules'}
          </span>
          <span className="text-[11px] text-neutral-400 font-mono">
            {t.knowledge?.vocab_hint || 'Enter correct names, terms, and correction rules'}
          </span>
        </div>
        {saved && (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-mono text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-md">
            auto-saved
          </span>
        )}
      </div>

      {/* Editor */}
      <div className="flex-1 min-h-0 overflow-hidden flex flex-col rounded-xl border border-neutral-200/60 bg-white shadow-sm">
        <MarkdownSplitEditor
          value={settings.vocabularyContext ?? ''}
          onChange={(val: string) => updateField({ vocabularyContext: val })}
          placeholder={PLACEHOLDER}
          className="flex-1"
          mode="preview"
        />
      </div>

      {/* Footer hint */}
      <div className="flex items-center rounded-lg bg-neutral-50/80 border border-neutral-100 px-4 py-2 flex-shrink-0">
        <span className="text-[11px] font-mono text-neutral-400">
          {t.knowledge?.vocab_hint || 'Enter correct names, terms, and correction rules — auto-referenced during ASR optimization'}
        </span>
      </div>
    </div>
  );
}
