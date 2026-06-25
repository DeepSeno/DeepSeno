export const LOCAL_MODEL_TEST_TIMEOUT_MS = 120_000;

const MODEL_NAME_MAP: Record<string, string> = {
  'qwen3.5:4b': 'Qwen3.5-4B-Q4_K_M',
  'qwen3.5:9b': 'Qwen3.5-9B-Q4_K_M',
  'qwen3.5:27b': 'Qwen3.5-27B-Q4_K_M',
  'qwen3.5:35b': 'Qwen3.5-35B-A3B-Q4_K_M',
  'qwen3.5:122b': 'Qwen3.5-122B-A10B-Q4_K_M',
};

export function toLocalModelApiName(modelName: string): string {
  return MODEL_NAME_MAP[modelName] || modelName.replace(/\.gguf$/i, '');
}

export function shouldRestartLocalServerAfterTest(testedModel: string, selectedModel: string): boolean {
  return testedModel !== selectedModel;
}

export function getLocalModelTestButtonClass(modelName: string, recentlyTested: string | null, localTesting: boolean): string {
  const classes = ['kz-btn', 'kz-btn--sm'];

  if (recentlyTested === modelName && !localTesting) {
    classes.push('kz-btn--success');
  }

  if (localTesting) {
    classes.push('opacity-50');
  }

  return classes.join(' ');
}
