import type { VoiceBrainDB } from '../db/database';
import type { LLMClient } from '../llm/llm-client';
import type { VectorStore } from '../rag/vector-store';
import { formatLocalDate } from '../utils/date';

export interface Insight {
  type: 'person_frequency' | 'todo_reminder' | 'topic_trend' | 'anomaly' | 'memory_correlation';
  title: string;
  detail: string;
  urgency: 'high' | 'medium' | 'low';
}

/**
 * InsightEngine proactively scans the database for actionable insights:
 * - Pending / overdue todo reminders
 * - High-frequency speakers (collaborators)
 * - Anomalies (overdue items)
 * - Topic trends (keywords across 3+ consecutive days)
 * - Memory correlation (high-similarity matches between today and history)
 */
export class InsightEngine {
  private llm?: LLMClient;
  private model?: string;
  private embedModel?: string;
  private embedClient?: LLMClient;
  private vectorStore?: VectorStore;

  constructor(private db: VoiceBrainDB) {}

  /** Inject LLM client for topic trend detection and memory correlation. */
  setLLM(llm: LLMClient, model: string, embedModel?: string, embedClient?: LLMClient): void {
    this.llm = llm;
    this.model = model;
    this.embedModel = embedModel;
    this.embedClient = embedClient;
  }

  /** Inject VectorStore for memory correlation search. */
  setVectorStore(vs: VectorStore): void {
    this.vectorStore = vs;
  }

  /**
   * Run all insight scanners and return combined results.
   */
  async scan(): Promise<Insight[]> {
    const insights: Insight[] = [];

    // Pre-load shared data to avoid redundant DB queries
    const activeItems = this.db.getActiveExtractedItems?.() || [];

    // 1. Todo reminders (due today or tomorrow)
    insights.push(...this.checkPendingTodos(activeItems));

    // 2. Person frequency analysis (high-frequency speakers)
    insights.push(...this.analyzePersonFrequency());

    // 3. Anomaly detection (overdue todos)
    insights.push(...this.detectAnomalies(activeItems));

    // 4. Topic trend detection (keywords across 3+ days)
    try {
      insights.push(...await this.detectTopicTrends());
    } catch {
      // Gracefully handle errors
    }

    // 5. Memory correlation (today vs historical segments)
    try {
      insights.push(...await this.correlateMemories());
    } catch {
      // Gracefully handle errors
    }

    return insights;
  }

  /**
   * Find todos that are due today or tomorrow (urgent reminders).
   */
  checkPendingTodos(preloadedItems?: any[]): Insight[] {
    const items = preloadedItems || this.db.getActiveExtractedItems?.() || [];
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = formatLocalDate(tomorrow);

    return items
      .filter(
        (item) =>
          item.type === 'todo' &&
          item.status === 'active' &&
          item.due_date &&
          item.due_date <= tomorrowStr
      )
      .map((item) => ({
        type: 'todo_reminder' as const,
        title: '待办即将到期',
        detail: `"${item.content}" 截止日期: ${item.due_date}`,
        urgency: 'high' as const,
      }));
  }

  /**
   * Identify speakers with high segment counts (frequent collaborators).
   */
  analyzePersonFrequency(): Insight[] {
    const insights: Insight[] = [];
    try {
      const speakers = this.db.getAllSpeakers?.() || [];
      const frequent = speakers.filter((s: any) => s.segment_count > 10);
      if (frequent.length > 0) {
        insights.push({
          type: 'person_frequency',
          title: '高频联系人',
          detail: frequent
            .map((s: any) => `${s.name || 'Unknown'}: ${s.segment_count}段对话`)
            .join(', '),
          urgency: 'low',
        });
      }
    } catch {
      // Gracefully handle missing methods or DB errors
    }
    return insights;
  }

  /**
   * Detect anomalies such as overdue todo items.
   */
  detectAnomalies(preloadedItems?: any[]): Insight[] {
    const insights: Insight[] = [];
    try {
      const items = preloadedItems || this.db.getActiveExtractedItems?.() || [];
      const todayStr = formatLocalDate();
      const overdue = items.filter(
        (item) =>
          item.type === 'todo' &&
          item.status === 'active' &&
          item.due_date &&
          item.due_date < todayStr
      );
      if (overdue.length > 0) {
        insights.push({
          type: 'anomaly',
          title: '逾期待办',
          detail: `${overdue.length}个待办已过截止日期`,
          urgency: 'high',
        });
      }
    } catch {
      // Gracefully handle missing methods or DB errors
    }
    return insights;
  }

  /**
   * Detect keywords appearing across 3+ consecutive days in the last 7 days.
   * Uses LLM to extract topic keywords from each day's segments.
   */
  async detectTopicTrends(): Promise<Insight[]> {
    if (!this.llm || !this.model) return [];

    const insights: Insight[] = [];
    try {
      // Get segments from last 7 days, grouped by date
      const today = new Date();
      const dayKeywords: Map<string, string[]> = new Map();

      for (let i = 0; i < 7; i++) {
        const d = new Date(today);
        d.setDate(d.getDate() - i);
        const dateStr = formatLocalDate(d);
        const segments = this.db.getSegmentsByDate(dateStr);
        if (segments.length === 0) continue;

        const combinedText = segments
          .map((s) => s.clean_text || s.raw_text || '')
          .join('\n')
          .slice(0, 1000);

        if (combinedText.length < 20) continue;

        const prompt = `从以下文本中提取3-5个关键话题词（名词短语），返回JSON数组：
"${combinedText}"
格式：["话题1","话题2","话题3"]
只返回JSON。`;

        try {
          const result = await this.llm.generate({ model: this.model, prompt, temperature: 0, think: false });
          const parsed = JSON.parse(result.match(/\[[\s\S]*\]/)?.[0] || '[]');
          if (Array.isArray(parsed)) {
            dayKeywords.set(dateStr, parsed);
          }
        } catch {
          // Skip days where LLM extraction fails
        }
      }

      // Find keywords appearing in 3+ days
      const keywordDays: Map<string, number> = new Map();
      for (const [, keywords] of dayKeywords) {
        for (const kw of keywords) {
          keywordDays.set(kw, (keywordDays.get(kw) || 0) + 1);
        }
      }

      for (const [keyword, count] of keywordDays) {
        if (count >= 3) {
          insights.push({
            type: 'topic_trend',
            title: '话题趋势',
            detail: `你最近 ${count} 天都在讨论「${keyword}」，要生成专题报告吗？`,
            urgency: 'medium',
          });
        }
      }
    } catch {
      // Gracefully handle errors
    }

    return insights;
  }

  /**
   * Find high-similarity matches between today's segments and historical data.
   * Embeds today's combined text, searches the vector store, and reports
   * strong correlations with past recordings.
   */
  async correlateMemories(): Promise<Insight[]> {
    if (!this.vectorStore || !this.llm || !this.embedModel) return [];

    const insights: Insight[] = [];
    try {
      const todayStr = formatLocalDate();
      const todaySegments = this.db.getSegmentsByDate(todayStr);
      if (todaySegments.length === 0) return [];

      // Combine today's text and search for similar historical segments
      const todayText = todaySegments
        .map((s) => s.clean_text || '')
        .filter(Boolean)
        .join('\n')
        .slice(0, 500);

      if (todayText.length < 20) return [];

      // Embed today's text, then search the vector store (always use local Local for embeddings)
      const client = this.embedClient || this.llm;
      const queryEmbedding = await client!.embed(this.embedModel!, todayText);
      const results = this.vectorStore.search(queryEmbedding, 5);

      // Filter for low distance (high similarity) and exclude today's own segments
      const todaySegIds = new Set(todaySegments.map((s) => s.id));
      // sqlite-vec distance: lower = more similar; threshold 0.2 ≈ cosine similarity > 0.8
      const DISTANCE_THRESHOLD = 0.4;
      const highSim = results.filter(
        (r) => r.distance < DISTANCE_THRESHOLD && !todaySegIds.has(r.segment_id)
      );

      if (highSim.length > 0) {
        const match = highSim[0];
        // Look up the historical segment's text from the database
        const seg = this.db.getSegment?.(match.segment_id);
        const historicalText = (seg?.clean_text || seg?.raw_text || '').slice(0, 100);
        const similarityPct = Math.round((1 - match.distance) * 100);
        insights.push({
          type: 'memory_correlation',
          title: '记忆关联',
          detail: `今天的讨论内容与历史记录高度相似 (${similarityPct}%): "${historicalText}"`,
          urgency: 'low',
        });
      }
    } catch {
      // Gracefully handle errors
    }

    return insights;
  }
}
