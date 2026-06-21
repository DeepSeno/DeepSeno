import type { LLMClient } from './llm-client';
import { getPipelinePrompt } from './default-prompts';

// ── Prompt 构建函数（纯函数） ──

export const DEFAULT_CLEAN_PROMPT = `你是一个语音转文字优化助手。请对以下语音识别（ASR）的原始文本进行优化处理：

1. 修正语音识别错误：根据上下文语义修正被错误识别的字词，尤其是：
   - 专有名词（地名、人名、品牌名、酒店名等），例如"西尔顿"应为"希尔顿"
   - 同音或近音错字，根据语境选择正确的词
2. 去除语气词和口头禅（嗯、啊、呃、那个、就是说、然后、这个等）
3. 去除重复表述（说话人反复说同一件事时只保留最完整的一次）
4. 重组语句，使其通顺流畅
5. 补充缺失的标点符号
6. 保持原意不变，不要添加原文没有的内容
7. 将所有繁体字统一转换为简体中文
8. 【重要】保留原文中的英文单词、术语和短语，不要翻译成中文。例如"我们用React做这个feature"应保持英文词不变
9. 【重要】不要发挥想象力。只修正明显的 ASR 错误，不要替换为你认为"更合理"的内容。如果不确定某个词是否有误，保留原文

原始文本：
{{text}}

【重要】只输出优化后的文本，禁止输出任何解释、注释、备注、括号说明或元信息。不要以"注："、"备注"、"（"等开头添加任何额外说明。`;

export const DEFAULT_BATCH_CLEAN_PROMPT = `你是一个语音转文字优化助手。以下是由语音识别（ASR）产生的多个片段，每行一个片段。请结合上下文语境逐行优化每个片段：

1. 修正语音识别错误：根据上下文语义修正被错误识别的字词，尤其是：
   - 专有名词（地名、人名、品牌名、酒店名、技术术语等），例如"西尔顿"应为"希尔顿"，"IOM"根据上下文可能是"LLM"
   - 同音或近音错字，结合前后文选择正确的词
2. 去除语气词和口头禅（嗯、啊、呃、那个、就是说、然后、这个等）
3. 去除重复表述（说话人反复说同一件事时只保留最完整的一次）
4. 重组语句使其通顺流畅，补充缺失的标点符号
5. 保持原意不变，不要添加原文没有的内容
6. 将所有繁体字统一转换为简体中文
7. 【重要】保留原文中的英文单词、术语和短语，不要翻译成中文
8. 【重要】不要发挥想象力。只修正明显的 ASR 错误，不要替换为你认为"更合理"的内容

原始文本（每行一个片段）：
{{text}}

【重要】严格保持输入的行数不变。输入有几行，输出就有几行，每行对应一个片段。不要合并行、拆分行或增删行。只输出优化后的文本，禁止输出任何解释、注释或元信息。`;

/** Prompt for paste-to-clipboard: merges all segments into one coherent paragraph. */
export const DEFAULT_PASTE_CLEAN_PROMPT = `你是一个语音转文字优化助手。以下是由语音识别（ASR）产生的多个片段拼接而成的完整录音文本。请将其优化为一段通顺、连贯的文字：

1. 修正语音识别错误：根据上下文语义修正被错误识别的字词，尤其是：
   - 专有名词（地名、人名、品牌名、酒店名、技术术语等），例如"西尔顿"应为"希尔顿"，"IOM"根据上下文可能是"LLM"
   - 同音或近音错字，结合前后文选择正确的词
2. 去除语气词和口头禅（嗯、啊、呃、那个、就是说、然后、这个等）
3. 去除重复表述和无意义的碎片句（说话人反复说同一件事时只保留最完整的一次）
4. 将碎片句合并为完整的句子，重组语句使其通顺流畅
5. 补充缺失的标点符号
6. 保持原意不变，不要添加原文没有的内容
7. 将所有繁体字统一转换为简体中文
8. 【重要】保留原文中的英文单词、术语和短语，不要翻译成中文
9. 【重要】不要发挥想象力。只修正明显的 ASR 错误，不要替换为你认为"更合理"的内容

原始文本：
{{text}}

【重要】只输出优化后的文本，禁止输出任何解释、注释、备注、括号说明或元信息。`;

export function buildCleanPrompt(rawText: string, template?: string): string {
  let t = template || DEFAULT_CLEAN_PROMPT;
  // If custom prompt doesn't include {{text}} placeholder, append it
  if (!t.includes('{{text}}')) {
    t = t.trimEnd() + '\n\n原始文本：\n{{text}}';
  }
  return t.replace(/\{\{text\}\}/g, rawText);
}

export function buildExtractPrompt(cleanText: string, template?: string): string {
  const t = template || getPipelinePrompt('infoExtract');
  if (t.includes('{{text}}')) {
    return t.replace(/\{\{text\}\}/g, cleanText);
  }
  return t + '\n\n' + cleanText;
}

export function buildDailySummaryPrompt(
  date: string,
  segments: Array<{ start: number; end: number; speaker: string; text: string }>,
): string {
  const timeline = segments
    .map((s) => {
      const startTime = formatSeconds(s.start);
      const endTime = formatSeconds(s.end);
      return `[${startTime} - ${endTime}] ${s.speaker}: ${s.text}`;
    })
    .join('\n');

  return `你是一个日报摘要生成助手。请根据以下 ${date} 的对话记录，生成一份每日摘要。所有输出必须使用简体中文。

时间线记录：
${timeline}

请以 JSON 格式输出，格式如下：
{
  "summary": "今日概要（2-3句话）",
  "timeline": [
    { "time": "HH:MM", "event": "事件描述" }
  ],
  "todos": [
    { "content": "待办内容", "due_date": "截止日期", "person": "负责人" }
  ],
  "decisions": ["决策1", "决策2"]
}`;
}

export function buildWeeklySummaryPrompt(
  startDate: string,
  endDate: string,
  dailySummaries: Array<{ date: string; summary: string; todos: any[]; decisions: string[] }>,
): string {
  const summaryBlocks = dailySummaries
    .map(
      (ds) =>
        `### ${ds.date}\n${ds.summary}\n待办: ${ds.todos.map((t: any) => t.content).join(', ') || '无'}\n决策: ${ds.decisions.join(', ') || '无'}`,
    )
    .join('\n\n');

  return `你是一个周报生成助手。请根据以下 ${startDate} 到 ${endDate} 的每日摘要，生成一份周报。所有输出必须使用简体中文。

每日摘要：
${summaryBlocks}

请以 JSON 格式输出：
{
  "summary": "本周概要（3-5句话）",
  "highlights": ["重要事件1", "重要事件2"],
  "todos_summary": [
    { "content": "待办内容", "status": "pending", "person": "负责人" }
  ],
  "decisions": ["决策1", "决策2"],
  "next_week_focus": ["下周重点1", "下周重点2"]
}`;
}

export function buildMonthlySummaryPrompt(
  startDate: string,
  endDate: string,
  dailySummaries: Array<{ date: string; summary: string; todos: any[]; decisions: string[] }>,
): string {
  const summaryBlocks = dailySummaries
    .map(
      (ds) =>
        `### ${ds.date}\n${ds.summary}\n待办: ${ds.todos.map((t: any) => t.content).join(', ') || '无'}\n决策: ${ds.decisions.join(', ') || '无'}`,
    )
    .join('\n\n');

  return `你是一个月报生成助手。请根据以下 ${startDate} 到 ${endDate} 这一整月的每日摘要，生成一份月报。所有输出必须使用简体中文。

每日摘要：
${summaryBlocks}

请以 JSON 格式输出：
{
  "summary": "本月概要（3-5句话，提炼整月的主线与进展）",
  "highlights": ["本月亮点1", "本月亮点2"],
  "todos_summary": [
    { "content": "待办内容", "status": "pending", "person": "负责人" }
  ],
  "decisions": ["决策1", "决策2"],
  "next_month_focus": ["下月重点1", "下月重点2"]
}`;
}

export function buildSentimentPrompt(text: string): string {
  return `你是一个情绪分析助手。请分析以下文本的情绪/语气。所有输出必须使用简体中文。

文本：
${text}

请以 JSON 格式输出，只需返回一个值：
{
  "sentiment": "positive | negative | neutral | excited | frustrated | concerned | confident",
  "confidence": 0.0-1.0
}

注意：sentiment 只能是以上7个值之一（不要带空格）。`;
}

export function buildMeetingNotesPrompt(
  segments: MeetingSegment[],
  meta: { date: string; duration: number },
): string {
  // Build transcript with speaker labels and timestamps
  const transcript = segments
    .map((s) => {
      const start = formatMinSec(s.startTime);
      const end = formatMinSec(s.endTime);
      return `[${start} - ${end}] ${s.speaker}: ${s.cleanText}`;
    })
    .join('\n');

  // Aggregate speaker stats
  const speakerStats = new Map<string, number>();
  for (const s of segments) {
    speakerStats.set(s.speaker, (speakerStats.get(s.speaker) || 0) + (s.endTime - s.startTime));
  }
  const statsBlock = Array.from(speakerStats.entries())
    .map(([name, seconds]) => `- ${name}: ${formatMinSec(seconds)}`)
    .join('\n');

  const totalDuration = formatMinSec(meta.duration);

  return `你是一个会议纪要生成助手。请根据以下 ${meta.date} 的会议记录，生成一份结构化会议纪要。所有输出必须使用简体中文。

会议日期：${meta.date}
会议时长：${totalDuration}

参会人员发言统计：
${statsBlock}

会议记录：
${transcript}

请以 JSON 格式输出，格式如下：
{
  "title": "会议主题（简短概括）",
  "participants": [
    { "name": "参会人姓名", "speakingTime": 0 }
  ],
  "decisions": ["决策1", "决策2"],
  "actionItems": [
    { "assignee": "负责人", "task": "任务描述", "dueDate": "截止日期（如有）" }
  ],
  "discussionSummary": "讨论内容概要（2-3句话）",
  "keyTopics": ["主题1", "主题2"]
}`;
}

// ── 辅助函数 ──

function formatMinSec(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = Math.floor(totalSeconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function formatSeconds(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = Math.floor(totalSeconds % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// ── Chunking helpers ──

/** Split text into chunks at paragraph/newline boundaries, each ≤ maxChars. */
function splitTextIntoChunks(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];
  const chunks: string[] = [];
  const lines = text.split('\n');
  let current = '';
  for (const line of lines) {
    if (current.length + line.length + 1 > maxChars && current.length > 0) {
      chunks.push(current);
      current = '';
    }
    current += (current ? '\n' : '') + line;
  }
  if (current) chunks.push(current);
  return chunks;
}

/** Split an array into groups of at most chunkSize elements. */
function splitArrayIntoChunks<T>(arr: T[], chunkSize: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += chunkSize) {
    chunks.push(arr.slice(i, i + chunkSize));
  }
  return chunks;
}

/** Detect if LLM output is echoing/paraphrasing the prompt template instead of cleaning text. */
/**
 * Strip common LLM response prefixes that precede the actual optimized content.
 * e.g., "好的，以下是优化后的文本：..." → "..."
 */
export function stripLLMPrefix(text: string): string {
  let result = text.trim();
  // Strip "好的，" / "好:" / "OK," etc. at the very start
  result = result.replace(/^(?:好的|好|OK)[，,、:：。.\s]*/i, '');
  // Strip "以下是优化后的文本：" / "下面是整理后的内容：" / "经过优化：" etc.
  result = result.replace(
    /^(?:以下|下面|这)是(?:经过)?(?:语音转文字)?(?:优化|整理|修正|修改|清理)(?:后)?(?:的)?(?:文本|内容|结果|版本)?[：:]\s*/,
    '',
  );
  // Strip "经过语音转文字优化，" etc.
  result = result.replace(/^经过(?:语音转文字)?优化[，,]?\s*/, '');
  return result.trim() || text.trim();
}

export function isPromptEcho(text: string): boolean {
  // Strip LLM response prefixes first — "以下是优化后的文本：" is a valid preamble, not an echo
  const stripped = stripLLMPrefix(text);

  // Patterns indicating the LLM echoed the instruction prompt or refused the task
  const echoPatterns = [
    '语音识别原始文本',   // part of the system prompt being echoed
    '请对以下',           // LLM re-stating the instruction
    '原始文本进行',       // LLM re-stating the instruction
    '需要优化的',         // LLM asking for input
    '无法优化',           // LLM refusing
    '无法识别',           // LLM refusing
    '没有提供',           // LLM saying no input
    '文本为空',           // LLM saying empty input
    '请输入',             // LLM asking for input
    '请提供',             // LLM asking for input
  ];
  return echoPatterns.some((p) => stripped.includes(p));
}

/** Compute character-level overlap ratio between two strings (Jaccard-like). */
export function computeCharOverlap(a: string, b: string): number {
  // Extract meaningful characters (remove punctuation and whitespace)
  const charsA = new Set(a.replace(/[\s\p{P}]/gu, '').split(''));
  const charsB = new Set(b.replace(/[\s\p{P}]/gu, '').split(''));
  if (charsA.size === 0 || charsB.size === 0) return 0;
  let intersection = 0;
  for (const c of charsA) {
    if (charsB.has(c)) intersection++;
  }
  return intersection / Math.max(charsA.size, charsB.size);
}

// ── TextOptimizer 类 ──

export interface ExtractedInfo {
  items: Array<{
    type: string;
    content: string;
    due_date?: string;
    related_person?: string;
  }>;
  relationships?: Array<{
    person1: string;
    person2: string;
    relationship: string;
    context?: string;
  }>;
}

export interface DailySummaryResult {
  summary: string;
  timeline: Array<{ time: string; event: string }>;
  todos: Array<{ content: string; due_date?: string; person?: string }>;
  decisions: string[];
}

export interface WeeklySummaryResult {
  summary: string;
  highlights: string[];
  todos_summary: Array<{ content: string; status?: string; person?: string }>;
  decisions: string[];
  next_week_focus: string[];
}

export interface MonthlySummaryResult {
  summary: string;
  highlights: string[];
  todos_summary: Array<{ content: string; status?: string; person?: string }>;
  decisions: string[];
  next_month_focus: string[];
}

export interface SentimentResult {
  sentiment: string;
  confidence: number;
}

export interface MeetingSegment {
  speaker: string;
  startTime: number;
  endTime: number;
  cleanText: string;
}

export interface MeetingNotes {
  title: string;
  participants: { name: string; speakingTime: number }[];
  decisions: string[];
  actionItems: { assignee: string; task: string; dueDate?: string }[];
  discussionSummary: string;
  keyTopics: string[];
}

const LLM_CONCURRENCY = 3;

export class TextOptimizer {
  private client: LLMClient;
  private model: string;
  private vocabularyBlock: string = '';
  private cleanupModel?: string;
  private cleanupKeepAlive?: string;

  constructor(client: LLMClient, model: string = 'qwen3.5:4b') {
    this.client = client;
    this.model = model;
  }

  /** Set vocabulary block (custom vocabulary + auto-learned corrections) to inject into clean/batchClean prompts. */
  setVocabularyBlock(block: string): void {
    this.vocabularyBlock = block;
  }

  /**
   * Override the model used for mechanical cleanup tasks (cleanText, batchClean,
   * analyzeSentiment) when the main model is too heavy for bulk per-segment work.
   * Semantic tasks (extractInfo, generateMeetingNotes, weekly/monthly reports)
   * still use the main model. Pass `undefined` to clear the override.
   */
  setCleanupModel(model?: string, keepAlive?: string): void {
    this.cleanupModel = model;
    this.cleanupKeepAlive = keepAlive;
  }

  private cleanupSpec(): { model: string; keepAlive?: string } {
    return {
      model: this.cleanupModel || this.model,
      keepAlive: this.cleanupKeepAlive,
    };
  }

  /**
   * Batch-clean a full recording text (concatenation of all segments).
   * Gives the LLM full context to fix ASR errors across segment boundaries
   * and merge fragmented short sentences into coherent text.
   */
  async batchClean(fullText: string, promptTemplate?: string, keepAlive?: string): Promise<string> {
    const trimmed = fullText.trim();
    if (!trimmed) return '';

    const template = promptTemplate || DEFAULT_BATCH_CLEAN_PROMPT;
    const CHUNK_SIZE = 4000;

    if (trimmed.length <= CHUNK_SIZE) {
      return this._doBatchClean(trimmed, template, keepAlive);
    }

    // Chunked batch clean for very long recordings (parallel with concurrency limit)
    const chunks = splitTextIntoChunks(trimmed, CHUNK_SIZE);
    console.log(`[TextOptimizer] batchClean: splitting ${trimmed.length} chars into ${chunks.length} chunks`);
    const results: string[] = new Array(chunks.length);
    for (let i = 0; i < chunks.length; i += LLM_CONCURRENCY) {
      const batch = chunks.slice(i, i + LLM_CONCURRENCY);
      const batchResults = await Promise.all(batch.map(async (chunk) => {
        try {
          return await this._doBatchClean(chunk, template, keepAlive);
        } catch (err) {
          console.warn('[TextOptimizer] batchClean chunk failed, using raw:', err);
          return chunk;
        }
      }));
      batchResults.forEach((r, j) => { results[i + j] = r; });
    }
    return results.join('\n');
  }

  private async _doBatchClean(text: string, template: string, keepAlive?: string): Promise<string> {
    // If custom prompt doesn't include {{text}} placeholder, append it
    let t = template;
    if (!t.includes('{{text}}')) {
      t = t.trimEnd() + '\n\n原始文本：\n{{text}}';
    }
    let prompt = t.replace(/\{\{text\}\}/g, text);
    if (this.vocabularyBlock) {
      prompt = prompt + this.vocabularyBlock;
    }
    const spec = this.cleanupSpec();
    const effectiveKeepAlive = keepAlive ?? spec.keepAlive;
    const rawResult = await this.client.generate({
      model: spec.model,
      prompt,
      temperature: 0.3,
      think: false,
      ...(effectiveKeepAlive ? { keep_alive: effectiveKeepAlive } : {}),
    });

    // Strip common LLM response prefixes (e.g., "以下是优化后的文本：")
    const result = stripLLMPrefix(rawResult);

    // Guard: if LLM output echoes the prompt template itself
    if (isPromptEcho(result)) {
      console.warn(`[TextOptimizer] batchClean: prompt echo detected: "${result.substring(0, 60)}...", using raw text`);
      return text;
    }

    // Guard: if cleaned text shares no meaningful overlap with raw text
    if (text.length >= 10) {
      const overlap = computeCharOverlap(text, result);
      if (overlap < 0.15) {
        console.warn(`[TextOptimizer] batchClean: hallucination detected (overlap=${(overlap * 100).toFixed(0)}%): "${result.substring(0, 60)}...", using raw text`);
        return text;
      }
    }

    if (!result || !result.trim()) {
      return text;
    }

    return result.trim();
  }

  async cleanText(rawText: string, promptTemplate?: string, keepAlive?: string): Promise<string> {
    const trimmed = rawText.trim();
    if (!trimmed) {
      return '';
    }

    let prompt = buildCleanPrompt(rawText, promptTemplate);
    if (this.vocabularyBlock) {
      prompt = prompt + this.vocabularyBlock;
    }
    const spec = this.cleanupSpec();
    const effectiveKeepAlive = keepAlive ?? spec.keepAlive;
    const rawResult = await this.client.generate({
      model: spec.model,
      prompt,
      temperature: 0.3,
      think: false,
      ...(effectiveKeepAlive ? { keep_alive: effectiveKeepAlive } : {}),
    });

    // Strip common LLM response prefixes (e.g., "以下是优化后的文本：")
    const result = stripLLMPrefix(rawResult);

    // Guard 1: if LLM output is much longer than input, it likely hallucinated
    if (result.length > rawText.length * 3 && rawText.length < 50) {
      console.warn(`[TextOptimizer] Hallucination detected (length): result=${result.length} vs raw=${rawText.length}, using raw text`);
      return trimmed;
    }

    // Guard 2: if LLM output echoes the prompt template itself, it's not cleaning — it's confused
    if (isPromptEcho(result)) {
      console.warn(`[TextOptimizer] Prompt echo detected: "${result.substring(0, 40)}...", using raw text`);
      return trimmed;
    }

    // Guard 3: if cleaned text shares no meaningful overlap with raw text, it's hallucination
    if (trimmed.length >= 10) {
      const overlap = computeCharOverlap(rawText, result);
      if (overlap < 0.15) {
        console.warn(`[TextOptimizer] Hallucination detected (overlap=${(overlap * 100).toFixed(0)}%): "${result.substring(0, 40)}...", using raw text`);
        return trimmed;
      }
    }

    // Guard 4: if LLM returned empty or whitespace-only, fall back to raw text
    if (!result || !result.trim()) {
      console.warn(`[TextOptimizer] Empty result from LLM, using raw text`);
      return trimmed;
    }

    return result.trim();
  }

  async extractInfo(cleanText: string): Promise<ExtractedInfo> {
    const CHUNK_SIZE = 4000;
    if (cleanText.length <= CHUNK_SIZE) {
      const prompt = buildExtractPrompt(cleanText);
      return this.client.generateJSON<ExtractedInfo>({
        model: this.model,
        prompt,
        temperature: 0.1,
        think: false,
      });
    }

    // Chunked extraction: split text, extract from each chunk, merge results
    const chunks = splitTextIntoChunks(cleanText, CHUNK_SIZE);
    console.log(`[TextOptimizer] extractInfo: splitting ${cleanText.length} chars into ${chunks.length} chunks`);
    const allItems: ExtractedInfo['items'] = [];
    const allRelationships: NonNullable<ExtractedInfo['relationships']> = [];

    for (let i = 0; i < chunks.length; i += LLM_CONCURRENCY) {
      const batch = chunks.slice(i, i + LLM_CONCURRENCY);
      const batchResults = await Promise.all(batch.map(async (chunk) => {
        try {
          const prompt = buildExtractPrompt(chunk);
          return await this.client.generateJSON<ExtractedInfo>({
            model: this.model,
            prompt,
            temperature: 0.1,
            think: false,
          });
        } catch (err) {
          console.warn(`[TextOptimizer] extractInfo chunk failed, skipping:`, err);
          return null;
        }
      }));
      for (const result of batchResults) {
        if (!result) continue;
        if (result.items) allItems.push(...result.items);
        if (result.relationships) allRelationships.push(...result.relationships);
      }
    }

    return { items: allItems, relationships: allRelationships };
  }

  async generateDailySummary(
    date: string,
    segments: Array<{ start: number; end: number; speaker: string; text: string }>,
  ): Promise<DailySummaryResult> {
    const CHUNK_SEGMENTS = 30;
    if (segments.length <= CHUNK_SEGMENTS) {
      const prompt = buildDailySummaryPrompt(date, segments);
      return this.client.generateJSON<DailySummaryResult>({
        model: this.model,
        prompt,
        temperature: 0.3,
        think: false,
      });
    }

    // Chunked: generate per-chunk summaries, then merge
    const chunkGroups = splitArrayIntoChunks(segments, CHUNK_SEGMENTS);
    console.log(`[TextOptimizer] generateDailySummary: splitting ${segments.length} segments into ${chunkGroups.length} chunks`);
    const chunkSummaries: string[] = [];
    const allTodos: DailySummaryResult['todos'] = [];
    const allDecisions: string[] = [];
    const allTimeline: DailySummaryResult['timeline'] = [];

    for (const chunk of chunkGroups) {
      try {
        const prompt = buildDailySummaryPrompt(date, chunk);
        const result = await this.client.generateJSON<DailySummaryResult>({
          model: this.model,
          prompt,
          temperature: 0.3,
          think: false,
        });
        chunkSummaries.push(result.summary);
        if (result.todos) allTodos.push(...result.todos);
        if (result.decisions) allDecisions.push(...result.decisions);
        if (result.timeline) allTimeline.push(...result.timeline);
      } catch (err) {
        console.warn(`[TextOptimizer] dailySummary chunk failed, skipping:`, err);
      }
    }

    // Final merge: summarize the chunk summaries
    const mergePrompt = `你是一个日报摘要合并助手。请将以下多个分段摘要合并为一份完整的每日摘要。所有输出必须使用简体中文。

日期：${date}

分段摘要：
${chunkSummaries.map((s, i) => `[第${i + 1}部分] ${s}`).join('\n')}

请以 JSON 格式输出：
{
  "summary": "今日概要（2-3句话，合并所有分段内容）"
}`;
    try {
      const merged = await this.client.generateJSON<{ summary: string }>({
        model: this.model,
        prompt: mergePrompt,
        temperature: 0.3,
        think: false,
      });
      return {
        summary: merged.summary,
        timeline: allTimeline,
        todos: allTodos,
        decisions: [...new Set(allDecisions)],
      };
    } catch {
      return {
        summary: chunkSummaries.join(' '),
        timeline: allTimeline,
        todos: allTodos,
        decisions: [...new Set(allDecisions)],
      };
    }
  }

  async generateWeeklySummary(
    startDate: string,
    endDate: string,
    dailySummaries: Array<{ date: string; summary: string; todos: any[]; decisions: string[] }>,
  ): Promise<WeeklySummaryResult> {
    const prompt = buildWeeklySummaryPrompt(startDate, endDate, dailySummaries);
    return this.client.generateJSON<WeeklySummaryResult>({
      model: this.model,
      prompt,
      temperature: 0.3,
      think: false,
    });
  }

  async generateMonthlySummary(
    startDate: string,
    endDate: string,
    dailySummaries: Array<{ date: string; summary: string; todos: any[]; decisions: string[] }>,
  ): Promise<MonthlySummaryResult> {
    const prompt = buildMonthlySummaryPrompt(startDate, endDate, dailySummaries);
    return this.client.generateJSON<MonthlySummaryResult>({
      model: this.model,
      prompt,
      temperature: 0.3,
      think: false,
    });
  }

  async analyzeSentiment(text: string): Promise<SentimentResult> {
    const prompt = buildSentimentPrompt(text);
    const spec = this.cleanupSpec();
    return this.client.generateJSON<SentimentResult>({
      model: spec.model,
      prompt,
      temperature: 0.1,
      think: false,
      ...(spec.keepAlive ? { keep_alive: spec.keepAlive } : {}),
    });
  }

  async classifyRecording(combinedText: string): Promise<string[]> {
    const template = getPipelinePrompt('classify');
    const prompt = template.includes('{{text}}')
      ? template.replace(/\{\{text\}\}/g, combinedText.slice(0, 500))
      : template + '\n\n' + combinedText.slice(0, 500);

    try {
      const raw = await this.client.generate({
        model: this.model,
        prompt,
        system: 'You are a classifier. Return ONLY a JSON array of strings. No explanation.',
        temperature: 0,
        think: false,
      });
      const match = raw.match(/\[.*\]/s);
      if (match) {
        const tags = JSON.parse(match[0]) as string[];
        const valid = ['meeting', 'brainstorm', 'planning', 'personal', 'interview', 'lecture', 'review', 'report', 'casual'];
        return tags.filter((t) => valid.includes(t)).slice(0, 3);
      }
    } catch { /* ignore classification failure */ }
    return [];
  }

  /**
   * Generate a short whole-transcript title (5-15 chars CJK / 3-8 English
   * words). Lightweight single-call summarization for ANY recording with
   * segments — used for dictation, short notes, and other rows that don't
   * trigger full meeting_notes. Runs on cleanup-spec model when set
   * (paste-clean tier) to stay fast.
   *
   * Returns empty string if input too short or LLM call fails. Caller is
   * expected to fall back to filename or first-segment text.
   */
  async generateTitle(transcript: string): Promise<string> {
    const trimmed = transcript.trim();
    if (trimmed.length < 8) return '';

    // Cap input to keep latency low — title generation only needs a
    // representative chunk, not the entire 90-min transcript.
    const MAX_INPUT = 2000;
    const input = trimmed.length > MAX_INPUT
      ? trimmed.slice(0, MAX_INPUT) + '...'
      : trimmed;

    const prompt = `根据以下转录文本生成一个简短的标题（5-15 个字，中文用中文，英文用英文）。要求：
- 概括整段内容的核心主题，不只是开头
- 不要加引号、不要加"标题："前缀
- 单行输出，不要解释

转录文本：
${input}`;

    try {
      const spec = this.cleanupSpec();
      const raw = await this.client.generate({
        model: spec.model,
        prompt,
        system: 'You generate concise topic titles. Output only the title text — no quotes, no labels, no explanation.',
        temperature: 0.2,
        think: false,
        ...(spec.keepAlive ? { keep_alive: spec.keepAlive } : {}),
      });

      // Clean common artifacts: surrounding quotes, "标题：" prefix, trailing punctuation, newlines.
      let title = stripLLMPrefix(raw)
        .replace(/^[「『"'"《\[（(]+/, '')
        .replace(/[」』"'"》\])）]+$/, '')
        .replace(/^(?:标题|Title|TITLE)\s*[:：]\s*/i, '')
        .replace(/\s*[。．.]+\s*$/, '')
        .split(/\r?\n/)[0]
        .trim();

      // Hard cap — model may overshoot.
      if (title.length > 40) title = title.slice(0, 40);
      return title;
    } catch (err) {
      console.warn('[TextOptimizer] generateTitle failed:', err);
      return '';
    }
  }

  /**
   * Score capture importance 0-10. Used to filter TODAY events:
   *  - 0-2: AI-command-style or low-content ("用这个" / "测试一下") → folded into brief tail
   *  - 3-4: short notes worth keeping but not first-class on dashboard
   *  - 5-7: substantive thought / note → standalone card
   *  - 8-10: meeting-grade, decisions/action items → top of TODAY
   *
   * Runs on cleanup-spec tier; non-fatal on failure (returns 0).
   */
  async scoreImportance(
    transcript: string,
    meta: { durationSec: number; speakerCount: number; mediaType: string },
  ): Promise<{ score: number; reason: string }> {
    const trimmed = transcript.trim();
    if (trimmed.length < 8) return { score: 0, reason: 'too short' };

    const MAX_INPUT = 1500;
    const input = trimmed.length > MAX_INPUT ? trimmed.slice(0, MAX_INPUT) + '...' : trimmed;

    const prompt = `根据以下转录文本评估其作为"今日事件"的重要性。

重要内容（评 5-10 分）：
- 包含具体决策、承诺、计划
- 提到人名、时间、金额、具体方案
- 多人对话或会议
- 较长的思考记录或学习总结

不重要内容（评 0-2 分）：
- AI 指令型："用这个"、"测试一下"、"看看效果"、"再试一次"
- 无意义短句、口头禅、重复
- 仅向 AI 助手发出的简短指令

返回 JSON：{ "score": 0-10 数值, "reason": "简短理由（30 字内）" }

元信息：时长 ${meta.durationSec}s，说话人 ${meta.speakerCount}，类型 ${meta.mediaType}

转录文本：
${input}`;

    try {
      const spec = this.cleanupSpec();
      const raw = await this.client.generateJSON<{ score?: number; reason?: string }>({
        model: spec.model,
        prompt,
        system: 'You score capture importance for a personal voice notebook. Output only valid JSON.',
        format: 'json',
        temperature: 0,
        think: false,
        ...(spec.keepAlive ? { keep_alive: spec.keepAlive } : {}),
      });
      const rawScore = typeof raw.score === 'number' && !isNaN(raw.score) ? raw.score : 0;
      const score = Math.max(0, Math.min(10, rawScore));
      const reason = typeof raw.reason === 'string' ? raw.reason.slice(0, 200) : '';
      return { score, reason };
    } catch (err) {
      console.warn('[TextOptimizer] scoreImportance failed:', err);
      return { score: 0, reason: '' };
    }
  }

  /**
   * Detect whether a set of consecutive recordings share a coherent topic.
   * Returns isCoherent=false to reject grouping (caller will split them).
   * isCoherent=true → topic + summary populated when LLM provided them.
   *
   * Single-member input is trivially coherent (no LLM call). Errors default
   * to isCoherent=true with empty fields so the pipeline never crashes on a
   * detection failure (worst case: a session lacks a nice topic for a while).
   */
  async detectSessionTopic(
    members: Array<{ transcript: string; durationSec: number }>,
  ): Promise<{ topic: string; summary: string; isCoherent: boolean }> {
    if (members.length <= 1) return { topic: '', summary: '', isCoherent: true };

    const formatted = members
      .map((m, i) => `[${i + 1}] (${m.durationSec}s) ${m.transcript.trim().slice(0, 300)}`)
      .join('\n');

    const prompt = `判断以下 ${members.length} 段连续录音是否围绕同一主题。

严格判断：只有当它们明显讨论的是同一件事时才算同主题。
若主题各异、跳跃 → isCoherent=false。

如果同主题：
- topic: 5-15 字主题名（中文用中文）
- summary: 50-100 字总结

返回 JSON：{ "topic": "...", "summary": "...", "isCoherent": true|false }

录音段：
${formatted}`;

    try {
      const spec = this.cleanupSpec();
      const raw = await this.client.generateJSON<{ topic?: string; summary?: string; isCoherent?: boolean }>({
        model: spec.model,
        prompt,
        system: 'You judge whether recordings share a topic. Output only valid JSON.',
        format: 'json',
        temperature: 0,
        think: false,
        ...(spec.keepAlive ? { keep_alive: spec.keepAlive } : {}),
      });
      return {
        topic: typeof raw.topic === 'string' ? raw.topic.trim().slice(0, 40) : '',
        summary: typeof raw.summary === 'string' ? raw.summary.trim().slice(0, 200) : '',
        isCoherent: raw.isCoherent !== false, // default true on missing field
      };
    } catch (err) {
      console.warn('[TextOptimizer] detectSessionTopic failed:', err);
      return { topic: '', summary: '', isCoherent: true };
    }
  }

  async generateMeetingNotes(
    segments: MeetingSegment[],
    meta: { date: string; duration: number },
  ): Promise<MeetingNotes> {
    const CHUNK_SEGMENTS = 30;

    // Compute speaker stats from ALL segments (always full data)
    const speakerStats = new Map<string, number>();
    for (const s of segments) {
      speakerStats.set(s.speaker, (speakerStats.get(s.speaker) || 0) + (s.endTime - s.startTime));
    }

    if (segments.length <= CHUNK_SEGMENTS) {
      const prompt = buildMeetingNotesPrompt(segments, meta);
      const notes = await this.client.generateJSON<MeetingNotes>({
        model: this.model,
        prompt,
        temperature: 0.2,
        think: false,
      });
      notes.participants = notes.participants.map((p) => ({
        ...p,
        speakingTime: speakerStats.get(p.name) || p.speakingTime,
      }));
      return notes;
    }

    // Chunked: extract key points from each chunk, then merge into final notes
    const chunkGroups = splitArrayIntoChunks(segments, CHUNK_SEGMENTS);
    console.log(`[TextOptimizer] generateMeetingNotes: splitting ${segments.length} segments into ${chunkGroups.length} chunks`);

    const chunkSummaries: string[] = [];
    const allDecisions: string[] = [];
    const allActionItems: MeetingNotes['actionItems'] = [];
    const allTopics: string[] = [];

    for (let ci = 0; ci < chunkGroups.length; ci++) {
      try {
        const prompt = buildMeetingNotesPrompt(chunkGroups[ci], meta);
        const result = await this.client.generateJSON<MeetingNotes>({
          model: this.model,
          prompt,
          temperature: 0.2,
          think: false,
        });
        chunkSummaries.push(result.discussionSummary || '');
        if (result.decisions) allDecisions.push(...result.decisions);
        if (result.actionItems) allActionItems.push(...result.actionItems);
        if (result.keyTopics) allTopics.push(...result.keyTopics);
      } catch (err) {
        console.warn(`[TextOptimizer] meetingNotes chunk ${ci + 1} failed, skipping:`, err);
      }
    }

    // Final merge pass
    const mergePrompt = `你是一个会议纪要合并助手。请将多个分段的会议纪要合并为一份完整的会议纪要。所有输出必须使用简体中文。

会议日期：${meta.date}
会议时长：${formatMinSec(meta.duration)}

各段讨论摘要：
${chunkSummaries.map((s, i) => `[第${i + 1}部分] ${s}`).join('\n')}

已提取的决策：${allDecisions.join('；') || '无'}
已提取的待办事项：${allActionItems.map(a => `${a.assignee}: ${a.task}`).join('；') || '无'}
已提取的主题：${allTopics.join('、') || '无'}

请以 JSON 格式输出合并后的会议纪要：
{
  "title": "会议主题（简短概括）",
  "discussionSummary": "讨论内容概要（2-3句话，综合所有分段）",
  "keyTopics": ["主题1", "主题2"]
}`;

    try {
      const merged = await this.client.generateJSON<{ title: string; discussionSummary: string; keyTopics: string[] }>({
        model: this.model,
        prompt: mergePrompt,
        temperature: 0.2,
        think: false,
      });

      const notes: MeetingNotes = {
        title: merged.title,
        participants: Array.from(speakerStats.entries()).map(([name, time]) => ({ name, speakingTime: time })),
        decisions: [...new Set(allDecisions)],
        actionItems: allActionItems,
        discussionSummary: merged.discussionSummary,
        keyTopics: merged.keyTopics || [...new Set(allTopics)],
      };
      return notes;
    } catch {
      // Fallback: use first chunk's title
      return {
        title: `${meta.date} 会议记录`,
        participants: Array.from(speakerStats.entries()).map(([name, time]) => ({ name, speakingTime: time })),
        decisions: [...new Set(allDecisions)],
        actionItems: allActionItems,
        discussionSummary: chunkSummaries.join(' '),
        keyTopics: [...new Set(allTopics)].slice(0, 5),
      };
    }
  }

  async correctSpeakerAttribution(
    segments: Array<{ speaker: string; text: string; start: number; end: number }>,
  ): Promise<Array<{ speaker: string; text: string; start: number; end: number }>> {
    const speakers = [...new Set(segments.map(s => s.speaker))];
    if (speakers.length <= 1 || segments.length < 3) return segments;

    const inputLines = segments.map(s => `${s.speaker}: ${s.text}`);
    const inputText = inputLines.join('\n');
    if (inputText.length < 50) return segments;

    const template = getPipelinePrompt('speakerCorrection');
    const prompt = template.replace(/\{\{text\}\}/g, inputText);

    try {
      // Race with 30s timeout — speaker correction is best-effort, must not block pipeline
      const CORRECTION_TIMEOUT = 30_000;
      const response = await Promise.race([
        this.client.generate({
          model: this.model,
          prompt,
          temperature: 0.1,
          think: false,
        }),
        new Promise<string>((_, reject) =>
          setTimeout(() => reject(new Error('Speaker correction timeout (30s)')), CORRECTION_TIMEOUT),
        ),
      ]);

      const outputLines = response.trim().split('\n').filter(l => l.trim());
      if (outputLines.length !== segments.length) {
        console.warn(`[TextOptimizer] Speaker correction: line count mismatch (${outputLines.length} vs ${segments.length}), skipping`);
        return segments;
      }

      let corrections = 0;
      const corrected = segments.map((seg, i) => {
        const line = outputLines[i];
        const match = line.match(/^(.+?)[:：]\s*/);
        if (!match) return seg;
        const newSpeaker = match[1].trim();
        if (!speakers.includes(newSpeaker)) return seg;
        if (newSpeaker !== seg.speaker) corrections++;
        return { ...seg, speaker: newSpeaker };
      });

      if (corrections > 0) {
        console.log(`[TextOptimizer] Speaker correction: fixed ${corrections}/${segments.length} segments`);
      }
      return corrected;
    } catch (err: any) {
      console.warn(`[TextOptimizer] Speaker correction failed: ${err.message?.slice(0, 100)}`);
      return segments;
    }
  }
}
