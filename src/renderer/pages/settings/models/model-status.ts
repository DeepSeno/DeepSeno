import type { LocalModelStatus } from './types';

export const QWEN_MODEL_IDS = [
  'qwen3.5:4b',
  'qwen3.5:9b',
  'qwen3.5:27b',
  'qwen3.5:35b',
];

const DEPRECATED_UI_MODEL_FALLBACKS: Record<string, string> = {
  'qwen3.5:122b': 'qwen3.5:35b',
};

function normalizeModelId(modelId: string): string {
  return modelId.endsWith(':latest') ? modelId.slice(0, -':latest'.length) : modelId;
}

export function toSelectableModelId(modelId: string): string {
  return DEPRECATED_UI_MODEL_FALLBACKS[normalizeModelId(modelId)] || modelId;
}

export function isModelInstalled(downloadedModels: string[], modelId: string): boolean {
  const expected = normalizeModelId(modelId);
  return downloadedModels.some((name) => normalizeModelId(name) === expected);
}

export function mergeInstalledModelStatuses(
  previous: Record<string, LocalModelStatus>,
  downloadedModels: string[],
  selectedModel: string,
): Record<string, LocalModelStatus> {
  const toCheck = new Set([...QWEN_MODEL_IDS, toSelectableModelId(selectedModel || 'qwen3.5:4b'), 'bge-m3']);
  const next = { ...previous };

  for (const model of toCheck) {
    if (next[model] === 'downloading' || next[model] === 'testing') {
      continue;
    }

    if (isModelInstalled(downloadedModels, model)) {
      next[model] = 'done';
    } else if (next[model] !== 'error') {
      next[model] = 'queued';
    }
  }

  return next;
}
