import { Cpu, Sparkles } from 'lucide-react';
import { CollapsibleCard, FieldRow, ToggleSwitch } from '../../../components/settings';
import Select from '../../../components/Select';
import { useI18n } from '../../../i18n';
import type { AppSettings } from '../../../hooks/useApi';
import type { ModelsSectionProps } from './types';

function HelpTip({ text }: { text: string }) {
  return (
    <span
      className="kz-mono kz-text-mute inline-flex items-center justify-center w-4 h-4 rounded-full cursor-help"
      style={{ fontSize: 9, border: '1px solid var(--line)' }}
      title={text}
    >
      ?
    </span>
  );
}

const DEFAULT_LLM_CLEAN_PROMPT_ZH = `你是一个语音转文字优化助手，支持中文、英文及多语言混排。请对以下语音识别（ASR）的原始文本进行优化处理：

1. 识别文本语言，以原文语言输出（中文保持中文、英文保持英文、混排保持混排）
2. 修正语音识别错误：根据上下文语义修正被错误识别的字词，尤其是：
   - 专有名词（人名、地名、品牌名、产品名等）
   - 同音或近音错字（中文），或形似错词（英文）
3. 去除语气词和口头禅
   - 中文：嗯、啊、呃、那个、就是说、然后、这个等
   - 英文：um, uh, like, you know, basically, right 等
4. 去除重复表述（说话人反复说同一件事时只保留最完整的一次）
5. 重组语句，使其通顺流畅，保持原意不变
6. 补充缺失的标点符号
7. 不要添加原文没有的内容，不要翻译，不要转换语言

【重要】只输出优化后的文本，禁止输出任何解释、注释或额外说明。`;

const DEFAULT_LLM_CLEAN_PROMPT_EN = `You are a speech-to-text optimization assistant supporting multilingual input. Please optimize the following raw ASR transcript:

1. Preserve the original language (keep Chinese as Chinese, English as English, mixed as mixed)
2. Fix ASR errors: correct misrecognized words based on context, especially:
   - Proper nouns (names, places, brands, products)
   - Homophones or similar-sounding errors
3. Remove filler words and verbal tics
   - English: um, uh, like, you know, basically, right, etc.
   - Chinese: 嗯、啊、呃、那个、就是说、然后、这个, etc.
4. Remove repeated statements (keep only the most complete version)
5. Restructure sentences for clarity while preserving the original meaning
6. Add missing punctuation
7. Do not add content not in the original, do not translate, do not change the language

IMPORTANT: Output only the optimized text. Do not include any explanations, comments, or notes.`;

export default function BehaviorSection({ settings, s, updateField }: ModelsSectionProps) {
  const { lang } = useI18n();
  const DEFAULT_LLM_CLEAN_PROMPT = lang === 'zh' ? DEFAULT_LLM_CLEAN_PROMPT_ZH : DEFAULT_LLM_CLEAN_PROMPT_EN;

  return (
    <div className="space-y-4">
      {/* ── Transcription Parameters ── */}
      <CollapsibleCard title={s.transcription_params || 'Transcription Parameters'} icon={Cpu}>
        <FieldRow label={s.asr_language} hint={s.asr_language_hint}>
          <Select
            value={settings.asrLanguage || 'auto'}
            onChange={(v) => updateField({ asrLanguage: v as AppSettings['asrLanguage'] })}
            className="kz-mono"
            ariaLabel={s.asr_language}
            options={[
              { value: 'auto', label: s.asr_auto_detect },
              { value: 'zh', label: s.asr_chinese },
              { value: 'en', label: 'English' },
              { value: 'ja', label: s.asr_japanese },
              { value: 'ko', label: s.asr_korean },
              { value: 'yue', label: s.asr_cantonese },
            ]}
          />
        </FieldRow>

        <div className="space-y-2 pt-2" style={{ borderTop: '1px solid var(--line-soft)' }}>
          <label className="kz-serif-italic kz-text-soft flex items-center gap-1.5" style={{ fontSize: 12.5 }}>
            {s.hotwords}
            <HelpTip text={s.hotwords_help} />
          </label>
          <p className="kz-text-mute" style={{ fontSize: 11.5 }}>{s.hotwords_desc}</p>
          <textarea
            className="w-full h-32 kz-mono kz-text-ink resize-y"
            style={{
              background: 'var(--bg-elev)',
              border: '1px solid var(--line)',
              borderRadius: 8,
              padding: '10px 12px',
              fontSize: 12,
              outline: 'none',
            }}
            placeholder={s.hotwords_placeholder}
            value={(settings.hotwords || []).join('\n')}
            onChange={(e) => {
              const words = e.target.value
                .split('\n')
                .map((w) => w.trim())
                .filter(Boolean);
              updateField({ hotwords: words });
            }}
          />
        </div>
      </CollapsibleCard>

      {/* ── Text Processing (real-time paste optimization) ── */}
      <CollapsibleCard title={s.text_processing} icon={Sparkles}>
        <FieldRow label={s.llm_clean_before_paste} hint={s.llm_clean_before_paste_desc}>
          <ToggleSwitch
            checked={settings.llmCleanBeforePaste}
            onChange={(checked) => updateField({ llmCleanBeforePaste: checked })}
          />
        </FieldRow>

        {settings.llmCleanBeforePaste && (
          <div className="pt-2" style={{ borderTop: '1px solid var(--line-soft)' }}>
            <div className="flex items-center justify-between mb-2">
              <div>
                <span className="kz-serif-italic kz-text-soft" style={{ fontSize: 13 }}>{s.llm_clean_prompt}</span>
                <div className="kz-text-mute" style={{ fontSize: 11 }}>
                  {s.llm_clean_prompt_empty_hint}
                </div>
              </div>
              {settings.llmCleanPrompt && (
                <button
                  onClick={() => updateField({ llmCleanPrompt: '' })}
                  className="kz-btn kz-btn--sm kz-btn--ghost"
                >
                  {s.llm_clean_prompt_reset}
                </button>
              )}
            </div>
            <textarea
              value={settings.llmCleanPrompt || DEFAULT_LLM_CLEAN_PROMPT}
              onChange={(e) => updateField({ llmCleanPrompt: e.target.value })}
              rows={20}
              className="w-full kz-mono kz-text-ink resize-y"
              style={{
                background: 'var(--bg-elev)',
                border: '1px solid var(--line)',
                borderRadius: 8,
                padding: '10px 12px',
                fontSize: 12,
                outline: 'none',
              }}
            />
          </div>
        )}
      </CollapsibleCard>
    </div>
  );
}
