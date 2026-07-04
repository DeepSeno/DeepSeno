import type { LLMClient } from '../llm/llm-client';
import { getPipelinePrompt } from '../llm/default-prompts';

export interface ExtractedFact {
  fact: string;
  category: 'person' | 'business' | 'preference' | 'relationship' | 'general';
  confidence: number;
}

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
