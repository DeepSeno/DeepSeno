import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { VoiceBrainDB } from '../database';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('agent_memory', () => {
  let db: VoiceBrainDB;
  let dbPath: string;

  beforeEach(() => {
    dbPath = path.join(
      os.tmpdir(),
      `deepseno-memory-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
    );
    db = new VoiceBrainDB(dbPath);
  });

  afterEach(() => {
    db.close();
    for (const suffix of ['', '-wal', '-shm']) {
      const f = dbPath + suffix;
      if (fs.existsSync(f)) {
        fs.unlinkSync(f);
      }
    }
  });

  it('inserts and retrieves memory', () => {
    const id = db.insertMemory({
      fact: '张总是合伙人',
      category: 'person',
      layer: 'active',
      confidence: 0.8,
      sourceIds: [1],
    });
    expect(id).toBeGreaterThan(0);
    const memories = db.getActiveMemories();
    expect(memories.length).toBe(1);
    expect(memories[0].fact).toBe('张总是合伙人');
    expect(memories[0].confidence).toBe(0.8);
  });

  it('core memories appear before active', () => {
    db.insertMemory({ fact: 'active fact', category: 'general', layer: 'active', confidence: 1.0, sourceIds: [] });
    db.insertMemory({ fact: 'core fact', category: 'general', layer: 'core', confidence: 0.5, sourceIds: [] });
    const memories = db.getActiveMemories();
    expect(memories[0].fact).toBe('core fact'); // core first regardless of confidence
    expect(memories[1].fact).toBe('active fact');
  });

  it('supersedes old memory', () => {
    const old = db.insertMemory({ fact: 'Q1目标500万', category: 'business', layer: 'active', confidence: 0.9, sourceIds: [1] });
    const newer = db.insertMemory({ fact: 'Q1目标300万', category: 'business', layer: 'active', confidence: 0.9, sourceIds: [2] });
    db.supersedeMemory(old, newer);
    const active = db.getActiveMemories();
    expect(active.length).toBe(1);
    expect(active[0].fact).toBe('Q1目标300万');
  });

  it('promotes memory to core', () => {
    const id = db.insertMemory({ fact: 'important', category: 'general', layer: 'active', confidence: 0.5, sourceIds: [] });
    db.promoteMemory(id, 'core');
    const core = db.getMemoriesByLayer('core');
    expect(core.length).toBe(1);
    expect(core[0].fact).toBe('important');
  });

  it('updates mention count and last_seen', () => {
    const id = db.insertMemory({ fact: 'test', category: 'general', layer: 'active', confidence: 0.5, sourceIds: [] });
    db.updateMemoryLastSeen(id);
    db.updateMemoryLastSeen(id);
    const memories = db.getActiveMemories();
    expect(memories[0].mention_count).toBe(3); // 1 initial + 2 updates
  });

  it('deletes memory', () => {
    const id = db.insertMemory({ fact: 'to delete', category: 'general', layer: 'active', confidence: 0.5, sourceIds: [] });
    db.deleteMemory(id);
    expect(db.getActiveMemories().length).toBe(0);
  });

  it('returns correct stats', () => {
    db.insertMemory({ fact: 'f1', category: 'general', layer: 'core', confidence: 1, sourceIds: [] });
    db.insertMemory({ fact: 'f2', category: 'general', layer: 'active', confidence: 0.5, sourceIds: [] });
    db.insertMemory({ fact: 'f3', category: 'general', layer: 'active', confidence: 0.5, sourceIds: [] });
    db.insertMemory({ fact: 'f4', category: 'general', layer: 'archive', confidence: 0.3, sourceIds: [] });
    const stats = db.getMemoryStats();
    expect(stats.core).toBe(1);
    expect(stats.active).toBe(2);
    expect(stats.archive).toBe(1);
  });

  it('updates fact text', () => {
    const id = db.insertMemory({ fact: 'old text', category: 'general', layer: 'active', confidence: 0.5, sourceIds: [] });
    db.updateMemoryFact(id, 'new text');
    const memories = db.getActiveMemories();
    expect(memories[0].fact).toBe('new text');
  });

  it('getAllMemories excludes superseded', () => {
    const old = db.insertMemory({ fact: 'old', category: 'general', layer: 'active', confidence: 0.5, sourceIds: [] });
    const newer = db.insertMemory({ fact: 'new', category: 'general', layer: 'active', confidence: 0.5, sourceIds: [] });
    db.supersedeMemory(old, newer);
    const all = db.getAllMemories();
    expect(all.length).toBe(1);
    expect(all[0].fact).toBe('new');
  });

  it('updates memory embedding', () => {
    const id = db.insertMemory({ fact: 'with embedding', category: 'general', layer: 'active', confidence: 0.5, sourceIds: [] });
    const embedding = Buffer.from(new Float32Array([0.1, 0.2, 0.3]).buffer);
    db.updateMemoryEmbedding(id, embedding);
    const memories = db.getActiveMemories();
    expect(memories[0].embedding).toBeTruthy();
    expect(memories[0].embedding instanceof Uint8Array).toBe(true);
  });

  it('getMemoriesByLayer filters correctly', () => {
    db.insertMemory({ fact: 'core1', category: 'general', layer: 'core', confidence: 0.9, sourceIds: [] });
    db.insertMemory({ fact: 'active1', category: 'general', layer: 'active', confidence: 0.7, sourceIds: [] });
    db.insertMemory({ fact: 'archive1', category: 'general', layer: 'archive', confidence: 0.3, sourceIds: [] });
    expect(db.getMemoriesByLayer('core').length).toBe(1);
    expect(db.getMemoriesByLayer('active').length).toBe(1);
    expect(db.getMemoriesByLayer('archive').length).toBe(1);
  });

  it('stores source_ids as JSON', () => {
    db.insertMemory({ fact: 'multi-source', category: 'general', layer: 'active', confidence: 0.5, sourceIds: [1, 2, 3] });
    const memories = db.getActiveMemories();
    const sourceIds = JSON.parse(memories[0].source_ids);
    expect(sourceIds).toEqual([1, 2, 3]);
  });

  describe('FTS5 search', () => {
    it('finds memory by keyword', () => {
      db.insertMemory({ fact: '张总是ABC公司的CTO', category: 'person', layer: 'active', confidence: 0.9, sourceIds: [1] });
      db.insertMemory({ fact: '下周二有产品评审会', category: 'business', layer: 'active', confidence: 0.8, sourceIds: [2] });
      const results = db.searchMemoriesFts('ABC公司');
      expect(results.length).toBe(1);
      expect(results[0].fact).toContain('ABC公司');
    });

    it('returns empty for no match', () => {
      db.insertMemory({ fact: '测试记忆', category: 'general', layer: 'active', confidence: 0.5, sourceIds: [] });
      const results = db.searchMemoriesFts('不存在的关键词xyz');
      expect(results.length).toBe(0);
    });

    it('excludes superseded memories', () => {
      const old = db.insertMemory({ fact: 'Q1目标500万', category: 'business', layer: 'active', confidence: 0.9, sourceIds: [1] });
      const newer = db.insertMemory({ fact: 'Q1目标300万', category: 'business', layer: 'active', confidence: 0.9, sourceIds: [2] });
      db.supersedeMemory(old, newer);
      const results = db.searchMemoriesFts('目标');
      expect(results.length).toBe(1);
      expect(results[0].fact).toContain('300万');
    });

    it('excludes archived memories', () => {
      db.insertMemory({ fact: '归档的记忆', category: 'general', layer: 'archive', confidence: 0.3, sourceIds: [] });
      db.insertMemory({ fact: '活跃的记忆', category: 'general', layer: 'active', confidence: 0.8, sourceIds: [] });
      const results = db.searchMemoriesFts('记忆');
      expect(results.length).toBe(1);
      expect(results[0].fact).toContain('活跃');
    });
  });
});
