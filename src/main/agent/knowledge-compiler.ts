/**
 * KnowledgeCompiler — Core knowledge compilation engine.
 *
 * Processes recordings to extract entities (person/topic/project/concept)
 * and compiles structured wiki pages with cross-references and embeddings.
 */

import type { LLMClient } from '../llm/llm-client';
import type { VoiceBrainDB } from '../db/database';
import type { VectorStore } from '../rag/vector-store';
import { getLLMModel, getEmbedModel } from '../llm/create-client';
import { loadSettings } from '../settings';
import { EmbeddingCache } from '../llm/embedding-cache';
import { runWithPriority } from '../llm/llm-scheduler';
import { pinyinSimilarity } from '../utils/pinyin';

// ─── Types ──────────────────────────────────────────────────

interface ExtractedEntity {
  name: string;
  type: 'person' | 'topic' | 'project' | 'concept';
  context: string;
}

const VALID_TYPES = new Set(['person', 'topic', 'project', 'concept']);

const PAGE_TEMPLATES: Record<string, string> = {
  person: `## 基本信息\n\n## 关键观点与立场\n\n## 近期动态\n\n## 相关人物\n\n## 交互历史\n`,
  topic: `## 概述\n\n## 关键决策\n\n## 待办事项\n\n## 时间线\n\n## 相关人物\n\n## 开放问题\n`,
  project: `## 项目概述\n\n## 当前进展\n\n## 决策记录\n\n## 参与人员\n\n## 风险与问题\n`,
  concept: `## 定义\n\n## 关键要点\n\n## 应用场景\n\n## 相关概念\n`,
};

const POLL_INTERVAL_MS = 10_000;
// A single recording compile is a few LLM calls; if it hasn't finished in this
// window it's hung (dead Local socket, etc.) — fail it so the queue keeps moving
// instead of showing a permanent "compiling".
const COMPILE_TIMEOUT_MS = 5 * 60_000;

// ─── KnowledgeCompiler ──────────────────────────────────────

export class KnowledgeCompiler {
  private db: VoiceBrainDB;
  private llm: LLMClient;
  private vectorStore: VectorStore;
  private embedClient: LLMClient;
  private embeddingCache: EmbeddingCache;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private processing = false;
  private onCompiledCb: ((pageIds: number[]) => void) | null = null;

  constructor(
    db: VoiceBrainDB,
    llm: LLMClient,
    vectorStore: VectorStore,
    embedClient?: LLMClient
  ) {
    this.db = db;
    this.llm = llm;
    this.vectorStore = vectorStore;
    this.embedClient = embedClient ?? llm;
    this.embeddingCache = new EmbeddingCache(200, 60 * 60 * 1000);
  }

  // ─── Hot-swap LLM client ────────────────────────────────

  updateLLMClient(llm: LLMClient, embedClient?: LLMClient): void {
    this.llm = llm;
    if (embedClient) this.embedClient = embedClient;
  }

  updateVectorStore(vectorStore: VectorStore): void {
    this.vectorStore = vectorStore;
  }

  // ─── Lifecycle ──────────────────────────────────────────

  setOnCompiled(cb: (pageIds: number[]) => void): void {
    this.onCompiledCb = cb;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    // Recover entries left mid-compile by a previous crash/quit so they don't
    // sit in 'processing' forever (the phantom "1 compiling" badge).
    try {
      const reset = this.db.resetOrphanedCompilationEntries();
      if (reset > 0) console.log(`[KnowledgeCompiler] Reset ${reset} orphaned 'processing' entries to 'pending'`);
    } catch (err) {
      console.error('[KnowledgeCompiler] Failed to reset orphaned entries:', err);
    }
    console.log('[KnowledgeCompiler] Started');
    this.schedulePoll();
  }

  stop(): void {
    this.running = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    console.log('[KnowledgeCompiler] Stopped');
  }

  enqueue(recordingId: number, priority: number = 0): void {
    try {
      this.db.insertCompilationQueueEntry(recordingId, priority);
      console.log(`[KnowledgeCompiler] Enqueued recording ${recordingId} (priority=${priority})`);
      // If running and not currently processing, trigger immediate check
      if (this.running && !this.processing) {
        if (this.pollTimer) clearTimeout(this.pollTimer);
        this.pollTimer = setTimeout(() => this.processNext(), 100);
      }
    } catch (err) {
      console.error('[KnowledgeCompiler] Failed to enqueue:', err);
    }
  }

  // ─── Queue Processing ─────────────────────────────────

  private schedulePoll(): void {
    if (!this.running) return;
    this.pollTimer = setTimeout(() => this.processNext(), POLL_INTERVAL_MS);
  }

  private async processNext(): Promise<void> {
    if (!this.running || this.processing) return;

    this.processing = true;
    try {
      const entry = this.db.getNextCompilationQueueEntry();
      if (!entry) {
        this.schedulePoll();
        return;
      }

      console.log(`[KnowledgeCompiler] Processing queue entry ${entry.id} (recording=${entry.recording_id})`);
      this.db.startCompilationQueueEntry(entry.id);

      try {
        const pageIds = await this.withTimeout(
          // Knowledge compilation is background work — yields LLM priority to
          // interactive RAG/chat queries (see llm-scheduler).
          runWithPriority('background', () => this.compile(entry.recording_id)),
          COMPILE_TIMEOUT_MS,
          `compile timed out after ${COMPILE_TIMEOUT_MS / 1000}s`
        );
        this.db.completeCompilationQueueEntry(entry.id);
        console.log(`[KnowledgeCompiler] Completed entry ${entry.id}, updated ${pageIds.length} pages`);

        if (pageIds.length > 0 && this.onCompiledCb) {
          try {
            this.onCompiledCb(pageIds);
          } catch (cbErr) {
            console.error('[KnowledgeCompiler] onCompiled callback error:', cbErr);
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[KnowledgeCompiler] Failed entry ${entry.id}:`, msg);
        this.db.failCompilationQueueEntry(entry.id, msg);
      }

      // Immediately check for next entry
      if (this.running) {
        this.pollTimer = setTimeout(() => this.processNext(), 50);
        return;
      }
    } finally {
      this.processing = false;
    }
  }

  private withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer)) as Promise<T>;
  }

  // ─── Main Compilation ─────────────────────────────────

  async compile(recordingId: number): Promise<number[]> {
    // Step 0: Gather segments
    const segments = this.db.getSegmentsByRecording(recordingId);
    if (!segments || segments.length === 0) {
      console.log(`[KnowledgeCompiler] No segments for recording ${recordingId}`);
      return [];
    }

    const segmentIds = segments.map((s) => s.id);

    // Build combined text
    const combinedText = segments
      .map((s) => {
        const speaker = s.speaker_name || '未知';
        const text = s.clean_text || s.raw_text || '';
        return `[${speaker}]: ${text}`;
      })
      .join('\n');

    if (combinedText.length < 50) {
      console.log(`[KnowledgeCompiler] Text too short (${combinedText.length} chars), skipping`);
      return [];
    }

    // Apply correction dictionary to normalize entity names before extraction
    let correctedText = combinedText;
    try {
      const { corrected, appliedIds } = this.db.applyCorrections(combinedText);
      if (corrected !== combinedText) {
        correctedText = corrected;
        for (const id of appliedIds) this.db.incrementCorrectionHitCount(id);
        console.log(`[KnowledgeCompiler] Applied ${appliedIds.length} corrections to combined text`);
      }
    } catch (err) {
      console.warn('[KnowledgeCompiler] applyCorrections failed, using original text:', err);
    }

    // Step 1: Extract entities from corrected text
    let entities: ExtractedEntity[];
    try {
      entities = await this.extractEntities(correctedText.slice(0, 6000));
    } catch (err) {
      console.error('[KnowledgeCompiler] Entity extraction failed:', err);
      return [];
    }

    if (entities.length === 0) {
      console.log('[KnowledgeCompiler] No entities extracted');
      return [];
    }

    console.log(`[KnowledgeCompiler] Extracted ${entities.length} entities: ${entities.map((e) => e.name).join(', ')}`);

    // Step 2: Resolve and compile pages for each entity
    const updatedPageIds: number[] = [];
    for (const entity of entities) {
      try {
        const pageId = await this.resolveAndCompilePage(entity, combinedText, recordingId, segmentIds);
        if (pageId != null) {
          updatedPageIds.push(pageId);
        }
      } catch (err) {
        console.error(`[KnowledgeCompiler] Failed to compile page for "${entity.name}":`, err);
        // Continue with other entities
      }
    }

    // Step 3: Update cross-references for all updated pages
    for (const pageId of updatedPageIds) {
      try {
        this.updateCrossReferences(pageId);
      } catch (err) {
        console.error(`[KnowledgeCompiler] Failed to update cross-references for page ${pageId}:`, err);
      }
    }

    // Step 4: Re-embed updated pages
    for (const pageId of updatedPageIds) {
      try {
        await this.embedPage(pageId);
      } catch (err) {
        console.error(`[KnowledgeCompiler] Failed to embed page ${pageId}:`, err);
      }
    }

    return updatedPageIds;
  }

  // ─── Entity Extraction ────────────────────────────────

  async extractEntities(text: string): Promise<ExtractedEntity[]> {
    const settings = loadSettings();
    const model = getLLMModel(settings);

    // Truncate very long text to avoid overflowing context
    const truncated = text.length > 8000 ? text.slice(0, 8000) + '\n...(已截断)' : text;

    const prompt = `你是一个信息提取助手。请从以下对话文本中提取出重要的实体（人物、话题、项目、概念）。

要求：
1. 只提取文本中明确提及且有足够上下文信息的实体
2. 每个实体包含：name（名称）、type（类型：person/topic/project/concept）、context（相关上下文片段，50字以内）
3. 人名请用完整称呼，不要用代词
4. 忽略过于笼统的词汇（如"工作"、"会议"等）
5. 最多提取10个最重要的实体

对话文本：
${truncated}

请以JSON格式返回，格式为：
{"entities": [{"name": "实体名称", "type": "person|topic|project|concept", "context": "相关上下文"}]}`;

    const result = await this.llm.generateJSON<{ entities: ExtractedEntity[] }>({
      model,
      prompt,
      temperature: 0.1,
      think: false,
    });

    const raw = result?.entities;
    if (!Array.isArray(raw)) return [];

    // Filter and validate
    return raw.filter(
      (e) =>
        e &&
        typeof e.name === 'string' &&
        e.name.length >= 2 &&
        typeof e.type === 'string' &&
        VALID_TYPES.has(e.type) &&
        typeof e.context === 'string'
    );
  }

  // ─── Page Resolution & Compilation ────────────────────

  private async resolveAndCompilePage(
    entity: ExtractedEntity,
    combinedText: string,
    recordingId: number,
    segmentIds: number[]
  ): Promise<number | null> {
    const slug = `${entity.type}/${entity.name}`;
    const settings = loadSettings();
    const model = getLLMModel(settings);

    // Try to find existing page: first by exact slug, then by FTS title match
    let page = this.db.getKnowledgePageBySlug(slug);
    if (!page) {
      const ftsResults = this.db.searchKnowledgePagesFts(entity.name, 3);
      for (const r of ftsResults) {
        const candidate = this.db.getKnowledgePage(r.id);
        if (candidate && candidate.type === entity.type && candidate.title === entity.name) {
          page = candidate;
          break;
        }
      }
    }

    // Try pinyin similarity match
    if (!page) {
      try {
        const allPages = this.db.getAllKnowledgePages(entity.type);
        for (const candidate of allPages) {
          const sim = pinyinSimilarity(entity.name, candidate.title);
          if (sim >= 0.85) {
            page = candidate;
            // Auto-learn this correction for future lookups
            this.db.insertCorrection(entity.name, candidate.title, 'person_name', 'auto_learned');
            console.log(`[KnowledgeCompiler] Pinyin match: "${entity.name}" → "${candidate.title}" (sim=${sim.toFixed(2)})`);
            break;
          }
        }
      } catch (err) {
        console.warn('[KnowledgeCompiler] Pinyin matching failed:', err);
      }
    }

    // If not found, create new page with skeleton template
    if (!page) {
      const template = PAGE_TEMPLATES[entity.type] || PAGE_TEMPLATES.concept;
      const pageId = this.db.insertKnowledgePage(
        slug,
        entity.type,
        entity.name,
        template,
        ''
      );
      page = this.db.getKnowledgePage(pageId);
      if (!page) return null;
      console.log(`[KnowledgeCompiler] Created new page: ${slug} (id=${pageId})`);
    }

    // Get existing page slugs for wikilink hints
    let existingSlugs: string[];
    try {
      existingSlugs = this.db.getAllKnowledgePageSlugs();
    } catch {
      existingSlugs = [];
    }
    const wikilinkHint = existingSlugs.length > 0
      ? `\n\n已有的知识页面（可用 [[slug]] 引用）：\n${existingSlugs.slice(0, 50).join(', ')}`
      : '';

    // LLM call to integrate new information
    const truncatedText = combinedText.length > 6000
      ? combinedText.slice(0, 6000) + '\n...(已截断)'
      : combinedText;

    const systemPrompt = `你是一个知识 Wiki 维护者。你的任务是将新的对话信息整合到已有的知识页面中。

规则：
1. 保留已有页面中的所有有效信息，不要删除原有内容
2. 将新信息整合到适当的章节下
3. 使用 [[type/name]] 格式的 wikilink 引用其他知识页面
4. 用中文撰写
5. 保持客观事实性，不要推测
6. 保留 Markdown 格式（## 标题等）
7. 如果某个章节没有新信息，保持原样即可${wikilinkHint}`;

    const userPrompt = `当前页面标题：${entity.name}（类型：${entity.type}）
当前页面slug：${slug}

当前页面内容：
${page.content_markdown}

新的对话内容（请从中提取与"${entity.name}"相关的信息）：
${truncatedText}

请输出整合后的完整页面内容（仅输出 Markdown 内容，不要包含页面标题）：`;

    const newContent = await this.llm.generate({
      model,
      system: systemPrompt,
      prompt: userPrompt,
      temperature: 0.2,
      think: false,
    });

    if (!newContent || newContent.trim().length === 0) {
      console.log(`[KnowledgeCompiler] LLM returned empty content for ${slug}`);
      return null;
    }

    // Generate summary from first 2 non-heading, non-empty lines
    const summary = this.extractSummary(newContent);

    // Merge source IDs
    const existingSegmentIds: number[] = (() => {
      try {
        return page.source_segment_ids ? JSON.parse(page.source_segment_ids) : [];
      } catch {
        return [];
      }
    })();
    const existingRecordingIds: number[] = (() => {
      try {
        return page.source_recording_ids ? JSON.parse(page.source_recording_ids) : [];
      } catch {
        return [];
      }
    })();

    const mergedSegmentIds = [...new Set([...existingSegmentIds, ...segmentIds])];
    const mergedRecordingIds = [...new Set([...existingRecordingIds, recordingId])];

    this.db.updateKnowledgePageContent(
      page.id,
      newContent.trim(),
      summary,
      mergedSegmentIds,
      mergedRecordingIds
    );

    console.log(`[KnowledgeCompiler] Updated page: ${slug} (id=${page.id})`);

    // Link existing person record to knowledge page (no auto-creation)
    if (entity.type === 'person' && page) {
      try {
        const existingPerson = this.db.getPersonByName(entity.name);
        if (existingPerson && !existingPerson.knowledge_page_id) {
          this.db.updatePerson(existingPerson.id, { knowledge_page_id: page.id });
          console.log(`[KnowledgeCompiler] Linked existing person "${entity.name}" to page ${page.id}`);
        }
      } catch (err) {
        console.warn(`[KnowledgeCompiler] Failed to link person "${entity.name}":`, err);
      }
    }

    return page.id;
  }

  // ─── Cross-References ─────────────────────────────────

  updateCrossReferences(pageId: number): void {
    const page = this.db.getKnowledgePage(pageId);
    if (!page) return;

    // Parse [[...]] wikilinks from content
    const wikilinkRegex = /\[\[([^\]]+)\]\]/g;
    const slugs = new Set<string>();
    let match: RegExpExecArray | null;
    while ((match = wikilinkRegex.exec(page.content_markdown)) !== null) {
      slugs.add(match[1]);
    }

    // Delete existing outgoing links and recreate
    this.db.deleteKnowledgeLinksFrom(pageId);

    for (const targetSlug of slugs) {
      try {
        const targetPage = this.db.getKnowledgePageBySlug(targetSlug);
        if (targetPage && targetPage.id !== pageId) {
          this.db.insertKnowledgeLink(pageId, targetPage.id, 'reference');
        }
      } catch (err) {
        // Ignore unresolved links
      }
    }
  }

  // ─── Embedding ────────────────────────────────────────

  async embedPage(pageId: number): Promise<void> {
    const page = this.db.getKnowledgePage(pageId);
    if (!page) return;

    const settings = loadSettings();
    const embedModel = getEmbedModel(settings);

    // Build text for embedding: title + summary + content snippet
    const contentSnippet = (page.content_markdown || '').slice(0, 500);
    const textToEmbed = `${page.title}\n${page.summary || ''}\n${contentSnippet}`.trim();

    // Check cache first
    let embedding = this.embeddingCache.get(embedModel, textToEmbed);
    if (!embedding) {
      embedding = await this.embedClient.embed(embedModel, textToEmbed);
      this.embeddingCache.set(embedModel, textToEmbed, embedding);
    }

    this.vectorStore.insertPageVector(pageId, embedding);
  }

  // ─── Page Merge ───────────────────────────────────────

  /**
   * Merge multiple knowledge pages into one target page.
   * LLM combines content, all sources/links are migrated, source pages deleted.
   */
  async mergePages(sourcePageIds: number[], targetPageId: number): Promise<{ merged: number; targetPageId: number; targetSlug: string }> {
    const targetPage = this.db.getKnowledgePage(targetPageId);
    if (!targetPage) throw new Error(`Target page ${targetPageId} not found`);

    const sourcePages = sourcePageIds
      .filter(id => id !== targetPageId)
      .map(id => this.db.getKnowledgePage(id))
      .filter(Boolean);

    if (sourcePages.length === 0) {
      return { merged: 0, targetPageId, targetSlug: targetPage.slug };
    }

    // Collect all content for LLM merge
    const allContent = [
      `## 主页面: ${targetPage.title}\n${targetPage.content_markdown}`,
      ...sourcePages.map((p: any) => `## 合并来源: ${p.title}\n${p.content_markdown}`),
    ].join('\n\n---\n\n');

    // LLM merge
    const settings = loadSettings();
    const model = getLLMModel(settings);

    const merged = await this.llm.generate({
      model,
      system: `你是一个知识 Wiki 维护者。将多个关于同一实体的页面合并为一个完整的页面。
规则:
1. 保留所有不重复的信息
2. 去除重复内容
3. 当信息矛盾时，保留较新的（有日期的优先）
4. 保持目标页面的结构格式
5. 用简体中文书写，保留英文技术术语
6. 使用 [[type/名称]] 格式引用其他实体`,
      prompt: `请将以下多个页面的内容合并为一个完整的知识页面。保持"${targetPage.title}"作为主标题。\n\n${allContent}\n\n输出合并后的完整页面内容（Markdown格式，不含YAML frontmatter）:`,
      temperature: 0.2,
      think: false,
    });

    if (!merged || merged.trim().length < 10) {
      throw new Error('LLM merge produced empty result');
    }

    // Merge source IDs from all pages
    const allSegIds = new Set<number>();
    const allRecIds = new Set<number>();
    for (const p of [targetPage, ...sourcePages]) {
      for (const id of this.parseIdArray((p as any).source_segment_ids)) allSegIds.add(id);
      for (const id of this.parseIdArray((p as any).source_recording_ids)) allRecIds.add(id);
    }

    // Update target page with merged content
    const summary = merged.split('\n').filter((l: string) => l.trim() && !l.startsWith('#')).slice(0, 2).join(' ').slice(0, 200);
    this.db.updateKnowledgePageContent(
      targetPageId, merged.trim(), summary,
      [...allSegIds], [...allRecIds]
    );

    // Migrate links: re-point all links from/to source pages to target
    for (const sp of sourcePages) {
      const outLinks = this.db.getKnowledgeLinks((sp as any).id);
      for (const link of outLinks) {
        if (link.to_page_id !== targetPageId) {
          this.db.insertKnowledgeLink(targetPageId, link.to_page_id, link.link_type, link.context);
        }
      }
      const inLinks = this.db.getKnowledgeBacklinks((sp as any).id);
      for (const link of inLinks) {
        if (link.from_page_id !== targetPageId) {
          this.db.insertKnowledgeLink(link.from_page_id, targetPageId, link.link_type, link.context);
        }
      }
    }

    // Auto-learn corrections: source page names → target page name
    for (const sp of sourcePages) {
      if ((sp as any).title !== targetPage.title) {
        this.db.insertCorrection((sp as any).title, targetPage.title, 'person_name', 'auto_learned');
      }
      if ((sp as any).slug && (sp as any).slug !== targetPage.slug) {
        this.db.bulkUpdateKnowledgeSlugReferences((sp as any).slug, targetPage.slug, targetPageId);
      }
    }

    // Delete source pages. Be explicit about links because older databases may
    // have been created before foreign-key cascades were consistently enabled.
    for (const sp of sourcePages) {
      const sourceId = (sp as any).id;
      this.db.deleteKnowledgeLinksFrom(sourceId);
      this.db.deleteKnowledgeLinksTo(sourceId);
      this.db.deleteKnowledgePage(sourceId);
      try { this.vectorStore.deletePageVector(sourceId); } catch { /* ignore */ }
    }

    // Re-embed and relink the merged page. The merge itself is already durable
    // at this point, so keep these follow-up refreshes best-effort; otherwise a
    // transient embedding/local-model failure makes the UI report "merge failed"
    // even though the source pages were already merged.
    try {
      await this.embedPage(targetPageId);
    } catch (err) {
      console.warn(`[KnowledgeCompiler] Failed to embed merged page ${targetPageId}:`, err);
    }

    try {
      this.updateCrossReferences(targetPageId);
    } catch (err) {
      console.warn(`[KnowledgeCompiler] Failed to update merged page cross-references ${targetPageId}:`, err);
    }

    console.log(`[KnowledgeCompiler] Merged ${sourcePages.length} pages into "${targetPage.title}" (id=${targetPageId})`);
    return { merged: sourcePages.length, targetPageId, targetSlug: targetPage.slug };
  }

  // ─── Helpers ──────────────────────────────────────────

  private parseIdArray(raw: string | null | undefined): number[] {
    try {
      const parsed = JSON.parse(raw || '[]');
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((id): id is number => typeof id === 'number' && Number.isFinite(id));
    } catch {
      return [];
    }
  }

  private extractSummary(markdown: string): string {
    const lines = markdown.split('\n');
    const contentLines: string[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (trimmed.startsWith('#')) continue;
      contentLines.push(trimmed);
      if (contentLines.length >= 2) break;
    }
    return contentLines.join(' ').slice(0, 200);
  }
}
