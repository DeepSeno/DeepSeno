import fs from 'fs';
import path from 'path';
import type { AppSettings } from '../settings';
import { getLLMModelsDir } from '../paths';
import { getDownloadedGGUFModelIds } from '../llm/gguf-model-files';
import { looksLikeModelNotFound } from '../llm/openai-client';

export const RAG_MODEL_SETUP_MESSAGE =
  'AI 模型尚未配置完成。请前往「模型」页面，下载并选择本地模型，或配置云端 API、对话模型后再试。';

export const RAG_LOCAL_SERVICE_MESSAGE =
  '本地 AI 模型服务未就绪。请前往「模型」页面确认对话模型已下载并启动，必要时重新启动模型服务后再试。';

export const RAG_CLOUD_SERVICE_MESSAGE =
  '云端 AI 服务连接失败。请检查 API 地址、密钥、模型名称和网络连接后再试。';

export class RagModelConfigurationError extends Error {
  constructor(message = RAG_MODEL_SETUP_MESSAGE) {
    super(message);
    this.name = 'RagModelConfigurationError';
  }
}

interface ReadinessOptions {
  downloadedLocalModelIds?: string[];
  localModelFileExists?: (modelName: string) => boolean;
}

function defaultDownloadedLocalModelIds(): string[] {
  const modelsDir = getLLMModelsDir();
  return getDownloadedGGUFModelIds((fileName) => {
    try {
      return fs.statSync(path.join(modelsDir, fileName)).size;
    } catch {
      return null;
    }
  });
}

function defaultLocalModelFileExists(modelName: string): boolean {
  const modelsDir = getLLMModelsDir();
  const base = modelName.replace(/\.gguf$/i, '');
  const basename = path.basename(base);
  const candidates = new Set([
    modelName,
    `${modelName}.gguf`,
    base,
    `${base}.gguf`,
    basename,
    `${basename}.gguf`,
  ]);

  for (const candidate of candidates) {
    const filePath = path.isAbsolute(candidate) ? candidate : path.join(modelsDir, candidate);
    try {
      if (fs.statSync(filePath).size > 0) return true;
    } catch {
      // Try next candidate.
    }
  }
  return false;
}

function isCloudChatConfigured(settings: AppSettings): boolean {
  return Boolean(
    settings.cloudApiUrl &&
    settings.cloudApiKey &&
    settings.cloudModel,
  );
}

export function getRagModelSetupError(
  settings: AppSettings,
  options: ReadinessOptions = {},
): string | null {
  if (settings.llmProvider === 'openai') {
    return isCloudChatConfigured(settings) ? null : RAG_MODEL_SETUP_MESSAGE;
  }

  const downloadedLocalModelIds = options.downloadedLocalModelIds ?? defaultDownloadedLocalModelIds();
  const localModelFileExists = options.localModelFileExists ?? defaultLocalModelFileExists;

  const selectedChatModel = settings.localLlmModel || settings.llmModel || 'qwen3.5:4b';
  const chatReady = settings.localLlmModel
    ? localModelFileExists(settings.localLlmModel)
    : downloadedLocalModelIds.includes(selectedChatModel) || localModelFileExists(selectedChatModel);

  const embedReady = settings.localEmbedModel
    ? localModelFileExists(settings.localEmbedModel)
    : downloadedLocalModelIds.includes('bge-m3') || localModelFileExists('bge-m3');

  return chatReady && embedReady ? null : RAG_MODEL_SETUP_MESSAGE;
}

export function assertRagModelConfigured(settings: AppSettings): void {
  const error = getRagModelSetupError(settings);
  if (error) {
    throw new RagModelConfigurationError(error);
  }
}

export function formatRagModelError(err: unknown, settings?: AppSettings): string {
  if (err instanceof RagModelConfigurationError) return err.message;

  const message = err instanceof Error ? err.message : String(err || '');
  const causeMessage =
    err instanceof Error && err.cause instanceof Error ? err.cause.message : '';
  const combined = `${message}\n${causeMessage}`.trim();
  const openAiHttpFailure = /\bOpenAI (stream|generate|embed|chat) failed:\s*(\d{3})/i.exec(combined);
  const looksLikeMissingModel =
    looksLikeModelNotFound(combined) ||
    /model\s+['"][^'"]+['"]\s+not found/i.test(combined) ||
    /not found[^{}]*(model|模型)/i.test(combined);
  const looksLikeServiceUnavailable =
    /(fetch failed|failed to fetch|econnrefused|econnreset|socket hang up|epipe|network|AbortError|aborted|timeout|timed out|llama-server did not become ready|did not become ready)/i
      .test(combined);

  if (looksLikeMissingModel) return RAG_MODEL_SETUP_MESSAGE;
  if (openAiHttpFailure?.[2] === '404') {
    return settings?.llmProvider === 'openai'
      ? RAG_CLOUD_SERVICE_MESSAGE
      : RAG_LOCAL_SERVICE_MESSAGE;
  }
  if (looksLikeServiceUnavailable) {
    return settings?.llmProvider === 'openai'
      ? RAG_CLOUD_SERVICE_MESSAGE
      : RAG_LOCAL_SERVICE_MESSAGE;
  }

  return message || 'Unknown error';
}
