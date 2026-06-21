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

describe('TextOptimizer.scoreImportance', () => {
  it('returns score + reason for substantive content', async () => {
    const client = mockClient([{ score: 8.5, reason: 'Contains concrete decisions and timeline' }]);
    const opt = new TextOptimizer(client, 'qwen3.5:4b');
    const r = await opt.scoreImportance(
      '明天三点跟王总开会过预算',
      { durationSec: 60, speakerCount: 1, mediaType: 'audio' },
    );
    expect(r.score).toBe(8.5);
    expect(r.reason.length).toBeGreaterThan(0);
  });

  it('clamps scores above 10 to 10', async () => {
    const client = mockClient([{ score: 99, reason: 'x' }]);
    const opt = new TextOptimizer(client, 'qwen3.5:4b');
    const r = await opt.scoreImportance(
      'a longer text to pass length check',
      { durationSec: 5, speakerCount: 1, mediaType: 'audio' },
    );
    expect(r.score).toBe(10);
  });

  it('clamps negative scores to 0', async () => {
    const client = mockClient([{ score: -3, reason: '' }]);
    const opt = new TextOptimizer(client, 'qwen3.5:4b');
    const r = await opt.scoreImportance(
      'a longer text to pass length check',
      { durationSec: 5, speakerCount: 1, mediaType: 'audio' },
    );
    expect(r.score).toBe(0);
  });

  it('defaults to score 0 when LLM returns no score field', async () => {
    const client = mockClient([{ reason: 'no score' }]);
    const opt = new TextOptimizer(client, 'qwen3.5:4b');
    const r = await opt.scoreImportance(
      'a longer text to pass length check',
      { durationSec: 5, speakerCount: 1, mediaType: 'audio' },
    );
    expect(r.score).toBe(0);
  });

  it('skips LLM entirely for transcripts shorter than 8 chars', async () => {
    // mockClient with empty array — any call would throw "no more"
    const client = mockClient([]);
    const opt = new TextOptimizer(client, 'qwen3.5:4b');
    const r = await opt.scoreImportance('hi', { durationSec: 1, speakerCount: 1, mediaType: 'audio' });
    expect(r.score).toBe(0);
    expect(r.reason).toBe('too short');
  });

  it('returns score 0 + empty reason when LLM call throws', async () => {
    const failingClient: LLMClient = {
      async generate() { throw new Error(); },
      async generateStream() { throw new Error(); },
      async generateJSON() { throw new Error('LLM down'); },
      async embed() { return []; },
      async isAvailable() { return false; },
      async listModels() { return []; },
    };
    const opt = new TextOptimizer(failingClient, 'qwen3.5:4b');
    const r = await opt.scoreImportance(
      'long enough text here for the length check',
      { durationSec: 10, speakerCount: 1, mediaType: 'audio' },
    );
    expect(r.score).toBe(0);
    expect(r.reason).toBe('');
  });
});
