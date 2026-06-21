import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryManager } from '../agent/memory-manager';

// Mock settings
vi.mock('../settings', () => ({
  loadSettings: () => ({
    embedModel: 'bge-m3',
    llmProvider: 'local',
    cloudEmbedModel: '',
  }),
}));

vi.mock('../llm/create-client', () => ({
  getEmbedModel: () => 'bge-m3',
}));

describe('MemoryManager', () => {
  let mockDb: any;
  let mockLLM: any;
  let manager: MemoryManager;

  beforeEach(() => {
    mockDb = {
      getActiveMemories: vi.fn().mockReturnValue([]),
      insertMemory: vi.fn().mockReturnValue(1),
      updateMemoryEmbedding: vi.fn(),
      supersedeMemory: vi.fn(),
      promoteMemory: vi.fn(),
      searchMemoriesFts: vi.fn().mockReturnValue([]),
      getRawDb: vi.fn().mockReturnValue({ exec: vi.fn() }),
    };
    mockLLM = {
      embed: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]),
    };
    manager = new MemoryManager(mockDb, mockLLM);
  });

  describe('addFact', () => {
    it('inserts new fact when no similar memory exists', async () => {
      const id = await manager.addFact('张总是合伙人', 'person', 0.9, [1]);
      expect(id).toBe(1);
      expect(mockDb.insertMemory).toHaveBeenCalledWith({
        fact: '张总是合伙人',
        category: 'person',
        layer: 'active',
        confidence: 0.9,
        sourceIds: [1],
      });
      expect(mockDb.updateMemoryEmbedding).toHaveBeenCalled();
      expect(mockDb.supersedeMemory).not.toHaveBeenCalled();
    });

    it('supersedes existing memory when similarity > 0.85', async () => {
      // Create an embedding buffer that will produce high cosine similarity
      const embedding = [0.1, 0.2, 0.3];
      const embBuffer = Buffer.from(new Float32Array(embedding).buffer);

      mockDb.getActiveMemories.mockReturnValue([
        { id: 10, fact: 'Q1目标500万', embedding: embBuffer, layer: 'active' },
      ]);
      // Return same embedding so cosine similarity = 1.0
      mockLLM.embed.mockResolvedValue([0.1, 0.2, 0.3]);
      mockDb.insertMemory.mockReturnValue(11);

      const id = await manager.addFact('Q1目标300万', 'business', 0.9, [2]);
      expect(id).toBe(11);
      expect(mockDb.supersedeMemory).toHaveBeenCalledWith(10, 11);
    });

    it('does not supersede when similarity <= 0.85', async () => {
      // Use orthogonal vectors for low similarity
      const embBuffer = Buffer.from(new Float32Array([1, 0, 0]).buffer);

      mockDb.getActiveMemories.mockReturnValue([
        { id: 10, fact: '完全不同的事实', embedding: embBuffer, layer: 'active' },
      ]);
      // Return different vector
      mockLLM.embed.mockResolvedValue([0, 1, 0]);

      await manager.addFact('新事实', 'general', 0.7, [3]);
      expect(mockDb.supersedeMemory).not.toHaveBeenCalled();
    });
  });

  describe('getRelevantMemories', () => {
    it('returns empty string when no memories', () => {
      mockDb.getActiveMemories.mockReturnValue([]);
      expect(manager.getRelevantMemories()).toBe('');
    });

    it('formats memories with layer tags', () => {
      mockDb.getActiveMemories.mockReturnValue([
        { fact: '用户是CEO', layer: 'core' },
        { fact: '下周有会议', layer: 'active' },
      ]);
      const result = manager.getRelevantMemories();
      expect(result).toContain('## 已知信息');
      expect(result).toContain('- [core] 用户是CEO');
      expect(result).toContain('- [active] 下周有会议');
    });

    it('respects token budget', () => {
      // Create many memories that exceed budget
      const memories = Array.from({ length: 100 }, (_, i) => ({
        fact: `这是一条很长的记忆条目编号${i}，包含很多字符来测试token预算限制功能`,
        layer: 'active',
      }));
      mockDb.getActiveMemories.mockReturnValue(memories);
      const result = manager.getRelevantMemories(50); // very small budget
      const lines = result.split('\n').filter(l => l.startsWith('- '));
      expect(lines.length).toBeLessThan(100);
    });
  });

  describe('decayStaleMemories', () => {
    it('archives memories older than 30 days', () => {
      const oldDate = new Date();
      oldDate.setDate(oldDate.getDate() - 60);
      const oldDateStr = oldDate.toISOString().split('T')[0];

      mockDb.getActiveMemories.mockReturnValue([
        { id: 1, layer: 'active', last_seen: oldDateStr },
        { id: 2, layer: 'core', last_seen: oldDateStr }, // core should not be decayed
      ]);

      const count = manager.decayStaleMemories();
      expect(count).toBe(1); // only active layer gets decayed
      expect(mockDb.promoteMemory).toHaveBeenCalledWith(1, 'archive');
    });

    it('does not decay recent memories', () => {
      const recentDate = new Date().toISOString().split('T')[0];
      mockDb.getActiveMemories.mockReturnValue([
        { id: 1, layer: 'active', last_seen: recentDate },
      ]);

      const count = manager.decayStaleMemories();
      expect(count).toBe(0);
      expect(mockDb.promoteMemory).not.toHaveBeenCalled();
    });
  });

  describe('cosineSimilarity (via addFact)', () => {
    it('returns 0 for mismatched lengths', async () => {
      // Use a vector with different length stored in DB
      const embBuffer = Buffer.from(new Float32Array([1, 0]).buffer);
      mockDb.getActiveMemories.mockReturnValue([
        { id: 10, fact: 'test', embedding: embBuffer, layer: 'active' },
      ]);
      mockLLM.embed.mockResolvedValue([0.1, 0.2, 0.3]); // 3 dims vs 2 dims

      await manager.addFact('new fact', 'general', 0.8, [1]);
      // Should not supersede because similarity = 0 for mismatched lengths
      expect(mockDb.supersedeMemory).not.toHaveBeenCalled();
    });
  });

  describe('searchMemories (query-aware)', () => {
    it('returns memories ranked by semantic similarity to query', async () => {
      const abcEmb = Buffer.from(new Float32Array([0.9, 0.1, 0.0]).buffer);
      const meetEmb = Buffer.from(new Float32Array([0.0, 0.1, 0.9]).buffer);

      mockDb.getActiveMemories.mockReturnValue([
        { id: 1, fact: '张总是ABC公司的CTO', layer: 'active', confidence: 0.9, embedding: abcEmb, last_seen: new Date().toISOString().split('T')[0] },
        { id: 2, fact: '下周有产品评审会', layer: 'active', confidence: 0.9, embedding: meetEmb, last_seen: new Date().toISOString().split('T')[0] },
      ]);
      mockDb.searchMemoriesFts.mockReturnValue([]);
      mockLLM.embed.mockResolvedValue([0.85, 0.15, 0.05]);

      const result = await manager.searchMemories('ABC公司的负责人是谁');
      expect(result).toContain('ABC公司');
    });

    it('returns formatted text within token budget', async () => {
      mockDb.getActiveMemories.mockReturnValue([]);
      mockDb.searchMemoriesFts.mockReturnValue([]);
      mockLLM.embed.mockResolvedValue([0.1, 0.2, 0.3]);
      const result = await manager.searchMemories('test query', 50);
      expect(result.length).toBeLessThanOrEqual(200);
    });

    it('boosts core memories regardless of similarity', async () => {
      const coreEmb = Buffer.from(new Float32Array([0.0, 0.0, 1.0]).buffer);
      const activeEmb = Buffer.from(new Float32Array([0.9, 0.1, 0.0]).buffer);

      mockDb.getActiveMemories.mockReturnValue([
        { id: 1, fact: '核心身份信息', layer: 'core', confidence: 1.0, embedding: coreEmb, last_seen: new Date().toISOString().split('T')[0] },
        { id: 2, fact: '相关活跃记忆', layer: 'active', confidence: 0.8, embedding: activeEmb, last_seen: new Date().toISOString().split('T')[0] },
      ]);
      mockDb.searchMemoriesFts.mockReturnValue([]);
      mockLLM.embed.mockResolvedValue([0.85, 0.15, 0.05]);

      const result = await manager.searchMemories('相关查询');
      expect(result).toContain('核心身份信息');
    });

    it('applies time decay — recent memories score higher', async () => {
      const today = new Date().toISOString().split('T')[0];
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      const oldDate = thirtyDaysAgo.toISOString().split('T')[0];
      const emb = Buffer.from(new Float32Array([0.5, 0.5, 0.0]).buffer);

      mockDb.getActiveMemories.mockReturnValue([
        { id: 1, fact: '旧记忆同样相关', layer: 'active', confidence: 0.9, embedding: emb, last_seen: oldDate },
        { id: 2, fact: '新记忆同样相关', layer: 'active', confidence: 0.9, embedding: emb, last_seen: today },
      ]);
      mockDb.searchMemoriesFts.mockReturnValue([]);
      mockLLM.embed.mockResolvedValue([0.5, 0.5, 0.0]);

      const result = await manager.searchMemories('相关查询');
      const newIdx = result.indexOf('新记忆');
      const oldIdx = result.indexOf('旧记忆');
      if (newIdx !== -1 && oldIdx !== -1) {
        expect(newIdx).toBeLessThan(oldIdx);
      }
    });

    it('merges FTS5 keyword results with vector results', async () => {
      const orthEmb = Buffer.from(new Float32Array([0.0, 0.0, 1.0]).buffer);

      mockDb.getActiveMemories.mockReturnValue([
        { id: 1, fact: '张总电话是00000000000', layer: 'active', confidence: 0.8, embedding: orthEmb, last_seen: new Date().toISOString().split('T')[0] },
      ]);
      mockDb.searchMemoriesFts.mockReturnValue([
        { id: 1, fact: '张总电话是00000000000', rank: -1.5 },
      ]);
      mockLLM.embed.mockResolvedValue([1.0, 0.0, 0.0]);

      const result = await manager.searchMemories('张总的电话号码');
      expect(result).toContain('00000000000');
    });

    it('returns empty string when no memories exist', async () => {
      mockDb.getActiveMemories.mockReturnValue([]);
      mockDb.searchMemoriesFts.mockReturnValue([]);
      mockLLM.embed.mockResolvedValue([0.1, 0.2, 0.3]);

      const result = await manager.searchMemories('任意查询');
      expect(result).toBe('');
    });

    it('handles memories without embeddings gracefully', async () => {
      mockDb.getActiveMemories.mockReturnValue([
        { id: 1, fact: '没有嵌入的记忆', layer: 'active', confidence: 0.8, embedding: null, last_seen: new Date().toISOString().split('T')[0] },
      ]);
      mockDb.searchMemoriesFts.mockReturnValue([
        { id: 1, fact: '没有嵌入的记忆', rank: -1.0 },
      ]);
      mockLLM.embed.mockResolvedValue([0.1, 0.2, 0.3]);

      const result = await manager.searchMemories('查询');
      expect(result).toContain('没有嵌入的记忆');
    });
  });
});
