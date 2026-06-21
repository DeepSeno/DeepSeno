import type { LLMClient } from '../llm/llm-client';
import { getPipelinePrompt } from '../llm/default-prompts';

export interface ExtractedFact {
  fact: string;
  category: 'person' | 'business' | 'preference' | 'relationship' | 'general';
  confidence: number;
}

const EXTRACT_MEMORY_PROMPT = `从以下会议/对话文本中提取值得长期记住的事实信息。

提取类型：
- person: 人物信息（姓名、职位、联系方式、特征）
- business: 业务信息（目标、数字、日期、项目状态）
- preference: 用户偏好（习惯、喜好、工作方式）
- relationship: 人物关系（谁和谁的关系、合作关系）
- general: 其他重要事实

要求：
- 只提取明确陈述的事实，不推测
- 每条事实独立完整，不依赖上下文
- 忽略闲聊、寒暄、重复内容
- confidence: 1.0=明确陈述, 0.7=较确定推断, 0.5=可能

输出 JSON:
{"facts": [{"fact": "...", "category": "...", "confidence": 0.9}]}

文本：
{{text}}`;

export class MemoryExtractor {
  constructor(
    private client: LLMClient,
    private model: string,
  ) {}

  async extract(cleanText: string): Promise<ExtractedFact[]> {
    if (!cleanText || cleanText.trim().length < 20) return [];

    const template = getPipelinePrompt('memoryExtract');
    const prompt = template.replace(/\{\{text\}\}/g, cleanText);
    try {
      const result = await this.client.generateJSON<{ facts: ExtractedFact[] }>({
        model: this.model,
        prompt,
        temperature: 0.1,
        think: false,
      });
      return (result.facts || []).filter(
        (f) =>
          f.fact && f.category && typeof f.confidence === 'number' && f.confidence >= 0.5,
      );
    } catch (err) {
      console.warn('[MemoryExtractor] Extraction failed:', err);
      return [];
    }
  }
}
