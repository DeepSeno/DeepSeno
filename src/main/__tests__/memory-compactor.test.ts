import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryCompactor } from '../agent/memory-compactor';
import type { CompactionResult } from '../agent/memory-compactor';

function makeEmbeddingBuffer(values: number[]): Buffer {
  return Buffer.from(new Float32Array(values).buffer);
}

describe('MemoryCompactor', () => {
  let mockDb: any;
  let mockLLM: any;
  let compactor: MemoryCompactor;

  beforeEach(() => {
    mockDb = {
      getActiveMemories: vi.fn().mockReturnValue([]),
      getMemoriesByLayer: vi.fn().mockReturnValue([]),
      insertMemory: vi.fn().mockReturnValue(100),
      updateMemoryEmbedding: vi.fn(),
      supersedeMemory: vi.fn(),
      promoteMemory: vi.fn(),
      deleteMemory: vi.fn(),
      updateMemoryFact: vi.fn(),
    };
    mockLLM = {
      generate: vi.fn().mockResolvedValue('合并后的事实'),
      embed: vi.fn().mockResolvedValue([0.5, 0.5, 0.5]),
      isAvailable: vi.fn().mockResolvedValue(true),
      listModels: vi.fn().mockResolvedValue([]),
      generateStream: vi.fn(),
      generateJSON: vi.fn(),
    };
    compactor = new MemoryCompactor(mockDb, mockLLM, 'qwen2.5:14b', 'bge-m3');
  });

  describe('compact()', () => {
    it('runs all 3 steps and returns result', async () => {
      // Set up: 1 stale active memory, no duplicates, under limit
      const oldDate = new Date();
      oldDate.setDate(oldDate.getDate() - 60);
      const oldDateStr = oldDate.toISOString().split('T')[0];

      mockDb.getMemoriesByLayer.mockImplementation((layer: string) => {
        if (layer === 'active') {
          return [{ id: 1, last_seen: oldDateStr, confidence: 0.5 }];
        }
        return [];
      });
      mockDb.getActiveMemories.mockReturnValue([]);

      const result: CompactionResult = await compactor.compact();

      expect(result).toHaveProperty('decayed');
      expect(result).toHaveProperty('merged');
      expect(result).toHaveProperty('purged');
      expect(result.decayed).toBe(1);
      expect(result.merged).toBe(0);
      expect(result.purged).toBe(0);
    });
  });

  describe('decayStaleMemories (via compact)', () => {
    it('archives memories older than 30 days', async () => {
      const oldDate = new Date();
      oldDate.setDate(oldDate.getDate() - 45);
      const oldDateStr = oldDate.toISOString().split('T')[0];

      mockDb.getMemoriesByLayer.mockImplementation((layer: string) => {
        if (layer === 'active') {
          return [
            { id: 1, last_seen: oldDateStr, confidence: 0.5 },
            { id: 2, last_seen: oldDateStr, confidence: 0.7 },
          ];
        }
        return [];
      });
      mockDb.getActiveMemories.mockReturnValue([]);

      const result = await compactor.compact();

      expect(result.decayed).toBe(2);
      expect(mockDb.promoteMemory).toHaveBeenCalledWith(1, 'archive');
      expect(mockDb.promoteMemory).toHaveBeenCalledWith(2, 'archive');
    });

    it('skips recently seen memories', async () => {
      const recentDate = new Date().toISOString().split('T')[0];

      mockDb.getMemoriesByLayer.mockImplementation((layer: string) => {
        if (layer === 'active') {
          return [{ id: 1, last_seen: recentDate, confidence: 0.5 }];
        }
        return [];
      });
      mockDb.getActiveMemories.mockReturnValue([]);

      const result = await compactor.compact();

      expect(result.decayed).toBe(0);
      // promoteMemory should not be called for decay step (may be called for purge)
      expect(mockDb.promoteMemory).not.toHaveBeenCalledWith(1, 'archive');
    });
  });

  describe('mergeDuplicates (via compact)', () => {
    it('finds similar memories and merges via LLM', async () => {
      // Two very similar embeddings — nearly identical vectors
      const emb1 = makeEmbeddingBuffer([1.0, 0.0, 0.0]);
      const emb2 = makeEmbeddingBuffer([0.99, 0.01, 0.0]);

      mockDb.getMemoriesByLayer.mockReturnValue([]);
      mockDb.getActiveMemories.mockReturnValue([
        {
          id: 1,
          fact: '张总是CEO',
          category: 'person',
          confidence: 0.9,
          embedding: emb1,
          source_ids: '[1]',
          layer: 'active',
        },
        {
          id: 2,
          fact: '张总是公司的CEO',
          category: 'person',
          confidence: 0.8,
          embedding: emb2,
          source_ids: '[2]',
          layer: 'active',
        },
      ]);
      mockDb.insertMemory.mockReturnValue(100);
      mockLLM.generate.mockResolvedValue('  张总是公司CEO  ');
      mockLLM.embed.mockResolvedValue([0.99, 0.005, 0.0]);

      const result = await compactor.compact();

      expect(result.merged).toBe(2);
      // LLM was called to consolidate
      expect(mockLLM.generate).toHaveBeenCalledTimes(1);
      // A new memory was inserted
      expect(mockDb.insertMemory).toHaveBeenCalledWith({
        fact: '张总是公司CEO',
        category: 'person',
        layer: 'active',
        confidence: 0.9, // max of 0.9 and 0.8
        sourceIds: [1, 2],
      });
      // Embedding stored
      expect(mockDb.updateMemoryEmbedding).toHaveBeenCalledWith(100, expect.any(Buffer));
      // Both old memories superseded
      expect(mockDb.supersedeMemory).toHaveBeenCalledWith(1, 100);
      expect(mockDb.supersedeMemory).toHaveBeenCalledWith(2, 100);
    });

    it('skips memories without embeddings', async () => {
      mockDb.getMemoriesByLayer.mockReturnValue([]);
      mockDb.getActiveMemories.mockReturnValue([
        { id: 1, fact: 'fact A', category: 'general', confidence: 0.9, embedding: null, source_ids: '[]' },
        { id: 2, fact: 'fact B', category: 'general', confidence: 0.8, embedding: null, source_ids: '[]' },
      ]);

      const result = await compactor.compact();

      expect(result.merged).toBe(0);
      expect(mockLLM.generate).not.toHaveBeenCalled();
      expect(mockDb.insertMemory).not.toHaveBeenCalled();
    });

    it('handles LLM errors gracefully', async () => {
      const emb1 = makeEmbeddingBuffer([1.0, 0.0, 0.0]);
      const emb2 = makeEmbeddingBuffer([0.99, 0.01, 0.0]);

      mockDb.getMemoriesByLayer.mockReturnValue([]);
      mockDb.getActiveMemories.mockReturnValue([
        { id: 1, fact: 'fact A', category: 'general', confidence: 0.9, embedding: emb1, source_ids: '[]' },
        { id: 2, fact: 'fact B', category: 'general', confidence: 0.8, embedding: emb2, source_ids: '[]' },
      ]);
      mockLLM.generate.mockRejectedValue(new Error('LLM unavailable'));

      // Should not throw
      const result = await compactor.compact();

      expect(result.merged).toBe(0);
      expect(mockDb.insertMemory).not.toHaveBeenCalled();
      expect(mockDb.supersedeMemory).not.toHaveBeenCalled();
    });

    it('does not merge dissimilar memories', async () => {
      // Orthogonal vectors — similarity near 0
      const emb1 = makeEmbeddingBuffer([1.0, 0.0, 0.0]);
      const emb2 = makeEmbeddingBuffer([0.0, 1.0, 0.0]);

      mockDb.getMemoriesByLayer.mockReturnValue([]);
      mockDb.getActiveMemories.mockReturnValue([
        { id: 1, fact: 'fact A', category: 'general', confidence: 0.9, embedding: emb1, source_ids: '[]' },
        { id: 2, fact: 'fact B', category: 'general', confidence: 0.8, embedding: emb2, source_ids: '[]' },
      ]);

      const result = await compactor.compact();

      expect(result.merged).toBe(0);
      expect(mockLLM.generate).not.toHaveBeenCalled();
    });

    it('merges clusters of 3+ memories', async () => {
      const emb1 = makeEmbeddingBuffer([1.0, 0.0, 0.0]);
      const emb2 = makeEmbeddingBuffer([0.99, 0.01, 0.0]);
      const emb3 = makeEmbeddingBuffer([0.98, 0.02, 0.0]);

      mockDb.getMemoriesByLayer.mockReturnValue([]);
      mockDb.getActiveMemories.mockReturnValue([
        { id: 1, fact: 'fact A', category: 'person', confidence: 0.9, embedding: emb1, source_ids: '[1]' },
        { id: 2, fact: 'fact B', category: 'person', confidence: 0.7, embedding: emb2, source_ids: '[2]' },
        { id: 3, fact: 'fact C', category: 'person', confidence: 0.8, embedding: emb3, source_ids: '[1, 3]' },
      ]);
      mockDb.insertMemory.mockReturnValue(200);
      mockLLM.generate.mockResolvedValue('merged ABC');
      mockLLM.embed.mockResolvedValue([0.99, 0.01, 0.0]);

      const result = await compactor.compact();

      expect(result.merged).toBe(3);
      expect(mockDb.insertMemory).toHaveBeenCalledWith(
        expect.objectContaining({
          confidence: 0.9,
          sourceIds: expect.arrayContaining([1, 2, 3]),
        }),
      );
      expect(mockDb.supersedeMemory).toHaveBeenCalledWith(1, 200);
      expect(mockDb.supersedeMemory).toHaveBeenCalledWith(2, 200);
      expect(mockDb.supersedeMemory).toHaveBeenCalledWith(3, 200);
    });
  });

  describe('purgeExcess (via compact)', () => {
    it('archives lowest confidence when over limit', async () => {
      // Create 503 active memories so 3 must be purged (limit=500)
      const memories = Array.from({ length: 503 }, (_, i) => ({
        id: i + 1,
        fact: `fact ${i}`,
        confidence: (i + 1) / 503, // ascending: 1/503 ... 503/503
        last_seen: new Date().toISOString().split('T')[0],
      }));

      // getMemoriesByLayer('active') called for both decay and purge
      mockDb.getMemoriesByLayer.mockImplementation((layer: string) => {
        if (layer === 'active') return memories;
        return [];
      });
      mockDb.getActiveMemories.mockReturnValue([]); // no merges

      const result = await compactor.compact();

      expect(result.purged).toBe(3);
      // The 3 lowest confidence should be archived (ids 1, 2, 3 have lowest confidence)
      expect(mockDb.promoteMemory).toHaveBeenCalledWith(1, 'archive');
      expect(mockDb.promoteMemory).toHaveBeenCalledWith(2, 'archive');
      expect(mockDb.promoteMemory).toHaveBeenCalledWith(3, 'archive');
    });

    it('does nothing when under limit', async () => {
      const memories = Array.from({ length: 10 }, (_, i) => ({
        id: i + 1,
        fact: `fact ${i}`,
        confidence: 0.5,
        last_seen: new Date().toISOString().split('T')[0],
      }));

      mockDb.getMemoriesByLayer.mockImplementation((layer: string) => {
        if (layer === 'active') return memories;
        return [];
      });
      mockDb.getActiveMemories.mockReturnValue([]);

      const result = await compactor.compact();

      expect(result.purged).toBe(0);
    });
  });

  describe('consolidateCluster', () => {
    it('sends correct prompt to LLM', async () => {
      const emb1 = makeEmbeddingBuffer([1.0, 0.0, 0.0]);
      const emb2 = makeEmbeddingBuffer([0.99, 0.01, 0.0]);

      mockDb.getMemoriesByLayer.mockReturnValue([]);
      mockDb.getActiveMemories.mockReturnValue([
        { id: 1, fact: '用户喜欢喝咖啡', category: 'preference', confidence: 0.9, embedding: emb1, source_ids: '[]' },
        { id: 2, fact: '用户每天喝咖啡', category: 'preference', confidence: 0.8, embedding: emb2, source_ids: '[]' },
      ]);
      mockDb.insertMemory.mockReturnValue(50);
      mockLLM.generate.mockResolvedValue('用户每天都喜欢喝咖啡');
      mockLLM.embed.mockResolvedValue([0.99, 0.005, 0.0]);

      await compactor.compact();

      expect(mockLLM.generate).toHaveBeenCalledWith({
        model: 'qwen2.5:14b',
        prompt: expect.stringContaining('用户喜欢喝咖啡'),
        temperature: 0.1,
        think: false,
      });
      expect(mockLLM.generate).toHaveBeenCalledWith({
        model: 'qwen2.5:14b',
        prompt: expect.stringContaining('用户每天喝咖啡'),
        temperature: 0.1,
        think: false,
      });
      expect(mockLLM.generate).toHaveBeenCalledWith({
        model: 'qwen2.5:14b',
        prompt: expect.stringContaining('合并后的事实'),
        temperature: 0.1,
        think: false,
      });
    });

    it('trims whitespace from LLM response', async () => {
      const emb1 = makeEmbeddingBuffer([1.0, 0.0, 0.0]);
      const emb2 = makeEmbeddingBuffer([0.99, 0.01, 0.0]);

      mockDb.getMemoriesByLayer.mockReturnValue([]);
      mockDb.getActiveMemories.mockReturnValue([
        { id: 1, fact: 'fact1', category: 'general', confidence: 0.8, embedding: emb1, source_ids: '[]' },
        { id: 2, fact: 'fact2', category: 'general', confidence: 0.7, embedding: emb2, source_ids: '[]' },
      ]);
      mockDb.insertMemory.mockReturnValue(99);
      mockLLM.generate.mockResolvedValue('  trimmed fact  \n');
      mockLLM.embed.mockResolvedValue([0.5, 0.5, 0.5]);

      await compactor.compact();

      expect(mockDb.insertMemory).toHaveBeenCalledWith(
        expect.objectContaining({ fact: 'trimmed fact' }),
      );
    });
  });

  describe('bufferToArray', () => {
    it('converts Buffer to float array correctly', async () => {
      // We test indirectly: two identical embedding buffers should have cosine similarity = 1.0
      // and thus be merged
      const values = [0.3, 0.7, 0.1];
      const emb1 = makeEmbeddingBuffer(values);
      const emb2 = makeEmbeddingBuffer(values);

      mockDb.getMemoriesByLayer.mockReturnValue([]);
      mockDb.getActiveMemories.mockReturnValue([
        { id: 1, fact: 'same fact A', category: 'general', confidence: 0.9, embedding: emb1, source_ids: '[]' },
        { id: 2, fact: 'same fact B', category: 'general', confidence: 0.8, embedding: emb2, source_ids: '[]' },
      ]);
      mockDb.insertMemory.mockReturnValue(50);
      mockLLM.generate.mockResolvedValue('merged');
      mockLLM.embed.mockResolvedValue(values);

      const result = await compactor.compact();

      // Identical vectors should definitely be merged (similarity = 1.0 > 0.80)
      expect(result.merged).toBe(2);
    });

    it('handles empty or invalid buffer gracefully', async () => {
      // Memory with invalid embedding should be skipped
      mockDb.getMemoriesByLayer.mockReturnValue([]);
      mockDb.getActiveMemories.mockReturnValue([
        { id: 1, fact: 'fact', category: 'general', confidence: 0.9, embedding: 'invalid', source_ids: '[]' },
        { id: 2, fact: 'fact2', category: 'general', confidence: 0.8, embedding: Buffer.alloc(0), source_ids: '[]' },
      ]);

      // Should not throw
      const result = await compactor.compact();
      expect(result.merged).toBe(0);
    });
  });

  describe('cosineSimilarity', () => {
    it('returns correct value for known vectors', async () => {
      // Test via merge behavior: [1, 0, 0] and [0, 1, 0] are orthogonal (sim=0)
      const emb1 = makeEmbeddingBuffer([1, 0, 0]);
      const emb2 = makeEmbeddingBuffer([0, 1, 0]);

      mockDb.getMemoriesByLayer.mockReturnValue([]);
      mockDb.getActiveMemories.mockReturnValue([
        { id: 1, fact: 'A', category: 'general', confidence: 0.9, embedding: emb1, source_ids: '[]' },
        { id: 2, fact: 'B', category: 'general', confidence: 0.8, embedding: emb2, source_ids: '[]' },
      ]);

      const result = await compactor.compact();
      // Orthogonal => similarity = 0, not > 0.80, so no merge
      expect(result.merged).toBe(0);
    });

    it('returns 1.0 for identical vectors (triggers merge)', async () => {
      const emb = makeEmbeddingBuffer([0.5, 0.5, 0.5]);

      mockDb.getMemoriesByLayer.mockReturnValue([]);
      mockDb.getActiveMemories.mockReturnValue([
        { id: 1, fact: 'A', category: 'general', confidence: 0.9, embedding: emb, source_ids: '[]' },
        { id: 2, fact: 'B', category: 'general', confidence: 0.8, embedding: makeEmbeddingBuffer([0.5, 0.5, 0.5]), source_ids: '[]' },
      ]);
      mockDb.insertMemory.mockReturnValue(50);
      mockLLM.generate.mockResolvedValue('merged');
      mockLLM.embed.mockResolvedValue([0.5, 0.5, 0.5]);

      const result = await compactor.compact();
      expect(result.merged).toBe(2);
    });

    it('returns 0 for zero vectors', async () => {
      const emb1 = makeEmbeddingBuffer([0, 0, 0]);
      const emb2 = makeEmbeddingBuffer([0.5, 0.5, 0.5]);

      mockDb.getMemoriesByLayer.mockReturnValue([]);
      mockDb.getActiveMemories.mockReturnValue([
        { id: 1, fact: 'A', category: 'general', confidence: 0.9, embedding: emb1, source_ids: '[]' },
        { id: 2, fact: 'B', category: 'general', confidence: 0.8, embedding: emb2, source_ids: '[]' },
      ]);

      const result = await compactor.compact();
      // Zero vector => denom = 0 => similarity = 0, no merge
      expect(result.merged).toBe(0);
    });
  });

  describe('source_ids merging', () => {
    it('deduplicates source IDs from multiple memories', async () => {
      const emb1 = makeEmbeddingBuffer([1.0, 0.0, 0.0]);
      const emb2 = makeEmbeddingBuffer([0.99, 0.01, 0.0]);

      mockDb.getMemoriesByLayer.mockReturnValue([]);
      mockDb.getActiveMemories.mockReturnValue([
        { id: 1, fact: 'A', category: 'general', confidence: 0.9, embedding: emb1, source_ids: '[1, 2]' },
        { id: 2, fact: 'B', category: 'general', confidence: 0.8, embedding: emb2, source_ids: '[2, 3]' },
      ]);
      mockDb.insertMemory.mockReturnValue(100);
      mockLLM.generate.mockResolvedValue('merged');
      mockLLM.embed.mockResolvedValue([0.99, 0.005, 0.0]);

      await compactor.compact();

      expect(mockDb.insertMemory).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceIds: expect.arrayContaining([1, 2, 3]),
        }),
      );
      // Verify deduplication: length should be 3, not 4
      const call = mockDb.insertMemory.mock.calls[0][0];
      expect(call.sourceIds).toHaveLength(3);
    });

    it('handles malformed source_ids gracefully', async () => {
      const emb1 = makeEmbeddingBuffer([1.0, 0.0, 0.0]);
      const emb2 = makeEmbeddingBuffer([0.99, 0.01, 0.0]);

      mockDb.getMemoriesByLayer.mockReturnValue([]);
      mockDb.getActiveMemories.mockReturnValue([
        { id: 1, fact: 'A', category: 'general', confidence: 0.9, embedding: emb1, source_ids: 'not-json' },
        { id: 2, fact: 'B', category: 'general', confidence: 0.8, embedding: emb2, source_ids: null },
      ]);
      mockDb.insertMemory.mockReturnValue(100);
      mockLLM.generate.mockResolvedValue('merged');
      mockLLM.embed.mockResolvedValue([0.99, 0.005, 0.0]);

      // Should not throw
      const result = await compactor.compact();
      expect(result.merged).toBe(2);
      expect(mockDb.insertMemory).toHaveBeenCalledWith(
        expect.objectContaining({ sourceIds: [] }),
      );
    });
  });
});
