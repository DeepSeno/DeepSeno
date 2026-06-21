import type { LLMClient } from '../llm/llm-client';
import { getLLMModel } from '../llm/create-client';
import { loadSettings } from '../settings';

export type IntentType = 'query' | 'todo' | 'memo' | 'report' | 'transcribe' | 'help' | 'list_items';

export interface IntentResult {
  intent: IntentType;
  params: {
    question?: string;
    content?: string;
    dueDate?: string | null;
    relatedPerson?: string | null;
    type?: 'daily' | 'weekly';
    date?: string;
    endDate?: string | null;
  };
}

function buildIntentPrompt(source: 'voice' | 'text' = 'text'): string {
  const today = new Date().toISOString().split('T')[0];
  const tomorrow = new Date(Date.now() + 86400000).toISOString().split('T')[0];

  const sourceHint = source === 'voice'
    ? '\n【重要】这是一条语音消息。语音消息可能是口述记录（memo）或提问（query）。如果句中含有疑问词（什么、哪个、哪里、怎么、为什么、吗、几）或问号，必须归类为 query。只有确实是在陈述/记录信息时才归类为 memo。\n'
    : '';

  return `你是 DeepSeno 助手的意图分类器。根据用户消息判断意图并返回 JSON。

当前日期: ${today}
${sourceHint}
意图说明（按优先级判断）：
- help: 用户在问有什么功能、怎么用、帮助
- list_items: 用户要查看、列出待办/备忘/事项列表
- todo: 用户要创建待办事项、提醒、任务（含"提醒我"、"记得要"、明确的截止时间等）
- report: 用户要生成日报、周报、总结
- query: 用户在**明确提问**，句中含有疑问词（什么、为什么、怎么、吗、哪里、几点）或问号
- memo: 用户在陈述、描述、记录信息（默认意图）
- transcribe: 多人对话或会议录音内容（不是单人口述）

⚠️ 关键区分规则：
1. 如果用户在**描述自己做了什么、吃了什么、去了哪里、看到了什么、想法感受**等，这是 memo，不是 query
2. 只有包含明确疑问句（有疑问词或问号）才归为 query
3. "我发现XXX" "今天XXX" "刚才XXX" 这类陈述句 → memo
4. "XXX怎么样" "XXX是什么" "为什么XXX" → query

返回格式（必须是合法 JSON）：
{ "intent": "query|todo|memo|list_items|report|transcribe|help", "params": {...} }

params 格式：
- query: { "question": "用户的问题" }
- todo: { "content": "任务描述", "dueDate": "YYYY-MM-DD或null", "relatedPerson": "人名或null" }
- memo: { "content": "备忘内容", "relatedPerson": "人名或null" }
- list_items: { "type": "todo|memo|all" }
- report: { "type": "daily|weekly", "date": "YYYY-MM-DD", "endDate": "YYYY-MM-DD或null" }
- transcribe: {}
- help: {}

示例（假设今天是 ${today}）：
"昨天开会说了什么" → {"intent":"query","params":{"question":"昨天开会说了什么"}}
"帮我记一下明天下午3点和张总开会" → {"intent":"todo","params":{"content":"明天下午3点和张总开会","dueDate":"${tomorrow}","relatedPerson":"张总"}}
"记住这个：新项目预算200万" → {"intent":"memo","params":{"content":"新项目预算200万","relatedPerson":null}}
"早上在希尔顿吃了碱水面和榴莲酥" → {"intent":"memo","params":{"content":"早上在希尔顿吃了碱水面和榴莲酥","relatedPerson":null}}
"我发现东部华侨城关门了暂停营业去不了了" → {"intent":"memo","params":{"content":"东部华侨城关门了暂停营业，去不了了","relatedPerson":null}}
"今天在酒店待着，晚上可能去云台公园看灯光秀" → {"intent":"memo","params":{"content":"今天在酒店待着，晚上可能去云台公园看灯光秀","relatedPerson":null}}
"显示我的待办" → {"intent":"list_items","params":{"type":"todo"}}
"查看备忘" → {"intent":"list_items","params":{"type":"memo"}}
"生成今天的日报" → {"intent":"report","params":{"type":"daily","date":"${today}","endDate":null}}
"你能做什么" → {"intent":"help","params":{}}

用户消息：
`;
}

/** Simple LRU cache for intent classification results. */
interface CacheEntry {
  result: IntentResult;
  cachedAt: number;
}

const CACHE_MAX = 100;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const CACHE_TEXT_LIMIT = 50; // Only cache short texts

export class IntentClassifier {
  private local: LLMClient;
  private cache = new Map<string, CacheEntry>();

  constructor(local: LLMClient) {
    this.local = local;
  }

  async classify(text: string, source: 'voice' | 'text' = 'text'): Promise<IntentResult> {
    // Check cache for short texts
    const cacheKey = `${source}:${text}`;
    if (text.length <= CACHE_TEXT_LIMIT) {
      const cached = this.cache.get(cacheKey);
      if (cached && Date.now() - cached.cachedAt < CACHE_TTL) {
        return cached.result;
      }
    }

    const settings = loadSettings();
    try {
      const result = await this.local.generateJSON<IntentResult>({
        model: getLLMModel(settings),
        prompt: buildIntentPrompt(source) + text,
        think: false,
      });

      const validIntents: IntentType[] = ['query', 'todo', 'memo', 'list_items', 'report', 'transcribe', 'help'];
      if (!validIntents.includes(result.intent)) {
        console.warn(`[IntentClassifier] Invalid intent "${result.intent}", falling back to query`);
        return { intent: 'query', params: { question: text } };
      }

      // Cache short texts
      if (text.length <= CACHE_TEXT_LIMIT) {
        if (this.cache.size >= CACHE_MAX) {
          // Evict oldest entry
          const firstKey = this.cache.keys().next().value;
          if (firstKey) this.cache.delete(firstKey);
        }
        this.cache.set(cacheKey, { result, cachedAt: Date.now() });
      }

      return result;
    } catch (err) {
      console.error('[IntentClassifier] Classification failed, falling back to query:', err);
      return { intent: 'query', params: { question: text } };
    }
  }
}
