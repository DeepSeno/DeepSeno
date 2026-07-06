import { OpenAIClient } from './openai-client';
import type { LLMClient } from './llm-client';
import type { AppSettings } from '../settings';
import { toLocalModelApiName } from './model-names';

/**
 * Create the right LLM client based on current settings.
 */
export function createLLMClient(settings: AppSettings): LLMClient {
  if (
    settings.llmProvider === 'openai' &&
    settings.cloudApiUrl &&
    settings.cloudApiKey
  ) {
    return new OpenAIClient(settings.cloudApiUrl, settings.cloudApiKey);
  }
  // Local mode (llama-server router) — same port, model name in request body
  const port = settings.llamaServerPort || 8080;
  return new OpenAIClient(`http://127.0.0.1:${port}/v1`, '');
}

/**
 * Get the LLM model name for the API request.
 * For local mode: returns GGUF filename without extension (matches router auto-discovery).
 * For cloud mode: returns the configured cloud model name.
 */
export function getLLMModel(settings: AppSettings): string {
  if (settings.llmProvider === 'openai' && settings.cloudModel) {
    return settings.cloudModel;
  }
  if (settings.llmProvider === 'local') {
    const model = settings.localLlmModel || '';
    if (model) return toLocalModelApiName(model);
    const llmModel = settings.llmModel || 'qwen3.5:4b';
    return toLocalModelApiName(llmModel);
  }
  return settings.llmModel || 'qwen3.5:4b';
}

/**
 * Get the embedding model name for the API request.
 * For local mode: returns 'bge-m3-Q8_0' (must exist in models directory).
 */
export function getEmbedModel(settings: AppSettings): string {
  if (settings.llmProvider === 'openai') {
    return settings.cloudEmbedModel || settings.cloudModel || settings.embedModel || 'bge-m3';
  }
  if (settings.llmProvider === 'local') {
    const model = settings.localEmbedModel || '';
    if (model) return toLocalModelApiName(model);
    return toLocalModelApiName('bge-m3');
  }
  return settings.embedModel || 'bge-m3';
}

/**
 * Create an embedding client.
 * In router mode, uses the same port — model name routes to the correct model.
 */
export function createEmbedClient(settings: AppSettings): LLMClient {
  if (
    settings.llmProvider === 'openai' &&
    settings.cloudApiUrl &&
    settings.cloudApiKey
  ) {
    return new OpenAIClient(settings.cloudApiUrl, settings.cloudApiKey);
  }
  const port = settings.llamaServerPort || 8080;
  return new OpenAIClient(`http://127.0.0.1:${port}/v1`, '');
}
