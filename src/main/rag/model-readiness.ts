import fs from 'fs';
import path from 'path';
import type { AppSettings } from '../settings';
import { getLLMModelsDir } from '../paths';
import { getDownloadedGGUFModelIds } from '../llm/gguf-model-files';

export const RAG_MODEL_SETUP_MESSAGE =
  'AI 模型尚未配置完成。请前往「模型」页面，下载并选择本地模型，或配置云端 API、对话模型和嵌入模型后再试。';

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

function isCloudConfigured(settings: AppSettings): boolean {
  return Boolean(
    settings.cloudApiUrl &&
    settings.cloudApiKey &&
    settings.cloudModel &&
    settings.cloudEmbedModel,
  );
}

export function getRagModelSetupError(
  settings: AppSettings,
  options: ReadinessOptions = {},
): string | null {
  if (settings.llmProvider === 'openai') {
    return isCloudConfigured(settings) ? null : RAG_MODEL_SETUP_MESSAGE;
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

export function formatRagModelError(err: unknown): string {
  if (err instanceof RagModelConfigurationError) return err.message;

  const message = err instanceof Error ? err.message : String(err || '');
  const looksLikeModel404 =
    /\b404\b/.test(message) &&
    /(model|OpenAI (stream|generate|embed) failed|not found)/i.test(message);

  return looksLikeModel404 ? RAG_MODEL_SETUP_MESSAGE : (message || 'Unknown error');
}
