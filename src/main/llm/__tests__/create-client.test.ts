import { describe, expect, it } from 'vitest';
import type { AppSettings } from '../../settings';
import { getEmbedModel, getLLMModel } from '../create-client';

function settings(overrides: Partial<AppSettings>): AppSettings {
  return {
    llmProvider: 'local',
    llmModel: 'qwen3.5:4b',
    embedModel: 'bge-m3',
    localLlmModel: '',
    localEmbedModel: '',
    cloudApiUrl: '',
    cloudApiKey: '',
    cloudModel: '',
    cloudEmbedModel: '',
    ...overrides,
  } as AppSettings;
}

describe('create-client model names', () => {
  it('uses router aliases for built-in local model ids', () => {
    expect(getLLMModel(settings({ llmModel: 'qwen3.5:4b' }))).toBe('Qwen3.5-4B-Q4_K_M');
    expect(getEmbedModel(settings({ embedModel: 'bge-m3' }))).toBe('bge-m3-Q8_0');
  });

  it('normalizes local GGUF file paths to router model aliases', () => {
    expect(getLLMModel(settings({
      localLlmModel: '/tmp/deepseno/models/Qwen3.5-4B-Q4_K_M.gguf',
    }))).toBe('Qwen3.5-4B-Q4_K_M');

    expect(getEmbedModel(settings({
      localEmbedModel: String.raw`C:\Users\me\AppData\DeepSeno\models\bge-m3-Q8_0.gguf`,
    }))).toBe('bge-m3-Q8_0');
  });

  it('keeps cloud model names unchanged', () => {
    expect(getLLMModel(settings({
      llmProvider: 'openai',
      cloudModel: 'doubao-seed-2.0-lite',
    }))).toBe('doubao-seed-2.0-lite');
  });

  it('uses the visible cloud model as the cloud embedding fallback', () => {
    expect(getEmbedModel(settings({
      llmProvider: 'openai',
      cloudModel: 'doubao-seed-2.0-lite',
      cloudEmbedModel: '',
      embedModel: 'bge-m3',
    }))).toBe('doubao-seed-2.0-lite');
  });

  it('prefers the explicit cloud embedding model when configured', () => {
    expect(getEmbedModel(settings({
      llmProvider: 'openai',
      cloudModel: 'doubao-seed-2.0-lite',
      cloudEmbedModel: 'text-embedding-3-small',
    }))).toBe('text-embedding-3-small');
  });
});
