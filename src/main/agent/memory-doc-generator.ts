import { VoiceBrainDB } from '../db/database';
import type { LLMClient } from '../llm/llm-client';
import { getStr, getLang } from '../i18n';

export class MemoryDocGenerator {
  constructor(private db: VoiceBrainDB, private llm: LLMClient, private model: string) {}

  async generate(date: string): Promise<string> {
    // 1. Gather data
    const recordings = this.db.getRecordingsByDate(date);
    const segments = this.db.getSegmentsByDate(date);
    const items = this.db.getExtractedItemsByDate(date);
    const summary = this.db.getDailySummary(date);

    if (recordings.length === 0 && segments.length === 0) {
      return getStr('memory.doc_empty')(date);
    }

    // 2. Build context
    const context = this.buildContext(date, recordings, segments, items, summary);

    // 3. LLM generate
    const lang = getLang();
    const prompt = `${getStr('memory.doc_prompt')}

${context}

${lang === 'zh' ? '请按以下 4 个章节顺序输出 Markdown（直接输出内容，不要包裹在代码块中，不要输出日期标题）：' : 'Output Markdown in the following 4 sections (output content directly, no code fences, no date title):'}

${getStr('memory.doc_section_summary')}
${getStr('memory.doc_section_summary_hint')}

${getStr('memory.doc_section_facts')}
${getStr('memory.doc_section_facts_hint')}

${getStr('memory.doc_section_todos')}
${getStr('memory.doc_section_todos_hint')}

${getStr('memory.doc_section_notes')}
${getStr('memory.doc_section_notes_hint')}
`;
    void date; // unused — kept in signature for context

    const result = await this.llm.generate({ model: this.model, prompt, temperature: 0.3, think: false });
    return this.stripRedundantDateHeading(result);
  }

  /** Some LLMs still emit `# {date} 记忆` despite the no-title instruction.
   *  Strip leading h1/h2 if it looks like the date header so the page
   *  doesn't show it twice. */
  private stripRedundantDateHeading(content: string): string {
    return content.replace(/^\s*#{1,2}\s+\d{4}-\d{2}-\d{2}[^\n]*\n+/, '');
  }

  private buildContext(date: string, recordings: any[], segments: any[], items: any[], summary: any): string {
    const parts: string[] = [];

    parts.push(getStr('memory.ctx_date')(date));
    parts.push(getStr('memory.ctx_count')(recordings.length));

    if (recordings.length > 0) {
      parts.push(`\n${getStr('memory.ctx_list')}`);
      for (const r of recordings) {
        const time = r.recorded_at ? new Date(r.recorded_at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '';
        const dur = r.duration_seconds >= 60 ? `${Math.round(r.duration_seconds / 60)}min` : '<1min';
        const brief = r.combined_text ? r.combined_text.slice(0, 120) : '';
        parts.push(`- ${time} ${r.file_name} (${dur}, ${r.speaker_count || 0}人)${brief ? ' — ' + brief : ''}`);
      }
    }

    if (segments.length > 0) {
      parts.push(`\n${getStr('memory.ctx_segments')}`);
      for (const s of segments.slice(0, 20)) {
        const text = (s.clean_text || s.raw_text || '').slice(0, 200);
        const speaker = s.speaker_name || `Speaker ${s.speaker_id}`;
        parts.push(`- [${speaker}] ${text}`);
      }
    }

    if (items.length > 0) {
      parts.push(`\n${getStr('memory.ctx_items')}`);
      for (const item of items) {
        parts.push(`- [${item.type}] ${item.content}${item.related_person ? ` (${item.related_person})` : ''}`);
      }
    }

    if (summary) {
      parts.push(`\n${getStr('memory.ctx_daily_summary')}\n${summary.summary_text || ''}`);
    }

    return parts.join('\n');
  }
}
