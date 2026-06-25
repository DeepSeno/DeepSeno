import { describe, expect, it } from 'vitest';
import type { AppSettings } from '../../settings';
import { formatRagModelError, getRagModelSetupError, RAG_MODEL_SETUP_MESSAGE } from '../model-readiness';

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

describe('RAG model readiness', () => {
  it('passes when selected local chat and embedding models are downloaded', () => {
    const error = getRagModelSetupError(settings({}), {
      downloadedLocalModelIds: ['qwen3.5:4b', 'bge-m3'],
      localModelFileExists: () => false,
    });

    expect(error).toBeNull();
  });

  it('returns a friendly setup message when local chat model is missing', () => {
    const error = getRagModelSetupError(settings({}), {
      downloadedLocalModelIds: ['bge-m3'],
      localModelFileExists: () => false,
    });

    expect(error).toBe(RAG_MODEL_SETUP_MESSAGE);
  });

  it('returns a friendly setup message when local embedding model is missing', () => {
    const error = getRagModelSetupError(settings({}), {
      downloadedLocalModelIds: ['qwen3.5:4b'],
      localModelFileExists: () => false,
    });

    expect(error).toBe(RAG_MODEL_SETUP_MESSAGE);
  });

  it('requires cloud api, chat model, and embedding model for cloud mode', () => {
    const error = getRagModelSetupError(settings({
      llmProvider: 'openai',
      cloudApiUrl: 'https://api.example.com/v1',
      cloudApiKey: 'key',
      cloudModel: 'chat-model',
      cloudEmbedModel: '',
    }));

    expect(error).toBe(RAG_MODEL_SETUP_MESSAGE);
  });

  it('passes when cloud mode is fully configured', () => {
    const error = getRagModelSetupError(settings({
      llmProvider: 'openai',
      cloudApiUrl: 'https://api.example.com/v1',
      cloudApiKey: 'key',
      cloudModel: 'chat-model',
      cloudEmbedModel: 'embed-model',
    }));

    expect(error).toBeNull();
  });

  it('converts model-related 404 errors into the friendly setup message', () => {
    expect(formatRagModelError(new Error('OpenAI stream failed: 404 model not found')))
      .toBe(RAG_MODEL_SETUP_MESSAGE);
  });
});
