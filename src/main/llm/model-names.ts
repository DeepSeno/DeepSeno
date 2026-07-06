/**
 * Local product model IDs are shown in the UI, while llama-server router
 * routes by GGUF basename. Keep this mapping in one place.
 */
export const LOCAL_MODEL_NAME_MAP: Record<string, string> = {
  'qwen3.5:4b': 'Qwen3.5-4B-Q4_K_M',
  'qwen3.5:9b': 'Qwen3.5-9B-Q4_K_M',
  'qwen3.5:27b': 'Qwen3.5-27B-Q4_K_M',
  'qwen3.5:35b': 'Qwen3.5-35B-A3B-Q4_K_M',
  'qwen3.5:122b': 'Qwen3.5-122B-A10B-Q4_K_M',
  'bge-m3': 'bge-m3-Q8_0',
};

export function normalizeLocalModelName(model: string): string {
  const trimmed = model.trim();
  const withoutLatest = trimmed.endsWith(':latest')
    ? trimmed.slice(0, -':latest'.length)
    : trimmed;
  const basename = withoutLatest.split(/[\\/]/).filter(Boolean).pop() || withoutLatest;
  return basename.replace(/\.gguf$/i, '');
}

export function toLocalModelApiName(model: string): string {
  const normalized = normalizeLocalModelName(model);
  return LOCAL_MODEL_NAME_MAP[normalized] || normalized;
}

export function toLocalModelApiNameSet(models: string[]): Set<string> {
  return new Set(models.map(toLocalModelApiName));
}
