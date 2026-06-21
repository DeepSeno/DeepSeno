import { describe, it, expect } from 'vitest';
import { TextOptimizer } from '../text-optimizer';
import type { LLMClient } from '../llm-client';

function mockClient(jsonResponses: Array<Record<string, unknown>>): LLMClient {
  let idx = 0;
  return {
    async generate() { throw new Error('not used'); },
    async generateStream() { throw new Error('not used'); },
    async generateJSON<T>() {
      const r = jsonResponses[idx++];
      if (!r) throw new Error('no more mock responses');
      return r as T;
    },
    async embed() { return []; },
    async isAvailable() { return true; },
    async listModels() { return []; },
  };
}

describe('TextOptimizer.detectSessionTopic', () => {
  it('returns coherent topic + summary when members share theme', async () => {
    const client = mockClient([
      { topic: 'Dashboard 调试', summary: '讨论 TODAY 过滤逻辑', isCoherent: true },
    ]);
    const opt = new TextOptimizer(client, 'qwen3.5:4b');
    const r = await opt.detectSessionTopic([
      { transcript: '这里的过滤逻辑应该改', durationSec: 30 },
      { transcript: '改完之后跑下测试', durationSec: 20 },
    ]);
    expect(r.isCoherent).toBe(true);
    expect(r.topic).toBe('Dashboard 调试');
    expect(r.summary.length).toBeGreaterThan(0);
  });

  it('returns isCoherent=false when topics differ', async () => {
    const client = mockClient([{ topic: '', summary: '', isCoherent: false }]);
    const opt = new TextOptimizer(client, 'qwen3.5:4b');
    const r = await opt.detectSessionTopic([
      { transcript: '今晚去吃火锅吧', durationSec: 10 },
      { transcript: '修一下那个 bug', durationSec: 30 },
    ]);
    expect(r.isCoherent).toBe(false);
  });

  it('returns isCoherent=true with empty topic when only 1 member (no LLM call)', async () => {
    // empty mock → any call throws
    const client = mockClient([]);
    const opt = new TextOptimizer(client, 'qwen3.5:4b');
    const r = await opt.detectSessionTopic([{ transcript: '一段话', durationSec: 30 }]);
    expect(r.isCoherent).toBe(true);
    expect(r.topic).toBe('');
  });

  it('returns isCoherent=true with empty fields on LLM error (pipeline must not crash)', async () => {
    const failingClient: LLMClient = {
      async generate() { throw new Error(); },
      async generateStream() { throw new Error(); },
      async generateJSON() { throw new Error('LLM down'); },
      async embed() { return []; },
      async isAvailable() { return false; },
      async listModels() { return []; },
    };
    const opt = new TextOptimizer(failingClient, 'qwen3.5:4b');
    const r = await opt.detectSessionTopic([
      { transcript: 'a', durationSec: 10 },
      { transcript: 'b', durationSec: 10 },
    ]);
    expect(r.isCoherent).toBe(true);
    expect(r.topic).toBe('');
    expect(r.summary).toBe('');
  });

  it('caps topic length to 40 chars', async () => {
    const longTopic = 'X'.repeat(100);
    const client = mockClient([{ topic: longTopic, summary: 'y', isCoherent: true }]);
    const opt = new TextOptimizer(client, 'qwen3.5:4b');
    const r = await opt.detectSessionTopic([
      { transcript: 'a', durationSec: 10 },
      { transcript: 'b', durationSec: 10 },
    ]);
    expect(r.topic.length).toBe(40);
  });
});
