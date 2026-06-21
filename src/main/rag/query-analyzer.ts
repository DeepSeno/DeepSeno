import type { LLMClient } from '../llm/llm-client';
import { QueryAnalysisCache } from '../llm/query-analysis-cache';

export type QueryIntent = 'summary' | 'planning' | 'person' | 'factual';

export interface TemporalRange {
  start: string; // YYYY-MM-DD
  end: string;
}

export interface QueryAnalysis {
  intent: QueryIntent;
  temporal_range: TemporalRange | null;
  entities: string[];
  rewritten_query: string;
}

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

const VALID_INTENTS: QueryIntent[] = ['summary', 'planning', 'person', 'factual'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const SYSTEM_PROMPT =
  'You analyze user queries for a personal voice second-brain RAG system. ' +
  'Output ONLY valid JSON matching the schema described in the user message. No prose, no markdown.';

function buildUserPrompt(question: string, today: string, history?: ChatTurn[]): string {
  const historyBlock = history && history.length > 0
    ? history.slice(-6)
        .map((h, i) => `[${i}] ${h.role === 'user' ? 'User' : 'Assistant'}: ${h.content.slice(0, 400)}`)
        .join('\n')
    : 'none';

  return `Today is ${today}.

Return a JSON object with this exact shape:
{
  "intent": "summary" | "planning" | "person" | "factual",
  "temporal_range": { "start": "YYYY-MM-DD", "end": "YYYY-MM-DD" } | null,
  "entities": [string, ...],
  "rewritten_query": string
}

Intent rules:
- "summary": user wants recap/overview of past content (examples: "今天我干了什么", "上周聊了什么", "今儿都忙啥呢", "what did I do today", "summarize this week", "回顾下昨天的会议")
- "planning": user wants next steps / action items / todos (examples: "我下一步该做什么", "下周怎么排", "what should I do next", "我的待办")
- "person": user asks ABOUT a specific person (examples: "张三是谁", "tell me about Alice", "我跟王总聊过什么")
- "factual": any other specific information request that doesn't fit above

temporal_range rules:
- Resolve relative time words (今天/昨天/前天/上周/本月/最近/today/yesterday/this week) to concrete dates using "Today is ${today}".
- "最近" / "recently" → past 7 days ending today.
- Return null when query has no time anchor at all.
- Both start and end must be YYYY-MM-DD strings.

entities rules:
- Extract person names, project names, topics, or quoted phrases.
- Strip generic words (会议/讨论/事情/meeting/thing).
- Empty array if nothing extractable.

rewritten_query rules:
- Use conversation history (below) to resolve pronouns (它/他/她/这/那/刚才/that/it).
- Expand obvious abbreviations.
- If the question is already standalone, return it verbatim.
- Always non-empty (default to the original question if nothing to rewrite).

Conversation history (last turns):
${historyBlock}

User question: ${question}

JSON:`;
}

function normalize(raw: unknown, originalQuestion: string): QueryAnalysis {
  const r = (raw ?? {}) as Record<string, unknown>;

  // intent — clamp to enum
  const rawIntent = String(r.intent ?? '').toLowerCase();
  const intent: QueryIntent = (VALID_INTENTS as string[]).includes(rawIntent)
    ? (rawIntent as QueryIntent)
    : 'factual';

  // temporal_range — must be {start, end} both YYYY-MM-DD
  let temporal_range: TemporalRange | null = null;
  const tr = r.temporal_range as { start?: unknown; end?: unknown } | null | undefined;
  if (tr && typeof tr === 'object') {
    const start = typeof tr.start === 'string' ? tr.start : '';
    const end = typeof tr.end === 'string' ? tr.end : '';
    if (DATE_RE.test(start) && DATE_RE.test(end) && start <= end) {
      temporal_range = { start, end };
    }
  }

  // entities — string[] only, drop empties
  const rawEntities = Array.isArray(r.entities) ? r.entities : [];
  const entities = rawEntities
    .map((e) => (typeof e === 'string' ? e.trim() : ''))
    .filter((e) => e.length > 0);

  // rewritten_query — non-empty string, default to original
  const rqRaw = typeof r.rewritten_query === 'string' ? r.rewritten_query.trim() : '';
  const rewritten_query = rqRaw.length > 0 ? rqRaw : originalQuestion;

  return { intent, temporal_range, entities, rewritten_query };
}

/**
 * LLM-based query understanding. Replaces the previous regex parsers
 * (parseIntent / parseTemporalRange / extractQueryEntities / condenseQuestion).
 *
 * Uses the cleanup-spec model tier for low latency (~200-500ms on local
 * qwen3.5:4b). Results are cached per (model, question, historyHash).
 *
 * Throws if the LLM call fails — caller decides whether to surface or recover.
 */
export class QueryAnalyzer {
  constructor(
    private client: LLMClient,
    private model: string,
    private cache: QueryAnalysisCache = new QueryAnalysisCache(),
  ) {}

  /** Hot-swap the model (e.g. after paste-clean tier is resolved async). */
  setModel(model: string): void {
    this.model = model;
  }

  async analyze(question: string, today: string, history?: ChatTurn[]): Promise<QueryAnalysis> {
    const t0 = Date.now();
    const historyHash = QueryAnalysisCache.hashHistory(history);
    const cached = this.cache.get(this.model, question, historyHash);
    if (cached) {
      console.log(`[RAG] ⏱ analyze: cache=hit 0ms intent=${cached.intent} q="${question}"`);
      return cached;
    }

    const userPrompt = buildUserPrompt(question, today, history);
    const raw = await this.client.generateJSON<Record<string, unknown>>({
      model: this.model,
      system: SYSTEM_PROMPT,
      prompt: userPrompt,
      format: 'json',
      temperature: 0,
      num_ctx: 2048,
      keep_alive: '30m',
      think: false,
    });

    const analysis = normalize(raw, question);
    this.cache.set(this.model, question, historyHash, analysis);

    console.log(
      `[RAG] ⏱ analyze: cache=miss llm=${Date.now() - t0}ms ` +
      `intent=${analysis.intent} ` +
      `range=${analysis.temporal_range ? `${analysis.temporal_range.start}~${analysis.temporal_range.end}` : 'null'} ` +
      `entities=${JSON.stringify(analysis.entities)} ` +
      `q="${analysis.rewritten_query}"`,
    );
    return analysis;
  }
}
