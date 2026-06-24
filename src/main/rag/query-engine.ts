import type { LLMClient } from '../llm/llm-client';
import { getLLMModel } from '../llm/create-client';
import { EmbeddingCache } from '../llm/embedding-cache';
import { VectorStore } from './vector-store';
import { rrfMerge, type RRFSource } from './hybrid-search';
import { VoiceBrainDB } from '../db/database';
import { loadSettings } from '../settings';
import { loadSoulContext, buildSoulSystemPrompt } from '../agent/soul';
import { MemoryManager } from '../agent/memory-manager';
import { getStr, getLang } from '../i18n';
import { formatLocalDate } from '../utils/date';
import { QueryAnalyzer, type QueryIntent, type TemporalRange, type ChatTurn } from './query-analyzer';

const DEFAULT_EMBED_MODEL = 'bge-m3';

// Scoped (per-recording) RAG tunables
const CHARS_PER_TOKEN = 1.5;
const RETRIEVAL_BUDGET_RATIO = 0.6;
const MIN_SEGMENT_BUDGET = 1500;
const SCOPED_VECTOR_TOPK = 30;
const SCOPED_FTS_RAW = 100;
const SCOPED_FTS_KEEP = 30;
const SCOPED_VECTOR_WEIGHT = 0.7;
const SCOPED_FTS_WEIGHT = 0.3;
const MAX_HISTORY_TURNS = 6;

// ─── Text Cleaning ────────────────────────────────────────

/** Strip LLM meta-commentary from clean_text (e.g. "如果需要更具体的语境...", "原文已经非常简洁...") */
function stripMetaCommentary(text: string): string {
  if (!text) return text;
  // Split at double newline — meta-commentary is usually after the first blank line
  const parts = text.split(/\n\n/);
  if (parts.length <= 1) return text.trim();
  // Check if trailing parts look like LLM commentary
  const metaPatterns = /^[（(（]|^注[：:]|^请注意|^如果需要|^原文|^以上是|^根据|^由于|^备注/;
  const cleaned: string[] = [parts[0]];
  for (let i = 1; i < parts.length; i++) {
    if (metaPatterns.test(parts[i].trim())) break; // Stop at first meta comment
    cleaned.push(parts[i]);
  }
  return cleaned.join('\n\n').trim();
}

/** Get the best available text for a segment, with meta-commentary stripped */
function getSegmentText(seg: any): string {
  const clean = seg?.clean_text ? stripMetaCommentary(seg.clean_text) : '';
  const raw = seg?.raw_text || '';
  // If cleaned version is too short or empty after stripping, prefer raw
  if (clean.length < 3 && raw.length > 0) return raw;
  return clean || raw;
}

/** Format a MeetingNotes object as a compact prompt block (Chinese labels). */
function formatMeetingNotesForPrompt(mn: any): string {
  if (!mn) return '';
  const lines: string[] = [];
  if (mn.title) lines.push(`标题: ${mn.title}`);
  if (mn.discussionSummary) lines.push(`摘要: ${mn.discussionSummary}`);
  if (Array.isArray(mn.keyTopics) && mn.keyTopics.length > 0) {
    lines.push(`关键议题: ${mn.keyTopics.join('；')}`);
  }
  if (Array.isArray(mn.decisions) && mn.decisions.length > 0) {
    lines.push(`决策:\n${mn.decisions.map((d: string) => `- ${d}`).join('\n')}`);
  }
  if (Array.isArray(mn.actionItems) && mn.actionItems.length > 0) {
    lines.push(`行动项:\n${mn.actionItems.map((a: any) =>
      `- ${a.assignee || '未指派'}: ${a.task}${a.dueDate ? ` (截止 ${a.dueDate})` : ''}`
    ).join('\n')}`);
  }
  if (Array.isArray(mn.participants) && mn.participants.length > 0) {
    lines.push(`参与者: ${mn.participants.map((p: any) => p.name).join('、')}`);
  }
  return lines.join('\n');
}

/** Format extracted todos + decisions for a planning-intent prompt block. */
function formatExtractedItemsForPrompt(todos: any[], decisions: any[]): string {
  const parts: string[] = [];
  if (todos.length > 0) {
    parts.push('待办:\n' + todos.map((t) =>
      `- [${t.status === 'completed' ? 'x' : ' '}] ${t.content}` +
      (t.due_date ? ` (截止 ${t.due_date})` : '') +
      (t.related_person ? ` — ${t.related_person}` : '')
    ).join('\n'));
  }
  if (decisions.length > 0) {
    parts.push('决策:\n' + decisions.map((d) => `- ${d.content}`).join('\n'));
  }
  return parts.join('\n\n');
}

function todayStr(): string {
  return formatLocalDate();
}

// ─── QueryEngine ──────────────────────────────────────────

export class QueryEngine {
  private local: LLMClient;
  private vectorStore: VectorStore;
  private db: VoiceBrainDB;
  private embedModel: string;
  private embedClient: LLMClient;
  private embeddingCache = new EmbeddingCache();
  private memoryManager?: MemoryManager;
  private cachedSoulPrompt: string = '';
  private cachedSoulHash: string = '';
  private analyzer: QueryAnalyzer;

  constructor(
    db: VoiceBrainDB,
    vectorStore: VectorStore,
    local: LLMClient,
    embedModel?: string,
    embedClient?: LLMClient,
    analyzer?: QueryAnalyzer,
  ) {
    this.local = local;
    this.vectorStore = vectorStore;
    this.db = db;
    this.embedModel = embedModel || DEFAULT_EMBED_MODEL;
    this.embedClient = embedClient || local;
    // Default to using the same client + main model when no explicit analyzer
    // is injected — the wiring layer should pass a paste-clean tier analyzer
    // for best latency, but this fallback keeps QueryEngine constructible
    // in tests and legacy callers.
    this.analyzer = analyzer || new QueryAnalyzer(local, getLLMModel(loadSettings()));
  }

  setMemoryManager(mm: MemoryManager): void {
    this.memoryManager = mm;
  }

  /** Generate embedding for a segment and store it in the vector store. */
  async indexSegment(segmentId: number, text: string): Promise<void> {
    const embedding = await this.cachedEmbed(text);
    this.vectorStore.insert(segmentId, embedding);
  }

  /** Remove vector entries for given segment IDs (used during reprocessing). */
  deleteSegments(segmentIds: number[]): void {
    this.vectorStore.deleteSegments(segmentIds);
  }

  /** Non-streaming query (backward compatible). */
  async query(question: string): Promise<{
    answer: string;
    sources: Array<{
      segment_id: number;
      speaker: string;
      text: string;
      time: string;
    }>;
  }> {
    const { context, sources, queryEmbedding } = await this.gatherContext(question);
    const settings = loadSettings();
    const llmModel = getLLMModel(settings);
    const today = todayStr();

    const answer = await this.local.generate({
      model: llmModel,
      system: await this.buildSystemPrompt(today, question, queryEmbedding),
      prompt: this.buildUserPrompt(question, context),
      temperature: 0.3,
      num_ctx: 4096,
      keep_alive: '30m',
      think: false,
    });

    return { answer, sources };
  }

  /** Streaming query — sends text chunks via callback, returns sources at end. */
  async queryStream(
    question: string,
    onChunk: (text: string) => void,
    onStatus?: (status: string) => void,
    signal?: AbortSignal,
  ): Promise<{
    sources: Array<{
      segment_id: number;
      recording_id?: number;
      speaker: string;
      text: string;
      time: string;
      source_type?: string;
      url?: string;
    }>;
  }> {
    const t0 = Date.now();
    const ts = (label: string) => console.log(`[RAG] ⏱ ${label}: +${Date.now() - t0}ms`);

    onStatus?.('searching');
    console.log(`[RAG] ═══════════════════════════════════════`);
    console.log(`[RAG] Query START: "${question}"`);
    console.log(`[RAG] ═══════════════════════════════════════`);
    ts('start gatherContext');
    const { context, sources, queryEmbedding } = await this.gatherContext(question);
    ts('gatherContext done');
    console.log(`[RAG] gatherContext returned: ${context.length} chars, ${sources.length} sources`);

    const settings = loadSettings();
    const llmModel = getLLMModel(settings);
    const today = todayStr();

    ts('start buildSystemPrompt');
    const systemPrompt = await this.buildSystemPrompt(today, question, queryEmbedding);
    ts(`buildSystemPrompt done (${systemPrompt.length} chars)`);

    const userPrompt = this.buildUserPrompt(question, context);
    ts(`buildUserPrompt done (${userPrompt.length} chars)`);

    const totalInputChars = systemPrompt.length + userPrompt.length;
    console.log(`[RAG] ⏱ Total input: ~${totalInputChars} chars (~${Math.round(totalInputChars / 1.5)} tokens), model=${llmModel}`);

    onStatus?.('generating');
    const tGen0 = Date.now();
    let firstChunk = true;
    ts('start generateStream');
    await this.local.generateStream(
      {
        model: llmModel,
        system: systemPrompt,
        prompt: userPrompt,
        temperature: 0.3,
        num_ctx: 4096,
        keep_alive: '30m',
        think: false,
      },
      (chunk) => {
        if (firstChunk) {
          console.log(`[RAG] First token: ${Date.now() - tGen0}ms after generate start, ${Date.now() - t0}ms total`);
          firstChunk = false;
        }
        onChunk(chunk);
      },
      signal,
    );
    console.log(`[RAG] Generation complete: ${Date.now() - t0}ms total`);

    return { sources };
  }

  /** Per-recording streaming Q&A with full RAG: condense → retrieve → inject curated summary → stream. */
  async queryScopedStream(
    question: string,
    recordingId: number,
    onChunk: (text: string) => void,
    onStatus?: (status: string) => void,
    signal?: AbortSignal,
    history?: Array<{ role: 'user' | 'assistant'; content: string }>,
  ): Promise<{
    sources: Array<{
      segment_id: number;
      recording_id?: number;
      speaker: string;
      text: string;
      time: string;
    }>;
  }> {
    const t0 = Date.now();
    const sts = (label: string) => console.log(`[RAG] ⏱ scoped ${label}: +${Date.now() - t0}ms`);

    const settings = loadSettings();
    const llmModel = getLLMModel(settings);
    const modelCtx = (settings as any).llmContextWindow || 4096;

    // Single LLM-based query analysis covers intent classification, temporal
    // anchoring, entity extraction, and pronoun resolution against history —
    // replaces the prior parseIntent + REFERENCE_RE + condenseQuestion chain.
    onStatus?.('rewriting');
    const analysisPromise = this.analyzer
      .analyze(question, todayStr(), history as ChatTurn[] | undefined)
      .then((a) => { sts('analyze done'); return a; });

    const segments = this.db.getSegmentsByRecording(recordingId);
    const recording = this.db.getRecording(recordingId);
    let meetingNotes: any = null;
    try { meetingNotes = this.db.getMeetingNotes(recordingId); } catch { /* optional */ }
    sts(`loaded ${segments.length} segments`);

    const analysis = await analysisPromise;
    const intent: QueryIntent = analysis.intent;
    const searchQuery = analysis.rewritten_query;
    if (searchQuery !== question) {
      console.log(`[RAG] Scoped rewrite: "${question}" → "${searchQuery}"`);
    }
    onStatus?.('searching');

    const totalBudget = Math.floor(modelCtx * CHARS_PER_TOKEN * RETRIEVAL_BUDGET_RATIO);
    const sections: string[] = [];
    let charUsed = 0;

    if (recording) {
      const date = recording.recorded_at || recording.processed_at || '';
      const dur = recording.duration_seconds
        ? ` | 时长: ${Math.floor(recording.duration_seconds / 60)}分${Math.floor(recording.duration_seconds % 60)}秒`
        : '';
      const meta = `文件: ${recording.file_name}${date ? ` | 日期: ${date.split('T')[0]}` : ''}${dur}`;
      sections.push(`【录音元数据】\n${meta}`);
      charUsed += meta.length;
    }

    if (meetingNotes) {
      const mnBlock = formatMeetingNotesForPrompt(meetingNotes);
      if (mnBlock) {
        sections.push(`【会议要点（已生成的总结）】\n${mnBlock}`);
        charUsed += mnBlock.length + 20;
      }
    }

    if (intent === 'planning') {
      try {
        const items = this.db.getExtractedItemsByRecording(recordingId);
        const block = formatExtractedItemsForPrompt(
          items.filter((i) => i.type === 'todo'),
          items.filter((i) => i.type === 'decision'),
        );
        if (block) {
          sections.push(`【提取项】\n${block}`);
          charUsed += block.length + 20;
        }
      } catch (err) {
        console.log(`[RAG] Scoped extracted items error: ${err}`);
      }
    }

    const segmentBudget = Math.max(totalBudget - charUsed, MIN_SEGMENT_BUDGET);
    const segLines: string[] = [];
    const sources: Array<{
      segment_id: number;
      recording_id?: number;
      speaker: string;
      text: string;
      time: string;
    }> = [];
    let queryEmbedding: number[] | undefined;

    if (segments.length > 0) {
      const segIds = segments.map((s) => s.id);
      const segMap = new Map(segments.map((s) => [s.id, s]));
      const allowSet = new Set(segIds);

      // Embed (network) and FTS (sync, fast) in parallel.
      const [embedResult, ftsResult] = await Promise.allSettled([
        this.cachedEmbed(searchQuery),
        Promise.resolve().then(() => this.db.searchSegmentsFts(searchQuery, SCOPED_FTS_RAW)),
      ]);

      const rrfSources: RRFSource[] = [];

      if (embedResult.status === 'fulfilled') {
        queryEmbedding = embedResult.value;
        try {
          const vec = this.vectorStore.searchScoped(queryEmbedding, segIds, SCOPED_VECTOR_TOPK);
          if (vec.length > 0) {
            rrfSources.push({
              items: vec.map((r) => ({ id: r.segment_id, distance: r.distance })),
              weight: SCOPED_VECTOR_WEIGHT,
            });
          }
          sts(`vector search → ${vec.length}`);
        } catch (err) {
          console.log(`[RAG] Scoped vector search error: ${err}`);
        }
      } else {
        console.log(`[RAG] Scoped embed failed: ${embedResult.reason}`);
      }

      if (ftsResult.status === 'fulfilled') {
        const fts = ftsResult.value;
        const filtered = fts.filter((r) => allowSet.has(r.id)).slice(0, SCOPED_FTS_KEEP);
        if (filtered.length > 0) {
          rrfSources.push({
            items: filtered.map((r, i) => ({ id: r.id, rank: i })),
            weight: SCOPED_FTS_WEIGHT,
          });
        }
        sts(`fts search → ${filtered.length}/${fts.length}`);
      } else {
        console.log(`[RAG] Scoped FTS search error: ${ftsResult.reason}`);
      }

      const ranked: number[] = rrfSources.length > 0
        ? rrfMerge(rrfSources).map((m) => m.id)
        : segIds.slice();

      // Anchor with first segment + last two — supports "开头/结尾/最后讨论了什么" style questions
      // even when retrieval misses them.
      const anchorIds: number[] = [];
      if (segIds.length > 0) anchorIds.push(segIds[0]);
      if (segIds.length >= 3) anchorIds.push(segIds[segIds.length - 2]);
      if (segIds.length >= 2) anchorIds.push(segIds[segIds.length - 1]);

      const seenOrder = new Set<number>();
      const finalOrder: number[] = [];
      for (const id of ranked) if (!seenOrder.has(id)) { finalOrder.push(id); seenOrder.add(id); }
      for (const id of anchorIds) if (!seenOrder.has(id)) { finalOrder.push(id); seenOrder.add(id); }

      const includeSet = new Set<number>();
      let charsUsedInSegs = 0;
      for (const id of finalOrder) {
        const seg = segMap.get(id);
        if (!seg) continue;
        const text = getSegmentText(seg);
        if (!text) continue;
        const line = `[${formatTime(seg.start_time)}] ${seg.speaker_name || 'Unknown'}: ${text}`;
        if (charsUsedInSegs + line.length + 1 > segmentBudget) {
          if (includeSet.size === 0) {
            includeSet.add(id);
            charsUsedInSegs += Math.min(line.length + 1, segmentBudget);
          }
          break;
        }
        includeSet.add(id);
        charsUsedInSegs += line.length + 1;
      }

      // Emit chronologically (one pass over included only) — helps the LLM follow the flow.
      const includedSegs = [...includeSet]
        .map((id) => segMap.get(id)!)
        .sort((a, b) => (a.start_time ?? 0) - (b.start_time ?? 0));
      for (const seg of includedSegs) {
        const text = getSegmentText(seg);
        if (!text) continue;
        const time = formatTime(seg.start_time);
        const speaker = seg.speaker_name || 'Unknown';
        segLines.push(`[${time}] ${speaker}: ${text}`);
        sources.push({ segment_id: seg.id, recording_id: recordingId, speaker, text, time });
      }

      if (segLines.length > 0) {
        const truncTag = segLines.length < segments.length
          ? `（已按相关性筛选 ${segLines.length}/${segments.length} 段）`
          : `（共 ${segments.length} 段）`;
        sections.push(`【相关片段，按时间排序 ${truncTag}】\n${segLines.join('\n')}`);
        charUsed += charsUsedInSegs;
      }
    }

    if (sections.length === 0) {
      sections.push('（该录音暂无可用上下文）');
    }

    const context = sections.join('\n\n');
    console.log(
      `[RAG] Scoped context: recording=${recordingId} intent=${intent} ` +
      `segs=${segments.length} included=${segLines.length} chars=${charUsed} budget=${totalBudget}`
    );

    const today = todayStr();
    const systemPrompt = await this.buildSystemPrompt(today, searchQuery, queryEmbedding);

    let userPrompt: string;
    if (history && history.length > 0) {
      const tail = history.slice(-MAX_HISTORY_TURNS);
      const histBlock = tail.map((h) =>
        `${h.role === 'user' ? '【用户】' : '【助手】'} ${h.content}`
      ).join('\n\n');
      userPrompt =
        `${getStr('rag.user_prompt_header')}\n\n${context}\n\n---\n\n` +
        `【对话历史】\n${histBlock}\n\n---\n\n` +
        `${getStr('rag.user_question')(question)}\n\n${getStr('rag.user_prompt_footer')}`;
    } else {
      userPrompt = this.buildUserPrompt(question, context);
    }

    onStatus?.('generating');
    let firstChunk = true;
    const tGen0 = Date.now();
    await this.local.generateStream(
      {
        model: llmModel,
        system: systemPrompt,
        prompt: userPrompt,
        temperature: 0.3,
        num_ctx: modelCtx,
        keep_alive: '30m',
        think: false,
      },
      (chunk) => {
        if (firstChunk) {
          console.log(`[RAG] Scoped first token: ${Date.now() - tGen0}ms after generate start, ${Date.now() - t0}ms total`);
          firstChunk = false;
        }
        onChunk(chunk);
      },
      signal,
    );
    console.log(`[RAG] Scoped generation complete: ${Date.now() - t0}ms total`);

    return { sources };
  }

  // ─── Private helpers ───────────────────────────────────

  private async cachedEmbed(text: string): Promise<number[]> {
    const cached = this.embeddingCache.get(this.embedModel, text);
    if (cached) return cached;

    let lastError: any;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const embedding = await this.embedClient.embed(this.embedModel, text);
        if (!Array.isArray(embedding) || embedding.length === 0) {
          throw new Error(`Embedding returned empty vector for model ${this.embedModel}`);
        }
        this.embeddingCache.set(this.embedModel, text, embedding);
        return embedding;
      } catch (err: any) {
        lastError = err;
        if (attempt < 3) {
          console.warn(`[RAG] Embedding failed for model ${this.embedModel}, retrying (${attempt}/3): ${err?.message}`);
          await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
        }
      }
    }

    console.warn(`[RAG] Embedding failed for model ${this.embedModel}: ${lastError?.message}`);
    throw lastError;
  }

  /** Dynamic context budget based on query intent. */
  private computeBudget(intent: QueryIntent): { total: number; wiki: number } {
    const settings = loadSettings();
    const modelCtx = (settings as any).llmContextWindow || 4096;
    const maxChars = Math.floor(modelCtx * 1.5 * 0.6);
    const budgets: Record<QueryIntent, { total: number; wikiRatio: number }> = {
      factual: { total: Math.min(2500, maxChars), wikiRatio: 0.6 },
      person: { total: Math.min(4000, maxChars), wikiRatio: 0.7 },
      summary: { total: Math.min(5000, maxChars), wikiRatio: 0.5 },
      planning: { total: Math.min(5000, maxChars), wikiRatio: 0.4 },
    };
    const b = budgets[intent];
    return { total: b.total, wiki: Math.floor(b.total * b.wikiRatio) };
  }

  /**
   * Search knowledge pages using hybrid (vector + FTS + entity) search with RRF merge.
   * Returns top 5 pages with metadata.
   */
  private searchWiki(
    question: string,
    entities: string[],
    queryEmbed: number[],
  ): Array<{ id: number; content: string; title: string; slug: string; type: string; summary: string }> {
    const sources: RRFSource[] = [];

    // 1. Vector search on knowledge_page_vectors
    try {
      const vecResults = this.vectorStore.searchPages(queryEmbed, 10);
      if (vecResults.length > 0) {
        sources.push({
          items: vecResults.map((r) => ({ id: r.page_id, distance: r.distance })),
          weight: 0.5,
        });
      }
    } catch (err) {
      console.log(`[RAG] Wiki vector search error: ${err}`);
    }

    // 2. FTS search on knowledge_pages_fts
    try {
      const ftsResults = this.db.searchKnowledgePagesFts(question, 10);
      if (ftsResults.length > 0) {
        sources.push({
          items: ftsResults.map((r, i) => ({ id: r.id, rank: i })),
          weight: 0.3,
        });
      }
    } catch (err) {
      console.log(`[RAG] Wiki FTS search error: ${err}`);
    }

    // 3. Entity match — pages whose slug matches extracted entities
    if (entities.length > 0) {
      const entityPages: Array<{ id: number; rank: number }> = [];
      for (const entity of entities) {
        try {
          const pages = this.db.getKnowledgePagesBySlugPrefix(entity);
          for (const p of pages) {
            if (!entityPages.some((ep) => ep.id === p.id)) {
              entityPages.push({ id: p.id, rank: entityPages.length });
            }
          }
        } catch { /* ignore */ }
      }
      if (entityPages.length > 0) {
        sources.push({
          items: entityPages.map((ep) => ({ id: ep.id, rank: ep.rank })),
          weight: 0.2,
        });
      }
    }

    if (sources.length === 0) return [];

    // RRF merge
    const merged = rrfMerge(sources);
    const top5 = merged.slice(0, 5);

    // Hydrate page data
    const results: Array<{ id: number; content: string; title: string; slug: string; type: string; summary: string }> = [];
    for (const item of top5) {
      try {
        const page = this.db.getKnowledgePage(item.id);
        if (page) {
          results.push({
            id: page.id,
            content: page.content_markdown || '',
            title: page.title || '',
            slug: page.slug || '',
            type: page.type || '',
            summary: page.summary || '',
          });
        }
      } catch { /* ignore */ }
    }
    return results;
  }

  /**
   * Hybrid segment search (vector + FTS) with RRF merge and optional time filtering.
   * Returns formatted lines within charBudget.
   */
  private hybridSegmentSearch(
    question: string,
    queryEmbed: number[],
    timeRange: TemporalRange | null,
    charBudget: number,
  ): {
    lines: string[];
    charUsed: number;
    sources: Array<{
      segment_id: number;
      recording_id?: number;
      speaker: string;
      text: string;
      time: string;
      source_type?: string;
    }>;
  } {
    const sources: RRFSource[] = [];

    // 1. Vector search on segment_vectors
    try {
      const vecResults = this.vectorStore.search(queryEmbed, 15);
      if (vecResults.length > 0) {
        sources.push({
          items: vecResults.map((r) => ({ id: r.segment_id, distance: r.distance })),
          weight: 0.7,
        });
      }
    } catch (err) {
      console.log(`[RAG] Segment vector search error: ${err}`);
    }

    // 2. FTS search on segments_fts
    try {
      const ftsResults = this.db.searchSegmentsFts(question, 15);
      if (ftsResults.length > 0) {
        sources.push({
          items: ftsResults.map((r, i) => ({ id: r.id, rank: i })),
          weight: 0.3,
        });
      }
    } catch (err) {
      console.log(`[RAG] Segment FTS search error: ${err}`);
    }

    if (sources.length === 0) return { lines: [], charUsed: 0, sources: [] };

    // RRF merge
    let merged = rrfMerge(sources);

    // Time filter if temporal range present
    if (timeRange) {
      const startDate = timeRange.start;
      const endDate = timeRange.end;
      const filtered = merged.filter((item) => {
        try {
          const seg = this.db.getSegment(item.id);
          if (!seg) return false;
          const rec = seg.recording_id ? this.db.getRecording(seg.recording_id) : null;
          const recDate = (rec?.recorded_at || rec?.processed_at || '').split('T')[0];
          return recDate >= startDate && recDate <= endDate;
        } catch { return false; }
      });
      // Honest behavior: if the user anchored to a time window and nothing
      // matches that window, return empty. Don't silently fall back to
      // unfiltered content — that's how "今天我干了什么" got answered with
      // segments from last week. Empty result lets Phase 5 fallback or the
      // system prompt explain truthfully that no data matched.
      merged = filtered;
      if (filtered.length === 0) {
        console.log(`[RAG] Segment time filter removed all results — returning empty (no fallback to unfiltered)`);
      }
    }

    // Take top results and format within budget
    const top = merged.slice(0, 10);
    const lines: string[] = [];
    let charUsed = 0;
    const segSources: Array<{
      segment_id: number;
      recording_id?: number;
      speaker: string;
      text: string;
      time: string;
      source_type?: string;
    }> = [];

    for (const item of top) {
      if (charUsed >= charBudget) break;
      try {
        const seg = this.db.getSegment(item.id);
        if (!seg) continue;
        const text = getSegmentText(seg);
        if (!text) continue;
        const timeStr = formatTime(seg.start_time);
        const speaker = seg.speaker_name || 'Unknown';
        const line = `[${timeStr}] ${speaker}: ${text}`;
        if (charUsed + line.length + 1 > charBudget) break;
        lines.push(line);
        charUsed += line.length + 1;
        segSources.push({
          segment_id: item.id,
          recording_id: seg.recording_id as number | undefined,
          speaker,
          text,
          time: timeStr,
          source_type: 'segment',
        });
      } catch { /* ignore */ }
    }

    console.log(`[RAG] Hybrid segment search: ${merged.length} merged → ${lines.length} included (${charUsed} chars)`);
    return { lines, charUsed, sources: segSources };
  }

  /** Hybrid search on generic external chunks. */
  private hybridExternalSearch(
    queryEmbed: number[] | undefined,
    charBudget: number,
    searchQuery: string,
  ): {
    lines: string[];
    charUsed: number;
    sources: Array<{
      chunk_id: number;
      external_id: string;
      title: string;
      url: string;
      text: string;
      source_type: string;
    }>;
  } {
    // 向量搜索（有 embedding 时优先）
    let rows: Array<{ id: number; external_id: string; source: string; domain: string; title: string; url: string; content: string; metadata_json: string }> = [];
    if (queryEmbed) {
      let chunks: Array<{ chunk_id: number; distance: number }> = [];
      try { chunks = this.vectorStore.searchExternalChunks(queryEmbed, 10); } catch { /* ignore */ }
      if (chunks.length > 0) {
        const fetched = this.db.getExternalChunksByIds(chunks.map((c) => c.chunk_id));
        rows = fetched as typeof rows;
      }
    }

    // 向量无结果时，FTS 文本兜底
    if (rows.length === 0 && searchQuery.trim()) {
      try {
        const dbAny = this.db as any;
        if (dbAny.searchExternalChunksByText) {
          rows = dbAny.searchExternalChunksByText(searchQuery, 10) as typeof rows;
        }
      } catch { /* ignore */ }
    }

    console.log(`[RAG] External search: ${rows.length} hits, mode=${queryEmbed ? 'vector' : 'text'}, query="${searchQuery.slice(0, 40)}"`);
    if (rows.length === 0) return { lines: [], charUsed: 0, sources: [] };

    const lines: string[] = [];
    let charUsed = 0;
    const extSources: Array<{
      chunk_id: number;
      external_id: string;
      title: string;
      url: string;
      text: string;
      source_type: string;
    }> = [];

    for (const row of rows) {
      if (charUsed >= charBudget) break;
      const text = row.content;
      if (!text || text.trim().length === 0) continue;
      const sourceLabel = row.source || 'external';
      const line = `[${sourceLabel}/${row.domain || 'data'} · ${row.title || 'Untitled'}] ${text}`;
      if (charUsed + line.length + 1 > charBudget) break;
      lines.push(line);
      charUsed += line.length + 1;
      extSources.push({
        chunk_id: row.id,
        external_id: row.external_id,
        title: row.title,
        url: row.url,
        text,
        source_type: sourceLabel,
      });
    }

    console.log(`[RAG] External search (${queryEmbed ? 'vector' : 'text'}): ${rows.length} hits → ${lines.length} included (${charUsed} chars)`);
    return { lines, charUsed, sources: extSources };
  }

  private async gatherContext(question: string): Promise<{
    context: string;
    sources: Array<{
      segment_id: number;
      recording_id?: number;
      speaker: string;
      text: string;
      time: string;
      source_type?: string;
      url?: string;
    }>;
    queryEmbedding?: number[];
  }> {
    const gc0 = Date.now();
    const gts = (label: string) => console.log(`[RAG]   ⏱ gatherContext: ${label}: +${Date.now() - gc0}ms`);

    console.log(`[RAG] ═══ gatherContext START ═══ question="${question}"`);

    // Normalize query with correction dictionary
    let normalizedQuestion = question;
    try {
      const { corrected, appliedIds } = this.db.applyCorrections(question);
      if (corrected !== question) {
        normalizedQuestion = corrected;
        for (const id of appliedIds) this.db.incrementCorrectionHitCount(id);
        console.log(`[RAG] Query normalized: "${question}" → "${normalizedQuestion}"`);
      }
    } catch { /* ignore */ }

    // LLM-based query analysis: intent + temporal anchor + entities +
    // standalone rewrite — single call replacing 4 regex parsers.
    console.log(`[RAG]   → Step 1: Query analysis (LLM call)...`);
    const analysis = await this.analyzer.analyze(normalizedQuestion, todayStr());
    const intent: QueryIntent = analysis.intent;
    const timeRange: TemporalRange | null = analysis.temporal_range;
    const entities = analysis.entities;
    const searchQuery = analysis.rewritten_query;
    console.log(`[RAG]   ← Step 1 done: intent=${intent} timeRange=${JSON.stringify(timeRange)} entities=${JSON.stringify(entities)}`);
    if (searchQuery !== normalizedQuestion) {
      console.log(`[RAG]   Query rewrite: "${normalizedQuestion}" → "${searchQuery}"`);
    }

    // Dynamic budget
    const budget = this.computeBudget(intent);
    let charUsed = 0;

    const sections: string[] = [];
    const allSources: Array<{
      segment_id: number;
      recording_id?: number;
      speaker: string;
      text: string;
      time: string;
      source_type?: string;
      url?: string;
    }> = [];

    // Embed query once (reuse everywhere)
    let cachedQueryEmbed: number[] | undefined;
    try {
      console.log(`[RAG]   → Step 2: Embedding query (model=${this.embedModel})...`);
      const tEmbed0 = Date.now();
      cachedQueryEmbed = await this.cachedEmbed(searchQuery);
      const embedMs = Date.now() - tEmbed0;
      console.log(`[RAG]   ← Step 2 done: ${cachedQueryEmbed?.length || 0} dims in ${embedMs}ms`);
      gts(`embed done (${embedMs}ms)`);
    } catch (err) {
      console.log(`[RAG]   ✗ Step 2 failed: ${err}`);
    }

    // ─── Phase 1: Wiki Search ─────────────────────────────────
    if (cachedQueryEmbed) {
      try {
        console.log(`[RAG]   → Step 3: Wiki search...`);
        const tWiki0 = Date.now();
        const wikiPages = this.searchWiki(searchQuery, entities, cachedQueryEmbed);
        console.log(`[RAG]   ← Step 3 done: ${wikiPages.length} pages in ${Date.now() - tWiki0}ms`);
        if (wikiPages.length > 0) {
          const wikiLines: string[] = [];
          let wikiChars = 0;
          for (const page of wikiPages) {
            // Use summary first, fall back to content excerpt
            const display = page.summary || page.content.slice(0, 500);
            const line = `### ${page.title} (${page.type})\n${display}`;
            if (wikiChars + line.length + 2 > budget.wiki) {
              // Add truncated version if there's space
              const remaining = budget.wiki - wikiChars;
              if (remaining > 100) {
                wikiLines.push(line.slice(0, remaining));
                wikiChars += remaining;
              }
              break;
            }
            wikiLines.push(line);
            wikiChars += line.length + 2;
          }
          if (wikiLines.length > 0) {
            sections.push(`【知识库】\n${wikiLines.join('\n\n')}`);
            charUsed += wikiChars;
            // Add wiki sources (use segment_id=0 as placeholder, tag as 'wiki')
            for (const page of wikiPages.slice(0, wikiLines.length)) {
              allSources.push({
                segment_id: 0,
                speaker: page.type,
                text: page.title,
                time: '',
                source_type: 'wiki',
              });
            }
            console.log(`[RAG] Wiki search: ${wikiPages.length} pages → ${wikiLines.length} included (${wikiChars} chars)`);
          }
        }
        gts('wiki search done');
      } catch (err) {
        console.log(`[RAG] Wiki search error: ${err}`);
      }
    }

    // ─── Phase 2: Person lookup ───────────────────────────────
    if (intent === 'person') {
      try {
        console.log(`[RAG]   → Step 4: Person lookup...`);
        const tPerson0 = Date.now();
        // Extract person name: strip common question words
        const nameQuery = searchQuery
          .replace(/谁|是谁|叫什么|什么人|who\s+is|tell\s+me\s+about/gi, '')
          .replace(/[？?，,。.！!]/g, '')
          .trim();
        if (nameQuery) {
          let person = this.db.getPersonByName(nameQuery);
          if (!person) {
            // Fuzzy match via SQL LIKE instead of loading all persons
            person = this.db.searchPersonByNameFuzzy(nameQuery);
          }
          if (person) {
            const parts: string[] = [];
            parts.push(`姓名: ${person.name}`);
            if (person.gender) parts.push(`性别: ${person.gender}`);
            if (person.company) parts.push(`公司: ${person.company}`);
            if (person.title) parts.push(`职位: ${person.title}`);
            if (person.profile_markdown) parts.push(`简介: ${person.profile_markdown}`);
            // Get recent content spoken by this person
            const contents = this.db.getContentByPerson(person.id, 5);
            if (contents.length > 0) {
              const recentTexts = contents
                .map((c: any) => c.clean_text || c.raw_text || '')
                .filter(Boolean)
                .slice(0, 3)
                .map((t: string) => `- ${t.slice(0, 100)}`);
              if (recentTexts.length > 0) {
                parts.push(`近期相关内容:\n${recentTexts.join('\n')}`);
              }
            }
            // Get relationships
            const relationships = this.db.getPersonRelationships(person.id);
            if (relationships.length > 0) {
              const relTexts = relationships.slice(0, 5).map((r: any) =>
                `- ${r.related_person_name || r.mentioned_name || '?'}: ${r.relationship || '关联'}`
              );
              parts.push(`人物关系:\n${relTexts.join('\n')}`);
            }
            const block = parts.join('\n');
            sections.push(`【人物档案】\n${block}`);
            charUsed += block.length;
            console.log(`[RAG] Person lookup: found "${person.name}" (${block.length} chars)`);
          } else {
            console.log(`[RAG] Person lookup: no match for "${nameQuery}"`);
          }
        }
        console.log(`[RAG]   ← Step 4 done: ${Date.now() - tPerson0}ms`);
      } catch (err) {
        console.log(`[RAG]   ✗ Step 4 failed: ${err}`);
      }
    }

    // ─── Phase 3: Hybrid Segment Search ───────────────────────
    console.log(`[RAG]   → Step 5: Segment search (budget=${budget.total - charUsed} chars)...`);
    const tSeg0 = Date.now();
    const segmentBudget = budget.total - charUsed;

    // ANY temporal query → date-direct retrieval first (regardless of intent).
    // Previously gated by intent === 'summary' | 'planning', which made
    // factual + temporal questions like "今天我干了什么" or "昨天发生了什么"
    // fall through to pure semantic search — and miss today entirely because
    // the user's phrasing doesn't match the recording's actual topics.
    let dateSegsFilled = false;
    if (timeRange && segmentBudget > 0) {
      try {
        const dateSegs: string[] = [];
        const current = new Date(timeRange.start + 'T00:00:00');
        const end = new Date(timeRange.end + 'T00:00:00');
        while (current <= end) {
          const dateStr = formatLocalDate(current);
          const segs = this.db.getSegmentsByDate(dateStr, 100);
          for (const seg of segs) {
            const timeStr = formatTime(seg.start_time);
            const prefix = timeStr ? `[${dateStr} ${timeStr}] ${seg.speaker_name || 'Unknown'}: ` : `[${dateStr}] `;
            dateSegs.push(`${prefix}${getSegmentText(seg)}`);
          }
          current.setDate(current.getDate() + 1);
        }
        if (dateSegs.length > 0) {
          const included: string[] = [];
          let segChars = 0;
          for (const line of dateSegs) {
            if (segChars + line.length + 1 > segmentBudget) break;
            included.push(line);
            segChars += line.length + 1;
          }
          const truncated = included.length < dateSegs.length
            ? getStr('rag.truncated')(dateSegs.length, included.length)
            : getStr('rag.truncated_all')(dateSegs.length);
          sections.push(`${getStr('rag.section_temporal')(timeRange.start, timeRange.end)} ${truncated}\n${included.join('\n')}`);
          charUsed += segChars;
          dateSegsFilled = true;
          console.log(`[RAG] Date segments: ${dateSegs.length} total, ${included.length} included (${segChars} chars)`);
        } else {
          console.log(`[RAG] Date segments: 0 results for ${timeRange.start} ~ ${timeRange.end}`);
        }
      } catch (err) {
        console.log(`[RAG] Date segments error: ${err}`);
      }
    }

    // Hybrid search for remaining budget (skip if date segments already filled the budget)
    if (!dateSegsFilled && cachedQueryEmbed && charUsed < budget.total) {
      const remaining = budget.total - charUsed;
      const { lines, charUsed: segChars, sources: segSources } = this.hybridSegmentSearch(
        searchQuery, cachedQueryEmbed, timeRange, remaining,
      );
      if (lines.length > 0) {
        sections.push(`${getStr('rag.section_semantic')}\n${lines.join('\n')}`);
        charUsed += segChars;
        allSources.push(...segSources);
      }
      console.log(`[RAG]   ← Step 5 done: ${lines.length} segments in ${Date.now() - tSeg0}ms`);
    } else if (dateSegsFilled) {
      console.log(`[RAG]   ← Step 5 skipped: date segments already filled budget`);
    }

    // ─── Phase 3.5: External Chunk Search ──────
    console.log(`[RAG]   → Step 6: External search...`);
    const tExt0 = Date.now();
    // 有向量时走向量搜索，无向量（Local 未运行/未配置）时走文本兜底，始终执行
    if (charUsed < budget.total) {
      const remaining = budget.total - charUsed;
      const { lines, charUsed: extChars, sources: extSources } = this.hybridExternalSearch(
        cachedQueryEmbed, remaining, searchQuery,
      );
      if (lines.length > 0) {
        sections.push(`[外部数据源]\n${lines.join('\n')}`);
        charUsed += extChars;
        allSources.push(...extSources.map((s) => ({
          segment_id: 0,
          recording_id: undefined as number | undefined,
          speaker: s.title,
          text: s.text,
          time: '',
          source_type: s.source_type,
          url: s.url,
        })));
      }
      console.log(`[RAG]   ← Step 6 done: ${lines.length} external chunks in ${Date.now() - tExt0}ms`);
    }

    // ─── Phase 4: Daily summaries + Extracted items ───────────
    // Daily summaries (summary / planning queries with time range)
    if ((intent === 'summary' || intent === 'planning') && timeRange && charUsed < budget.total) {
      try {
        const summaries = this.db.getDailySummariesInRange(timeRange.start, timeRange.end);
        if (summaries.length > 0) {
          const remaining = budget.total - charUsed;
          const block = summaries.map((ds: any) => {
            let text = `### ${ds.date}\n${ds.summary_text || getStr('rag.no_summary')}`;
            if (ds.key_events_json) {
              try {
                const ke = JSON.parse(ds.key_events_json);
                if (ke.todos?.length > 0) text += `\n${getStr('rag.section_todos')}: ${ke.todos.join('; ')}`;
                if (ke.decisions?.length > 0) text += `\n${getStr('rag.section_decisions')}: ${ke.decisions.join('; ')}`;
              } catch { /* ignore */ }
            }
            return text;
          }).join('\n\n').slice(0, remaining);
          sections.push(`${getStr('rag.section_daily')}\n${block}`);
          charUsed += block.length;
          console.log(`[RAG] Daily summaries: ${summaries.length} (${block.length} chars)`);
        }
      } catch (err) {
        console.log(`[RAG] Daily summaries error: ${err}`);
      }
    }

    // Extracted items (planning queries — always include, regardless of time range)
    if (intent === 'planning' && charUsed < budget.total - 200) {
      try {
        const todos = this.db.getExtractedItemsByType('todo', 50);
        const decisions = this.db.getExtractedItemsByType('decision', 50);
        const parts: string[] = [];
        if (todos.length > 0) {
          parts.push(getStr('rag.label_todos') + '\n' + todos.map((t: any) =>
            `- [${t.status === 'completed' ? 'x' : ' '}] ${t.content}${t.due_date ? ` (截止: ${t.due_date})` : ''}${t.related_person ? ` — ${t.related_person}` : ''}`
          ).join('\n'));
        }
        if (decisions.length > 0) {
          parts.push(getStr('rag.label_decisions') + '\n' + decisions.map((d: any) => `- ${d.content}`).join('\n'));
        }
        if (parts.length > 0) {
          const block = parts.join('\n\n');
          sections.push(`${getStr('rag.section_items')}\n${block}`);
          charUsed += block.length;
          console.log(`[RAG] Extracted items: ${todos.length} todos, ${decisions.length} decisions (${block.length} chars)`);
        }
      } catch (err) {
        console.log(`[RAG] Extracted items error: ${err}`);
      }
    }

    // ─── Phase 5: Fallback ────────────────────────────────────
    // If no context at all, load recent segments
    if (sections.length === 0) {
      try {
        console.log(`[RAG] No context found yet, loading all recent segments as fallback`);
        const recentRecs = this.db.getRecentRecordings(5);
        const fallbackSegs: string[] = [];
        for (const rec of recentRecs) {
          const segs = this.db.getSegmentsByRecording(rec.id);
          const recDate = (rec.recorded_at || rec.processed_at || '').split('T')[0];
          for (const seg of segs) {
            const timeStr = formatTime(seg.start_time);
            const prefix = timeStr ? `[${recDate} ${timeStr}] ${seg.speaker_name || 'Unknown'}: ` : `[${recDate}] `;
            fallbackSegs.push(`${prefix}${getSegmentText(seg)}`);
          }
        }
        if (fallbackSegs.length > 0) {
          const included: string[] = [];
          let segChars = 0;
          const remaining = budget.total - charUsed;
          for (const line of fallbackSegs) {
            if (segChars + line.length + 1 > remaining) break;
            included.push(line);
            segChars += line.length + 1;
          }
          const truncated = included.length < fallbackSegs.length
            ? getStr('rag.truncated')(fallbackSegs.length, included.length)
            : getStr('rag.truncated_all')(fallbackSegs.length);
          sections.push(`${getStr('rag.section_recent')} ${truncated}\n${included.join('\n')}`);
          charUsed += segChars;
          console.log(`[RAG] Fallback segments: ${fallbackSegs.length} total, ${included.length} included (${segChars} chars)`);
        }
      } catch (err) {
        console.log(`[RAG] Fallback segments error: ${err}`);
      }
    }

    // Recording info for context (from segment sources)
    const segmentSources = allSources.filter((s) => s.source_type !== 'wiki');
    const recordingIds = [...new Set(segmentSources.map((s) => s.recording_id).filter(Boolean))];
    if (recordingIds.length > 0) {
      const info = recordingIds.map((id) => {
        const rec = this.db.getRecording(id!);
        if (!rec) return '';
        const date = rec.recorded_at || rec.processed_at || '';
        return `- ${rec.file_name}${date ? ` (${date})` : ''}`;
      }).filter(Boolean).join('\n');
      if (info) sections.push(`${getStr('rag.section_sources')}\n${info}`);
    }

    // Fallback: if no context at all, mention it
    if (sections.length === 0) {
      sections.push(getStr('rag.no_data'));
    }

    const totalMs = Date.now() - gc0;
    console.log(`[RAG] ═══ gatherContext DONE ═══ ${totalMs}ms | ${charUsed} chars | ${sections.length} sections | budget=${budget.total}`);
    console.log(`[RAG]   Summary: analysis→embed→search→build = ${totalMs}ms total`);

    return {
      context: sections.join('\n\n'),
      sources: allSources,
      queryEmbedding: cachedQueryEmbed,
    };
  }

  /** Rerank candidates by LLM relevance scoring, return top-5. */
  private async rerank(
    question: string,
    candidates: Array<{ segment_id: number; recording_id?: number; speaker: string; text: string; time: string }>,
  ): Promise<typeof candidates> {
    if (candidates.length <= 3) return candidates; // Not enough to rerank
    try {
      const t0 = Date.now();
      const settings = loadSettings();
      const llmModel = getLLMModel(settings);

      // Build compact numbered list for LLM scoring
      const numbered = candidates.map((c, i) => `[${i}] ${c.text.slice(0, 200)}`).join('\n');
      const prompt = `Given the question: "${question}"

Rate each text's relevance (0-10). Return ONLY a JSON array of scores in order, e.g. [8,3,7,...].

${numbered}`;

      const raw = await this.local.generate({
        model: llmModel,
        system: getStr('rag.rerank_system'),
        prompt,
        temperature: 0,
        num_ctx: 4096,
        keep_alive: '30m',
        think: false,
      });

      // Parse scores from LLM response
      const match = raw.match(/\[[\d,\s]+\]/);
      if (!match) {
        console.log('[RAG] Rerank: failed to parse scores, using original order');
        return candidates.slice(0, 5);
      }

      const scores: number[] = JSON.parse(match[0]);
      if (scores.length !== candidates.length) {
        console.log(`[RAG] Rerank: score count mismatch (${scores.length} vs ${candidates.length}), using original order`);
        return candidates.slice(0, 5);
      }

      // Sort by score descending, take top 5
      const scored = candidates.map((c, i) => ({ ...c, score: scores[i] || 0 }));
      scored.sort((a, b) => b.score - a.score);
      console.log(`[RAG] Rerank: ${Date.now() - t0}ms, scores=[${scores.join(',')}]`);
      return scored.slice(0, 5);
    } catch (err) {
      console.log(`[RAG] Rerank failed, using original order: ${err}`);
      return candidates.slice(0, 5);
    }
  }

  private async buildSystemPrompt(today: string, question?: string, queryEmbedding?: number[]): Promise<string> {
    const sp0 = Date.now();
    let soulPrompt = '';
    try {
      const ctx = loadSoulContext();
      const hash = `${ctx.soul || ''}|||${ctx.rules || ''}`;
      if (hash !== this.cachedSoulHash) {
        this.cachedSoulPrompt = buildSoulSystemPrompt(ctx);
        this.cachedSoulHash = hash;
      }
      soulPrompt = this.cachedSoulPrompt;
    } catch {
      soulPrompt = '';
    }
    console.log(`[RAG]   ⏱ buildSystemPrompt: soul=${Date.now() - sp0}ms`);

    let memoryPrompt = '';
    try {
      const mem0 = Date.now();
      if (this.memoryManager && question && queryEmbedding) {
        // Only search memories when we have a cached embedding (avoids extra LLM call)
        memoryPrompt = await this.memoryManager.searchMemories(question, 400, queryEmbedding);
      } else if (this.memoryManager && question) {
        // Fallback: lightweight keyword-only retrieval (no embed call)
        memoryPrompt = this.memoryManager.getRelevantMemories(400);
      }
      console.log(`[RAG]   ⏱ buildSystemPrompt: memory=${Date.now() - mem0}ms (${memoryPrompt.length} chars, embed=${queryEmbedding ? 'cached' : 'skipped'})`);
    } catch (err) {
      console.log(`[RAG] Memory retrieval failed: ${err}`);
      memoryPrompt = '';
    }
    const lang = getLang();
    const todayLabel = lang === 'zh' ? `今天是${today}。` : `Today is ${today}.`;
    const base = `${getStr('rag.system_prompt')}${todayLabel}${getStr('rag.system_rules')}`;
    const parts = [soulPrompt, memoryPrompt, base].filter(Boolean);
    return parts.join('\n\n---\n\n');
  }

  private buildUserPrompt(question: string, context: string): string {
    return `${getStr('rag.user_prompt_header')}\n\n${context}\n\n---\n\n${getStr('rag.user_question')(question)}\n\n${getStr('rag.user_prompt_footer')}`;
  }
}

function formatTime(seconds: number | null | undefined): string {
  if (seconds == null) return '';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
