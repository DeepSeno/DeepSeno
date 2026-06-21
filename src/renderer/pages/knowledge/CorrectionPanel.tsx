import { useState, useEffect, useCallback, useRef } from 'react';
import { Loader2 } from 'lucide-react';
import { useApi } from '../../hooks/useApi';
import { useI18n } from '../../i18n';

/**
 * VocabularyPanel — free-form textarea for custom vocabulary and correction rules.
 * Content is stored in settings.vocabularyContext and injected into TextOptimizer prompts.
 */
export default function VocabularyPanel() {
  const api = useApi();
  const { t } = useI18n();
  const k = (t as any).knowledge || {};

  const [content, setContent] = useState('');
  const [saved, setSaved] = useState(true);
  const [saving, setSaving] = useState(false);
  const saveTimerRef = useRef<NodeJS.Timeout | null>(null);

  // Load from settings
  useEffect(() => {
    (async () => {
      try {
        const settings = await (api as any).getSettings();
        setContent(settings?.vocabularyContext || '');
      } catch { /* ignore */ }
    })();
  }, [api]);

  // Auto-save with debounce
  const handleChange = useCallback((value: string) => {
    setContent(value);
    setSaved(false);

    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(async () => {
      setSaving(true);
      try {
        await (api as any).saveSettings({ vocabularyContext: value });
        setSaved(true);
      } catch { /* ignore */ }
      setSaving(false);
    }, 1000);
  }, [api]);

  // Cleanup timer
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, []);

  const placeholder = k.vocab_placeholder_full ||
`示例：

## 人名
张总、胡主任、李四、王五

## 品牌 / 公司
希尔顿、星巴克、ABC科技

## 项目
海塔智能体、图片库升级

## 术语
LLM、RAG、三级等保、私有化部署

## 纠正规则
- "老胡"就是"胡主任"
- "图片库"在我们语境中指"媒资管理系统"
- 金额默认单位为"万元"`;

  return (
    <div className="kz-paper overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3 flex items-center justify-between" style={{ borderBottom: '1px solid var(--line-soft)' }}>
        <div>
          <h3 className="kz-serif" style={{ fontSize: 15, color: 'var(--ink)' }}>
            {k.vocab_title || '专有名词与纠正规则'}
          </h3>
          <p className="kz-text-mute" style={{ fontFamily: 'var(--serif)', fontStyle: 'italic', fontSize: 11.5, marginTop: 2 }}>
            {k.vocab_hint || '录入正确的人名、术语、纠正规则，系统会在语音识别优化时自动参考'}
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          {saving ? (
            <Loader2 size={12} className="animate-spin kz-text-mute" />
          ) : saved ? (
            <span className="kz-badge kz-badge--success">{k.vocab_saved || '已保存'}</span>
          ) : (
            <span className="kz-badge kz-badge--warn">{k.vocab_unsaved || '未保存'}</span>
          )}
        </div>
      </div>

      {/* Textarea */}
      <textarea
        value={content}
        onChange={(e) => handleChange(e.target.value)}
        placeholder={placeholder}
        rows={12}
        className="w-full px-4 py-3 resize-y min-h-[200px] focus:outline-none"
        style={{
          fontFamily: 'var(--mono)',
          fontSize: 12,
          color: 'var(--ink)',
          background: 'var(--bg-card)',
          lineHeight: 1.7,
          border: 0,
        }}
        spellCheck={false}
      />
    </div>
  );
}
