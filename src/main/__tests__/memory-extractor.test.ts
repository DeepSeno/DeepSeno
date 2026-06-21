import { describe, it, expect } from 'vitest';
import { MemoryExtractor } from '../agent/memory-extractor';

// Mock LLM client
const mockClient = {
  generate: async () => '',
  generateStream: async () => '',
  generateJSON: async () => ({
    facts: [
      { fact: '张总是供应链合伙人', category: 'person', confidence: 0.9 },
      { fact: 'Q1目标500万', category: 'business', confidence: 0.8 },
      { fact: '低置信度事实', category: 'general', confidence: 0.3 },
    ],
  }),
  embed: async () => [],
  isAvailable: async () => true,
  listModels: async () => [],
};

describe('MemoryExtractor', () => {
  it('returns empty for short text', async () => {
    const extractor = new MemoryExtractor(mockClient as any, 'test');
    const facts = await extractor.extract('短文本');
    expect(facts).toEqual([]);
  });

  it('extracts facts from text', async () => {
    const extractor = new MemoryExtractor(mockClient as any, 'test');
    const facts = await extractor.extract(
      '这是一段足够长的文本内容，包含了很多重要的信息需要提取',
    );
    expect(facts.length).toBe(2); // low confidence one filtered out
    expect(facts[0].fact).toBe('张总是供应链合伙人');
    expect(facts[1].fact).toBe('Q1目标500万');
  });

  it('handles LLM failure gracefully', async () => {
    const failClient = {
      ...mockClient,
      generateJSON: async () => {
        throw new Error('LLM offline');
      },
    };
    const extractor = new MemoryExtractor(failClient as any, 'test');
    const facts = await extractor.extract(
      '这是一段足够长的文本内容，包含了很多重要的信息需要提取',
    );
    expect(facts).toEqual([]);
  });

  it('handles malformed LLM response', async () => {
    const badClient = {
      ...mockClient,
      generateJSON: async () => ({ facts: null }),
    };
    const extractor = new MemoryExtractor(badClient as any, 'test');
    const facts = await extractor.extract(
      '这是一段足够长的文本内容，包含了很多重要的信息需要提取',
    );
    expect(facts).toEqual([]);
  });
});
