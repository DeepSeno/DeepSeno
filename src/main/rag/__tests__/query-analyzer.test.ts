import { describe, it, expect, beforeEach } from 'vitest';
import { QueryAnalyzer, type QueryAnalysis } from '../query-analyzer';
import { QueryAnalysisCache } from '../../llm/query-analysis-cache';
import type { LLMClient } from '../../llm/llm-client';

function makeClient(jsonResponses: Array<Record<string, unknown>>): {
  client: LLMClient;
  calls: number;
} {
  const state = { idx: 0, calls: 0 };
  const client: LLMClient = {
    async generate() { throw new Error('not used'); },
    async generateStream() { throw new Error('not used'); },
    async generateJSON<T>() {
      state.calls++;
      const next = jsonResponses[state.idx++];
      if (!next) throw new Error('no more mock responses');
      return next as unknown as T;
    },
    async embed() { return []; },
    async isAvailable() { return true; },
    async listModels() { return []; },
  };
  return {
    client,
    get calls() { return state.calls; },
  } as { client: LLMClient; calls: number };
}

const TODAY = '2026-05-16';

describe('QueryAnalyzer.analyze', () => {
  let cache: QueryAnalysisCache;
  beforeEach(() => { cache = new QueryAnalysisCache(); });

  it('classifies "今天我干了什么" as summary with today range', async () => {
    const mock = makeClient([{
      intent: 'summary',
      temporal_range: { start: TODAY, end: TODAY },
      entities: [],
      rewritten_query: '今天我做了什么事情',
    }]);
    const analyzer = new QueryAnalyzer(mock.client, 'qwen3.5:4b', cache);
    const r = await analyzer.analyze('今天我干了什么', TODAY);
    expect(r.intent).toBe('summary');
    expect(r.temporal_range).toEqual({ start: TODAY, end: TODAY });
    expect(r.rewritten_query).toBe('今天我做了什么事情');
  });

  it('classifies casual "今儿都忙啥呢" as summary (regression — keywords would miss this)', async () => {
    const mock = makeClient([{
      intent: 'summary',
      temporal_range: { start: TODAY, end: TODAY },
      entities: [],
      rewritten_query: '今天我做了什么事情',
    }]);
    const analyzer = new QueryAnalyzer(mock.client, 'qwen3.5:4b', cache);
    const r = await analyzer.analyze('今儿都忙啥呢', TODAY);
    expect(r.intent).toBe('summary');
    expect(r.temporal_range?.start).toBe(TODAY);
  });

  it('classifies English "what did I do today" as summary', async () => {
    const mock = makeClient([{
      intent: 'summary',
      temporal_range: { start: TODAY, end: TODAY },
      entities: [],
      rewritten_query: 'what did I do today',
    }]);
    const analyzer = new QueryAnalyzer(mock.client, 'qwen3.5:4b', cache);
    const r = await analyzer.analyze('what did I do today', TODAY);
    expect(r.intent).toBe('summary');
  });

  it('classifies planning intent', async () => {
    const mock = makeClient([{
      intent: 'planning',
      temporal_range: null,
      entities: [],
      rewritten_query: '我下一步该做什么',
    }]);
    const analyzer = new QueryAnalyzer(mock.client, 'qwen3.5:4b', cache);
    const r = await analyzer.analyze('我下一步该做什么', TODAY);
    expect(r.intent).toBe('planning');
    expect(r.temporal_range).toBeNull();
  });

  it('classifies person intent + extracts entity', async () => {
    const mock = makeClient([{
      intent: 'person',
      temporal_range: null,
      entities: ['张三'],
      rewritten_query: '张三是谁',
    }]);
    const analyzer = new QueryAnalyzer(mock.client, 'qwen3.5:4b', cache);
    const r = await analyzer.analyze('张三是谁', TODAY);
    expect(r.intent).toBe('person');
    expect(r.entities).toContain('张三');
  });

  it('caches results — same question twice means one LLM call', async () => {
    const mock = makeClient([{
      intent: 'factual',
      temporal_range: null,
      entities: [],
      rewritten_query: '某个具体问题',
    }]);
    const analyzer = new QueryAnalyzer(mock.client, 'qwen3.5:4b', cache);
    await analyzer.analyze('某个具体问题', TODAY);
    await analyzer.analyze('某个具体问题', TODAY);
    expect((mock as unknown as { calls: number }).calls).toBe(1);
  });

  it('different history → different cache key (no cross-contamination)', async () => {
    const mock = makeClient([
      { intent: 'person', temporal_range: null, entities: ['Alice'], rewritten_query: 'who is Alice' },
      { intent: 'person', temporal_range: null, entities: ['Bob'], rewritten_query: 'who is Bob' },
    ]);
    const analyzer = new QueryAnalyzer(mock.client, 'qwen3.5:4b', cache);
    const r1 = await analyzer.analyze('that person', TODAY, [
      { role: 'assistant', content: 'we discussed Alice yesterday' },
    ]);
    const r2 = await analyzer.analyze('that person', TODAY, [
      { role: 'assistant', content: 'we discussed Bob yesterday' },
    ]);
    expect(r1.entities).toContain('Alice');
    expect(r2.entities).toContain('Bob');
    expect((mock as unknown as { calls: number }).calls).toBe(2);
  });

  it('coerces invalid intent to factual', async () => {
    const mock = makeClient([{
      intent: 'weird-non-enum-value',
      temporal_range: null,
      entities: [],
      rewritten_query: 'hi',
    }]);
    const analyzer = new QueryAnalyzer(mock.client, 'qwen3.5:4b', cache);
    const r = await analyzer.analyze('hi', TODAY);
    expect(r.intent).toBe('factual');
  });

  it('rejects invalid temporal_range (bad date format)', async () => {
    const mock = makeClient([{
      intent: 'summary',
      temporal_range: { start: 'today', end: 'now' },
      entities: [],
      rewritten_query: '今天',
    }]);
    const analyzer = new QueryAnalyzer(mock.client, 'qwen3.5:4b', cache);
    const r = await analyzer.analyze('今天', TODAY);
    expect(r.temporal_range).toBeNull();
  });

  it('rejects temporal_range when start > end', async () => {
    const mock = makeClient([{
      intent: 'summary',
      temporal_range: { start: '2026-05-20', end: '2026-05-10' },
      entities: [],
      rewritten_query: 'q',
    }]);
    const analyzer = new QueryAnalyzer(mock.client, 'qwen3.5:4b', cache);
    const r = await analyzer.analyze('q', TODAY);
    expect(r.temporal_range).toBeNull();
  });

  it('falls back rewritten_query to original when empty', async () => {
    const mock = makeClient([{
      intent: 'factual',
      temporal_range: null,
      entities: [],
      rewritten_query: '',
    }]);
    const analyzer = new QueryAnalyzer(mock.client, 'qwen3.5:4b', cache);
    const r = await analyzer.analyze('my question', TODAY);
    expect(r.rewritten_query).toBe('my question');
  });

  it('filters empty entities and non-string entries', async () => {
    const mock = makeClient([{
      intent: 'person',
      temporal_range: null,
      entities: ['Alice', '', '  ', null, 42, 'Bob'],
      rewritten_query: 'q',
    }]);
    const analyzer = new QueryAnalyzer(mock.client, 'qwen3.5:4b', cache);
    const r = await analyzer.analyze('q', TODAY);
    expect(r.entities).toEqual(['Alice', 'Bob']);
  });

  it('propagates LLM errors (no silent fallback)', async () => {
    const failingClient: LLMClient = {
      async generate() { throw new Error('not used'); },
      async generateStream() { throw new Error('not used'); },
      async generateJSON() { throw new Error('LLM unavailable'); },
      async embed() { return []; },
      async isAvailable() { return false; },
      async listModels() { return []; },
    };
    const analyzer = new QueryAnalyzer(failingClient, 'qwen3.5:4b', cache);
    await expect(analyzer.analyze('q', TODAY)).rejects.toThrow('LLM unavailable');
  });
});

describe('QueryAnalysisCache.hashHistory', () => {
  it('returns empty string for no/empty history', () => {
    expect(QueryAnalysisCache.hashHistory()).toBe('');
    expect(QueryAnalysisCache.hashHistory([])).toBe('');
  });

  it('returns same hash for identical history', () => {
    const h1 = QueryAnalysisCache.hashHistory([{ role: 'user', content: 'hi' }]);
    const h2 = QueryAnalysisCache.hashHistory([{ role: 'user', content: 'hi' }]);
    expect(h1).toBe(h2);
    expect(h1.length).toBeGreaterThan(0);
  });

  it('returns different hash for different history', () => {
    const h1 = QueryAnalysisCache.hashHistory([{ role: 'user', content: 'A' }]);
    const h2 = QueryAnalysisCache.hashHistory([{ role: 'user', content: 'B' }]);
    expect(h1).not.toBe(h2);
  });
});

describe('QueryAnalysisCache TTL + LRU', () => {
  it('evicts oldest entry when capacity exceeded', () => {
    const cache = new QueryAnalysisCache(/* maxSize */ 2);
    const dummy = (i: number): QueryAnalysis => ({
      intent: 'factual', temporal_range: null, entities: [], rewritten_query: `q${i}`,
    });
    cache.set('m', 'q1', '', dummy(1));
    cache.set('m', 'q2', '', dummy(2));
    cache.set('m', 'q3', '', dummy(3));
    expect(cache.get('m', 'q1', '')).toBeUndefined();
    expect(cache.get('m', 'q2', '')?.rewritten_query).toBe('q2');
    expect(cache.get('m', 'q3', '')?.rewritten_query).toBe('q3');
  });
});
